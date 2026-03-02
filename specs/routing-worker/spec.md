# Routing Worker — Architectural Specification

> **Status**: v4 — Marketplace Fairness Model (Final)  
> **Phase**: 4 (Routing Worker)  
> **Depends on**: Layer 3 (routing_jobs, routing_waves), Routing Engine Spec v4

---

## 1. Worker Deployment Model

### Process Architecture

The routing worker runs as a **separate Node.js process**, completely decoupled from the Express API server.

```
┌──────────────────┐     ┌──────────────────┐
│  Express API     │     │  Routing Worker   │
│  (server.js)     │     │  (worker.js)      │
│                  │     │                   │
│  POST /broadcast │     │  Poll loop        │
│  → insert job    │     │  → claim job      │
│  → return 202    │     │  → execute waves  │
│                  │     │  → update state   │
└──────┬───────────┘     └──────┬────────────┘
       │                        │
       └────────┬───────────────┘
                │
         ┌──────▼──────┐
         │  PostgreSQL  │
         │  (Supabase)  │
         └─────────────┘
```

### Why Not In-Process

| Rejected Alternative | Reason |
|---------------------|--------|
| In-process `setInterval` | Crashes in the worker bring down the API. No horizontal scaling. |
| Message queue (Redis/RabbitMQ) | Adds infrastructure complexity. PostgreSQL advisory locks are sufficient for MVP. |
| Supabase Edge Functions | Vendor lock-in. No long-running process support. |

### Deployment Rules

- The worker **shares the same codebase** (`src/config/db.js`, `src/config/env.js`) but has its own entry point.
- The worker **must not import or depend on Express** or any HTTP framework.
- The worker **must be startable independently**: `node src/workers/routing-worker.js`.
- Multiple worker instances **may run concurrently** (see §3).
- The worker process **must exit cleanly on SIGTERM/SIGINT** (drain current job, then stop polling).

---

## 2. Polling Strategy

### Claim Pattern: `SELECT ... FOR UPDATE SKIP LOCKED`

The worker uses PostgreSQL row-level locking to claim jobs without contention:

```
Poll loop (every N seconds)
    │
    ▼
BEGIN TRANSACTION
    │
    ▼
SELECT * FROM routing_jobs
WHERE status = 'pending'
ORDER BY created_at ASC
LIMIT 1
FOR UPDATE SKIP LOCKED
    │
    ├─ No rows → COMMIT, sleep, retry
    │
    ├─ Row found → claim it:
    │   UPDATE routing_jobs
    │   SET status = 'active',
    │       started_at = now(),
    │       updated_at = now()
    │   WHERE id = <claimed_job_id>
    │
    ▼
COMMIT (claim committed)
    │
    ▼
Execute waves (separate transactions per wave)
    │
    ▼
Poll again
```

### Polling Configuration

| Parameter | Default | Source |
|-----------|---------|--------|
| `WORKER_POLL_INTERVAL_MS` | `3000` | Environment variable |
| `WORKER_HEARTBEAT_INTERVAL_MS` | `500` | Environment variable |
| `WORKER_STALE_JOB_THRESHOLD_SEC` | `600` | Environment variable |
| `WORKER_MAX_CONSECUTIVE_ERRORS` | `5` | Environment variable |

### Why `SKIP LOCKED`

- **No contention:** If Worker A is processing Job X, Worker B skips it and claims the next available job.
- **No deadlocks:** Workers never wait on each other.
- **No external coordination:** PostgreSQL handles all locking internally.

---

## 3. Concurrency Model

### Multi-Worker Safety

Multiple worker processes may run simultaneously. Safety is guaranteed by:

| Concern | Mechanism |
|---------|-----------|
| Job claiming | `FOR UPDATE SKIP LOCKED` ensures exactly one worker claims each job |
| Wave creation | `UNIQUE(job_id, wave_number)` prevents duplicate waves |
| Offer insertion | `UNIQUE(request_id, pharmacy_id)` prevents duplicate offers |
| State transitions | Conditional UPDATEs: `WHERE status = 'active'` (not blind overwrites) |

### Single-Job-Per-Worker Rule

Each worker processes **one job at a time**. It does not claim a second job until the current one reaches a terminal state. This keeps memory usage predictable and simplifies error handling.

### Scaling Model

- **MVP**: Single worker process.
- **Scale-out**: Launch N worker instances. Each independently polls and claims jobs. No shared state beyond PostgreSQL.

---

## 4. Transaction Boundaries

### Job Claim Transaction

```
BEGIN
  SELECT ... FOR UPDATE SKIP LOCKED  → claim the job
  UPDATE routing_jobs SET status = 'active'
COMMIT
```

Scope: Job status transition only. Kept minimal to release the lock quickly.

### Wave Execution Transaction (per wave)

```
BEGIN
  INSERT INTO routing_waves (job_id, wave_number, tier_id, ...)
    ON CONFLICT (job_id, wave_number) DO NOTHING

  -- Query eligible pharmacies (read-only, within same tx for consistency)
  SELECT ... FROM pharmacies WHERE zone_id = ... AND tier_id = ... AND is_active = true

  UPDATE routing_waves SET
    status = 'active',
    pharmacies_targeted = <count>,
    started_at = now(),
    expires_at = now() + interval '<window_duration_sec> seconds'
  WHERE id = <wave_id> AND status = 'pending'

  UPDATE routing_jobs SET current_wave = <wave_number>, updated_at = now()
  WHERE id = <job_id>
COMMIT
```

### Heartbeat During Wave Wait

During the wave window wait loop, the worker must periodically update `routing_jobs.updated_at` to signal liveness:

```
UPDATE routing_jobs SET updated_at = now()
WHERE id = <job_id> AND status = 'active'
```

This prevents other workers from mistakenly identifying the job as stale during long wave windows. The heartbeat interval is configurable via `WORKER_HEARTBEAT_INTERVAL_MS` (default 500ms).

Scope: One wave's setup. If this transaction fails, the wave was never created (or already exists via ON CONFLICT), and the worker can safely retry.

### Wave Completion Transaction

```
BEGIN
  -- Count offers received for this request during this wave window
  SELECT COUNT(*) FROM offers
    WHERE request_id = <request_id>
    AND created_at BETWEEN wave.started_at AND wave.expires_at

  UPDATE routing_waves SET
    status = 'completed',
    offers_received = <count>,
    completed_at = now()
  WHERE id = <wave_id> AND status = 'active'
COMMIT
```

### Job Completion Transaction

```
BEGIN
  UPDATE routing_jobs SET
    status = 'completed' (or 'expired'),
    completed_at = now(),
    updated_at = now()
  WHERE id = <job_id> AND status = 'active'

  UPDATE requests SET
    state = <new_state>,
    updated_at = now()
  WHERE id = <request_id>
COMMIT
```

### Transaction Isolation

All transactions use the default PostgreSQL isolation level (`READ COMMITTED`). No serializable isolation is required because:
- Job claiming uses explicit row locks (`FOR UPDATE`).
- Wave uniqueness is enforced by DB constraints.
- Offer uniqueness is enforced by DB constraints.

---

## 5. Escalation Logic

### Wave Execution Sequence

```
1. Query active tiers ordered by rank ASC
   → e.g., [Gold(1), Silver(2), Bronze(3)]

2. For each tier (in order):
   a. Check: has request.expires_at passed?
      → YES: mark job 'expired', stop
      → NO: continue

   b. Create wave (ON CONFLICT DO NOTHING)

   c. Query eligible pharmacies:
      Standard: WHERE zone_id = request.zone_id AND tier_id = <tier> AND is_active = true
      Rare:     WHERE supports_rare = true AND tier_id = <tier> AND is_active = true
      ORDER BY trust_score DESC

   d. If pharmacies_targeted = 0:
      → Mark wave 'skipped', continue to next tier immediately

   e. Mark wave 'active', set started_at and expires_at

   f. Wait for FULL window_duration_sec (NEVER terminate early):
      - Sleep in configurable intervals (WORKER_HEARTBEAT_INTERVAL_MS, default 500ms)
      - Each cycle: check request.expires_at, update routing_jobs.updated_at (heartbeat)
      - Even if a full coverage offer arrives early, the wave continues
      - This ensures fair competition within the tier

   g. Wave window elapsed:
      - Count offers received during window (informational snapshot for offers_received)
      - Mark wave 'completed'

   h. Check full coverage escalation stop (EXISTS, not COUNT):
      → SELECT EXISTS(
          SELECT 1 FROM offers
          WHERE request_id = <request_id>
          AND coverage_ratio = 100
        )
      → TRUE: mark job 'completed', update request state to 'fully_offered', STOP
      → FALSE: continue to next tier

3. All tiers exhausted:
   → Check if ANY offers exist (full or partial)
   → If partial offers exist: request.state = 'partially_offered'
   → If no offers exist: request.state = 'expired' (if TTL hit) or 'partially_offered'
   → Mark job 'completed'
```

> **No legacy “stop at ≥1 offer” logic.** Full coverage is the only escalation stop condition. Partial offers never halt escalation.

### Tier Configuration Source

At job start, the worker queries:

```
SELECT id, name, rank, window_duration_sec
FROM tiers
WHERE is_active = true
ORDER BY rank ASC
```

> **Note:** `window_duration_sec` must be added to the `tiers` table as a configurable column. This is a Layer 1 schema addition that should be proposed for review.

The column is `NOT NULL` with no ENV fallback. Every tier **must** have an explicit `window_duration_sec` value. This is an intentional routing policy coupling — wave timing is a tier-level governance decision, not a worker configuration detail. If a tier row exists without this value, the migration must reject it via `NOT NULL`.

### Full Coverage Check

The escalation stop check uses an `EXISTS` query targeting **full coverage offers only**:

```
SELECT EXISTS(
  SELECT 1 FROM offers
  WHERE request_id = <request_id>
  AND coverage_ratio = 100
) AS has_full_coverage
```

If `has_full_coverage = true`, escalation stops and the job completes with `request.state = 'fully_offered'`. `EXISTS` short-circuits after the first match.

> **Partial offers never stop escalation.** Only full coverage offers halt tier progression. This prevents a scenario where a single partial offer blocks better pharmacies in lower tiers from competing.

### Request State Determination

When routing completes (all tiers exhausted or full coverage found), the worker determines the request state:

```
1. SELECT EXISTS(SELECT 1 FROM offers WHERE request_id = ? AND coverage_ratio = 100.00)
   → TRUE: request.state = 'fully_offered'

2. SELECT EXISTS(SELECT 1 FROM offers WHERE request_id = ?)
   → TRUE: request.state = 'partially_offered'

3. Neither (0 offers): request.state = 'expired'
```

> **No ambiguity:** 0 offers always means `expired`. The `partially_offered` state requires at least one offer to exist.

### Expiry Check

Before each wave, and during the wait window, the worker checks:

```
SELECT expires_at FROM requests WHERE id = <request_id>
```

If `now() >= expires_at`, the job immediately transitions to `expired`.

---

## 6. Failure Handling

### Retry Policy

| Failure Type | Behavior |
|-------------|----------|
| DB connection error during poll | Log warning, sleep `WORKER_POLL_INTERVAL_MS`, retry |
| DB error during job claim | Log error, sleep, retry next poll cycle |
| DB error during wave execution | Rollback transaction, log error, mark job `failed` |
| Unhandled exception | Log error with stack trace, mark job `failed` if possible, continue polling |
| N consecutive errors | If `WORKER_MAX_CONSECUTIVE_ERRORS` reached, log critical alert, exit process with code 1 (let process manager restart) |

### Crash Recovery

If the worker crashes mid-execution:

1. The job remains in `status = 'active'` with a stale `updated_at`.
2. On restart (or from another worker), a **recovery sweep** runs:

```
SELECT * FROM routing_jobs
WHERE status = 'active'
AND updated_at < now() - interval '<WORKER_STALE_JOB_THRESHOLD_SEC> seconds'
FOR UPDATE SKIP LOCKED
```

3. Stale jobs are evaluated:
   - If the current wave has `status = 'active'` and `expires_at` has passed → mark wave `completed`, continue escalation.
   - If the current wave has `status = 'pending'` → re-execute from that wave.
   - If irrecoverable → mark job `failed`.

### Idempotent Re-Execution Rules

Every operation the worker performs must be safe to execute twice:

| Operation | Idempotency Guarantee |
|-----------|----------------------|
| Wave INSERT | `ON CONFLICT (job_id, wave_number) DO NOTHING` |
| Offer INSERT | `ON CONFLICT (request_id, pharmacy_id) DO NOTHING` |
| Job status → active | `WHERE status = 'pending'` guard (no-op if already active) |
| Wave status → active | `WHERE status = 'pending'` guard |
| Wave status → completed | `WHERE status = 'active'` guard |
| Job status → completed | `WHERE status = 'active'` guard |
| Pharmacy count | Recounted from query, not incremented |

---

## 7. Observability

### Structured Logging

All log entries must be structured JSON with consistent fields:

```json
{
  "level": "info",
  "component": "routing-worker",
  "job_id": "uuid",
  "request_id": "uuid",
  "event": "wave_started",
  "data": { ... },
  "timestamp": "ISO-8601"
}
```

### Events to Log

| Event | Level | Key Data |
|-------|-------|----------|
| Worker started | `info` | `worker_id`, `poll_interval`, `stale_threshold` |
| Worker stopped | `info` | `worker_id`, `reason` |
| Job claimed | `info` | `job_id`, `request_id`, `request_type`, `zone_id` |
| Wave started | `info` | `job_id`, `wave_number`, `tier_name`, `pharmacies_targeted`, `window_sec` |
| Wave skipped | `info` | `job_id`, `wave_number`, `tier_name`, `reason: 'no_pharmacies'` |
| Wave completed | `info` | `job_id`, `wave_number`, `offers_received`, `duration_ms` |
| Escalation triggered | `info` | `job_id`, `from_wave`, `to_wave`, `reason` |
| Full coverage reached | `info` | `job_id`, `total_full_coverage_offers`, `completed_at_wave` |
| No full coverage (escalating) | `info` | `job_id`, `wave_number`, `partial_offers_count` |
| Job completed | `info` | `job_id`, `final_status`, `total_waves`, `total_offers`, `duration_ms` |
| Job expired | `warn` | `job_id`, `request_id`, `expired_at`, `waves_completed` |
| Job failed | `error` | `job_id`, `error_message`, `failed_at_wave`, `stack` |
| Stale job recovered | `warn` | `job_id`, `stale_duration_sec`, `recovery_action` |
| Poll error | `error` | `error_message`, `consecutive_errors` |
| Worker exiting | `error` | `reason`, `consecutive_errors` |

### Health Signal

The worker must expose a simple health indicator (not HTTP — file-based or stdout):

- Write `updated_at` timestamp to a file on each successful poll cycle.
- A monitoring process can check if the file is stale.
- Alternatively, log a heartbeat event every N cycles.

---

## Schema Dependency: `tiers.window_duration_sec`

> [!IMPORTANT]
> The routing worker spec assumes that each tier has a configurable `window_duration_sec` column.
> This column does **not** exist in the current `tiers` table schema (Layer 1).
> 
> **Proposed addition to `tiers`:**
> ```
> window_duration_sec  INTEGER  NOT NULL  DEFAULT 300  CHECK(window_duration_sec > 0)
> ```
>
> This must be added via a new migration before worker implementation begins.
> The worker must snapshot this value into `routing_waves.window_duration_sec` at wave creation time.

### Schema Dependency: `offers.coverage_ratio`

> [!IMPORTANT]
> The marketplace fairness model requires a `coverage_ratio` column on the `offers` table.
> 
> **Proposed addition to `offers` (Layer 2 amendment):**
> ```
> coverage_ratio  NUMERIC(5,2)  NOT NULL  CHECK(coverage_ratio >= 0 AND coverage_ratio <= 100)
> ```
>
> Full coverage is strictly defined as `coverage_ratio = 100.00`.
> This must be added via a Layer 2 amendment migration before worker Phase 4B implementation.

### Why `window_duration_sec` Belongs in `tiers`

This is an **intentional routing policy coupling**. Wave timing is a tier-level governance decision:

- Gold pharmacies deserve a longer exclusive window (they earned it via trust).
- Bronze pharmacies get a shorter window (they are the fallback tier).
- Changing a tier's window duration changes marketplace behavior — this is a business decision, not a technical configuration.

Therefore:
- The value lives in the `tiers` table, NOT in environment variables or worker config.
- The column is `NOT NULL` — every tier must explicitly define its routing window.
- There is **no ENV fallback**. Hidden configuration would undermine governance transparency.
- The worker snapshots this value into `routing_waves.window_duration_sec` at wave creation for auditability.

---

## 8. Marketplace Exposure Policy

This section governs what the **client sees**, not what the worker does. The worker stores all offers; the API layer filters visibility.

### Offer Visibility Rules

| Rule | Value |
|------|-------|
| Default visible offers | 2 |
| Maximum visible offers | 3 |
| Show all offers | **Never** |

### Two-Level Ranking Model

**Level 1 — Coverage Classification:**
- If **full coverage** offers exist (`coverage_ratio = 100%`) → show only full coverage offers.
- If **no full coverage** offers exist → show partial offers.
- Never mix full and partial in the visible set.

**Level 2 — Composite Score (within coverage level):**

| Factor | Weight | Source |
|--------|--------|--------|
| `trust_score` | Primary | `pharmacies.trust_score` |
| `acceptance_rate` | Secondary | `pharmacies.acceptance_rate` |
| Response speed | Tertiary | Time between wave start and offer submission |

> **Price is NOT a ranking factor.** Price is visible to the client but never influences the ordering algorithm. This prevents a race to the bottom and maintains pharmacy trust incentives.

### Stored vs Visible

- All offers are **stored** in the `offers` table for audit, trust engine metrics, and analytics.
- Only the top 2–3 offers (per the ranking model) are **visible** to the client via the API.
- Offers beyond the top 3 are hidden but not deleted.

### Wave Fairness Rule

Even if a full coverage offer appears early in a wave:

1. **DO NOT** close the wave immediately.
2. **Allow** all remaining pharmacies in the same tier to submit offers until the window ends.
3. **Prevent** escalation to the next tier after wave completion if full coverage exists.

A pharmacy that submits a better offer 30 seconds before the window closes is treated equally to one that submitted immediately. This is the core marketplace fairness guarantee.

---

> **⛔ REVIEW GATE**
>
> This specification reflects the Marketplace Fairness Model (v4 — Final).
> No code, no implementation.
>
> Awaiting architectural review and explicit approval before writing any worker code.
