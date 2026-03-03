# Deployment Architecture — Specification (Zone-1 Strategy)

> **Status**: v1 — Draft (Pending Architectural Review)  
> **Layer**: 10E (Launch Hardening — Infrastructure)  
> **Depends on**: All application layers + hardening specs 10A–10D

---

## 1. Purpose

This specification defines the **Zone-1 deployment model** for Medyova's MVP production launch. The architecture is intentionally minimal — one zone, one instance, one database — to reduce operational surface area while maintaining correctness guarantees. Horizontal scaling capability is preserved by design but not exercised.

---

## 2. Infrastructure Topology

### 2.1 Zone-1 Configuration

```
                    ┌─────────────────────┐
                    │   Load Balancer /    │
                    │   Reverse Proxy      │
                    │   (Nginx / Cloud)    │
                    └──────────┬──────────┘
                               │
              ┌────────────────┼────────────────┐
              │                │                │
     ┌────────▼────────┐ ┌────▼────┐ ┌─────────▼─────────┐
     │  Backend API     │ │ Routing │ │ Sweep Workers     │
     │  (Express.js)    │ │ Worker  │ │ (SLA + Sub)       │
     │  Port 3000       │ │ Process │ │ Processes          │
     └────────┬────────┘ └────┬────┘ └─────────┬─────────┘
              │               │                │
              └───────────────┼────────────────┘
                              │
                    ┌─────────▼─────────┐
                    │   PostgreSQL 15+   │
                    │   Single Instance  │
                    └───────────────────┘
```

### 2.2 Process Inventory

| Process | Count | Role | Scaling Model |
|---------|:---:|------|------|
| Backend API | 1 | HTTP request handling, admin APIs, metrics | Horizontal (add instances) |
| Routing Worker | 1 | Job claiming, wave execution, escalation | Horizontal (`SKIP LOCKED` safe) |
| Order SLA Sweep | 1 | Pharmacy confirmation timeout auto-cancel | Horizontal (`SKIP LOCKED` safe) |
| Subscription Sweep | 1 | Pre-check + request generation | Horizontal (`SKIP LOCKED` safe) |
| PostgreSQL | 1 | Single source of truth | Vertical (for MVP) |

---

## 3. Worker Scaling Strategy

### 3.1 Single Worker Initially

For Zone-1 MVP, **one instance of each worker** is sufficient:

| Worker | Expected Load | Single Instance Capacity |
|--------|:---:|:---:|
| Routing Worker | ~50 jobs/day | ~500 jobs/day (30s avg per job) |
| SLA Sweep | ~10 cancellations/day | ~1000/day (60s poll interval) |
| Subscription Sweep | ~20 generations/day | ~500/day (120s poll interval) |

### 3.2 Horizontal Scaling Readiness

All workers are designed for horizontal scaling from day one:

| Feature | Status | Evidence |
|---------|:---:|---|
| `FOR UPDATE SKIP LOCKED` | ✅ | All job/subscription claims use skip locked |
| Idempotent operations | ✅ | Subscription guard, wave idempotency |
| No in-memory shared state | ✅ | All state in PostgreSQL |
| No process affinity | ✅ | Any worker instance can process any job |
| No distributed coordination | ✅ | PostgreSQL row locks provide coordination |

**To scale**: Deploy N instances of the same worker process. No configuration change needed. PostgreSQL row-level locks ensure no duplicate processing.

---

## 4. Failure Model

### 4.1 Worker Crash

| Scenario | Recovery Mechanism | Data Risk |
|----------|-------------------|:---:|
| Routing worker crash mid-wave | Stale job recovery: existing code detects `updated_at < threshold` and reclaims | ❌ None |
| Routing worker crash mid-transaction | PostgreSQL auto-rollback. Job remains `active`. Stale recovery reclaims. | ❌ None |
| SLA sweep crash | Next poll cycle processes pending orders normally | ❌ None |
| Subscription sweep crash | Next poll cycle retries. Idempotency guard prevents duplicates. | ❌ None |
| API process crash | Reverse proxy returns 502. Client retries. No server-side state affected. | ❌ None |

### 4.2 Database Restart

| Phase | Behavior |
|-------|----------|
| DB going down | All processes receive connection errors. Workers retry on next poll. API returns 503. |
| DB coming up | Workers reconnect via pool. API reconnects on next request. |
| Recovery | No data loss (WAL-based recovery). All transactions either committed or rolled back. |

**Critical**: Pool configuration must include `connectionTimeoutMillis` and retry logic. Existing `pg.Pool` handles reconnection automatically.

### 4.3 Graceful Shutdown

| Process | Shutdown Behavior |
|---------|------------------|
| Routing Worker | Sets `running = false`. Current wave completes (or times out). Process exits. Job becomes stale → reclaimed. |
| SLA Sweep | Clears timeout. Current iteration completes. Process exits. |
| Subscription Sweep | Clears timeout. Current iteration completes. Process exits. |
| API Server | `server.close()` — stops accepting new connections. Existing requests complete. |

**Signal handling**: `SIGTERM` triggers graceful shutdown. `SIGKILL` forces immediate termination — worker state is safely recoverable via stale detection.

Existing routing worker signal handling:
```javascript
process.on('SIGTERM', () => { running = false; });
process.on('SIGINT', () => { running = false; });
```

---

## 5. Upgrade Strategy

### 5.1 Zero-Downtime Migrations

| Migration Type | Downtime Required? | Strategy |
|----------------|:---:|---|
| Add column (nullable) | ❌ | `ALTER TABLE ADD COLUMN` — metadata-only in PostgreSQL |
| Add column (NOT NULL + DEFAULT) | ❌ | PostgreSQL writes default lazily — no table rewrite |
| Add index | ❌ | `CREATE INDEX CONCURRENTLY` — no lock |
| Add table | ❌ | No locking on new tables |
| Drop column | ⚠️ | Deploy code that doesn't reference column FIRST, then drop |
| Rename column | ⚠️ | Deploy code that handles both names, then rename, then clean up |
| Add NOT NULL constraint | ⚠️ | Validate existing data first, then add constraint |

### 5.2 Migration Execution Protocol

```
1. Backup database (pg_dump)
2. Run migration: npx node-pg-migrate up
3. Verify migration success (check new tables/columns)
4. Deploy new code (API + workers)
5. Verify health endpoint returns 200
6. Monitor logs for 5 minutes
7. If issues: rollback code, then npx node-pg-migrate down
```

### 5.3 Worker Restart Protocol

```
1. Send SIGTERM to worker process
2. Wait for graceful shutdown (max 60s)
3. If still running after 60s: SIGKILL
4. Start new worker process
5. Verify worker logs show "polling started"
6. Stale jobs (if any) are auto-reclaimed within 10 minutes
```

### 5.4 API Restart Protocol (Zero-Downtime)

With a reverse proxy:
```
1. Start new API instance on alternate port
2. Health check new instance
3. Switch proxy upstream to new instance
4. Send SIGTERM to old instance
5. Old instance finishes in-flight requests, then exits
```

Without proxy (acceptable for Zone-1 MVP):
```
1. Send SIGTERM to API
2. Restart immediately
3. Downtime: ~2-5 seconds
```

---

## 6. Monitoring Strategy

### 6.1 Log-Based Only (No External APM)

| What | How | Where |
|------|-----|-------|
| Worker activity | Structured JSON logs (`console.log`) | stdout → log aggregator |
| Errors | Structured JSON logs (`console.error`) | stderr → log aggregator |
| Request latency | Express morgan middleware | stdout |
| Stale job alerts | `/admin/metrics` endpoint (manual check) | Admin API |
| Health status | `GET /health` | Load balancer health check |

### 6.2 Log Format (Already Implemented)

```json
{
  "level": "info",
  "component": "routing-worker",
  "event": "job_claimed",
  "job_id": "uuid",
  "timestamp": "2026-03-15T08:00:00Z"
}
```

### 6.3 Key Log Events to Monitor

| Event | Severity | Action |
|-------|----------|--------|
| `stale_job_reclaimed` | ⚠️ Warning | May indicate worker crash — investigate |
| `wave_creation_failed` | ❌ Error | Database issue — investigate immediately |
| `generation_error` | ❌ Error | Subscription generation failed — check DB |
| `insurance_guard_skip` | ℹ️ Info | Expected for deactivated profiles |
| `sla_auto_cancel` | ℹ️ Info | Normal SLA enforcement |

### 6.4 Manual Health Checks

| Check | Frequency | Method |
|-------|-----------|--------|
| API health | Continuous | `GET /health` (load balancer) |
| Stale jobs | Every 30 minutes | `GET /admin/metrics` |
| Order backlog | Every hour | `GET /admin/metrics` |
| Worker alive | Continuous | Process manager (PM2/systemd) |

---

## 7. Infrastructure Assumptions

| Assumption | Value | Scale Limit |
|------------|-------|-------------|
| Backend instances | 1 | ~1000 concurrent users |
| Worker processes | 1 each (3 total) | ~500 jobs/day |
| Database | 1 (PostgreSQL 15+) | ~1M rows before tuning |
| Connection pool | 10 connections per process | 40 total (4 processes × 10) |
| Disk | 10GB minimum | Sufficient for 100k orders |
| Memory | 512MB per process | 2GB total |

---

## 8. Concurrency

- All concurrency is managed through PostgreSQL row-level locks
- No application-level distributed locks
- No Redis, no message queues, no external coordination
- `FOR UPDATE SKIP LOCKED` enables safe multi-instance deployment without configuration

## 9. Transaction Boundaries

- No new transaction boundaries introduced by deployment architecture
- All existing transaction patterns (routing, acceptance, orders, subscriptions) are deployment-agnostic
- Connection pooling handles transaction isolation per-connection

## 10. Performance

- Single PostgreSQL instance handles Zone-1 load with margin
- Connection pool of 40 total connections is sufficient for 4 processes
- No query optimization needed at Zone-1 scale (< 10k orders)
- All critical queries are indexed

## 11. Legal Boundary

- Log aggregation must comply with data retention policies
- No PII in structured logs (UUIDs only, no names/phones)
- Database backups must be encrypted at rest
- Access to production database restricted to authorized personnel

---

## 12. Invariants

| ID | Invariant | Enforcement |
|----|-----------|-------------|
| **DA-1** | Worker crash cannot cause data loss | PostgreSQL ACID + stale recovery |
| **DA-2** | Multiple worker instances are safe | `FOR UPDATE SKIP LOCKED` |
| **DA-3** | Migration rollback is always possible | `exports.down` in all migrations |
| **DA-4** | API restart causes < 10s downtime | Graceful shutdown + quick startup |
| **DA-5** | No external infrastructure dependency | PostgreSQL + Node.js only |

---

## 13. Explicit Non-Goals

| Non-Goal | Reason |
|----------|--------|
| Kubernetes/Docker orchestration | Single-server deployment for MVP |
| External message queue (RabbitMQ/SQS) | PostgreSQL provides all coordination |
| Redis caching | Not needed at Zone-1 scale |
| CDN | No static assets served by API |
| Multi-region deployment | Single zone = single region |
| Auto-scaling | Manual scaling for MVP |
| External APM (Datadog/New Relic) | Log-based monitoring sufficient |

---

## 14. Implementation Impact

### New Files

| File | Description |
|------|-------------|
| `ecosystem.config.js` | PM2 process definition (API + workers) |
| `.env.production.example` | Production environment template |

### Modified Files

| File | Change |
|------|--------|
| `src/workers/routing-worker.js` | Verify SIGTERM handling exists (already implemented) |

### No Application Code Changes

This spec is infrastructure-only. All patterns (SKIP LOCKED, stale recovery, graceful shutdown) are already implemented in application code.
