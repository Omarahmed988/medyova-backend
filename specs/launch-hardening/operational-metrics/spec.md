# Operational Metrics — Specification

> **Status**: v1 — Draft (Pending Architectural Review)  
> **Layer**: 10C (Launch Hardening — Observability)  
> **Depends on**: All data layers (requests, routing_jobs, orders, subscriptions)

---

## 1. Purpose

This specification defines the **minimum operational metrics** required for Zone-1 launch. These metrics provide visibility into platform health without external infrastructure. All data is sourced from DB queries executed on-demand. No Prometheus. No StatsD. No external APM.

---

## 2. Metric Definitions

### 2.1 Core Metrics

| # | Metric | Query Source | Update Frequency |
|---|--------|-------------|-----------------|
| 1 | **Active requests** | `requests WHERE state IN ('broadcasted', 'fully_offered', 'partially_offered')` | On-demand |
| 2 | **Routing jobs in progress** | `routing_jobs WHERE status = 'active'` | On-demand |
| 3 | **Orders pending confirmation** | `orders WHERE status = 'pending'` | On-demand |
| 4 | **Orders in delivery** | `orders WHERE status = 'out_for_delivery'` | On-demand |
| 5 | **Failed subscriptions (precheck)** | `subscriptions WHERE precheck_status = 'failed' AND is_active = true` | On-demand |
| 6 | **Stale routing jobs** | `routing_jobs WHERE status = 'active' AND updated_at < now() - interval '10 min'` | On-demand |

### 2.2 Extended Metrics (Zone-scoped)

| # | Metric | Query |
|---|--------|-------|
| 7 | **Requests by zone** | `GROUP BY zone_id` on active requests |
| 8 | **Active pharmacies per zone** | `pharmacies WHERE zone_id = $1 AND is_active = true AND is_blocked = false` |
| 9 | **Orders by status** | `GROUP BY status` on orders |
| 10 | **Subscription generation success rate** | `COUNT(last_request_id IS NOT NULL) / COUNT(*)` on active subscriptions |

---

## 3. API Endpoint

### 3.1 `GET /admin/metrics`

Returns all metrics in a single JSON response.

```json
{
  "timestamp": "2026-03-15T08:00:00Z",
  "zone_id": "optional-filter",
  "metrics": {
    "active_requests": 42,
    "routing_jobs_active": 3,
    "orders_pending": 12,
    "orders_in_delivery": 5,
    "subscriptions_precheck_failed": 2,
    "stale_routing_jobs": 0,
    "pharmacies_active": 15,
    "orders_by_status": {
      "pending": 12,
      "confirmed_by_pharmacy": 8,
      "preparing": 3,
      "out_for_delivery": 5,
      "delivered": 120,
      "completed": 95,
      "cancelled_by_user": 10,
      "cancelled_by_pharmacy": 4
    }
  }
}
```

### 3.2 Authentication

Admin-level JWT required. Same `requireAdmin` middleware as admin control layer.

### 3.3 Query Parameter

| Param | Type | Effect |
|-------|------|--------|
| `zone_id` | UUID (optional) | Filter metrics to specific zone |

---

## 4. SQL Queries

### 4.1 Active Requests

```sql
SELECT COUNT(*) AS active_requests
FROM requests
WHERE state IN ('broadcasted', 'fully_offered', 'partially_offered')
  AND ($1::uuid IS NULL OR zone_id = $1);
```

### 4.2 Routing Jobs Active

```sql
SELECT COUNT(*) AS routing_jobs_active
FROM routing_jobs
WHERE status = 'active';
```

### 4.3 Orders Pending Confirmation

```sql
SELECT COUNT(*) AS orders_pending
FROM orders
WHERE status = 'pending'
  AND ($1::uuid IS NULL OR zone_id IS NOT NULL);
```

### 4.4 Orders in Delivery

```sql
SELECT COUNT(*) AS orders_in_delivery
FROM orders o
JOIN requests r ON r.id = o.request_id
WHERE o.status = 'out_for_delivery'
  AND ($1::uuid IS NULL OR r.zone_id = $1);
```

### 4.5 Stale Routing Jobs

```sql
SELECT COUNT(*) AS stale_jobs
FROM routing_jobs
WHERE status = 'active'
  AND updated_at < now() - interval '10 minutes';
```

### 4.6 Failed Subscription Pre-checks

```sql
SELECT COUNT(*) AS precheck_failed
FROM subscriptions
WHERE precheck_status = 'failed'
  AND is_active = true;
```

### 4.7 Orders by Status

```sql
SELECT status, COUNT(*) AS count
FROM orders
GROUP BY status;
```

---

## 5. Index Requirements

| Query | Required Index | Exists? |
|-------|---------------|:---:|
| Active requests by state | `idx_requests_state` (state) | ⚠️ Check — may need to add |
| Routing jobs by status | `idx_routing_jobs_status` | ✅ Exists |
| Orders by status | `idx_orders_status` | ✅ Exists |
| Stale jobs by updated_at | `idx_routing_jobs_status` + `updated_at` | ⚠️ May add composite |
| Subscriptions precheck | `idx_subscriptions_precheck_status` | ⚠️ May add partial |

### New Indexes (if needed)

```sql
CREATE INDEX idx_requests_state ON requests (state);
CREATE INDEX idx_routing_jobs_stale ON routing_jobs (status, updated_at)
  WHERE status = 'active';
```

---

## 6. Performance Ceiling

### At 10k Orders

| Query | Expected Rows Scanned | Index? | Time |
|-------|:---:|:---:|:---:|
| Active requests | ~100 (filtered by state) | ✅ | < 5ms |
| Routing jobs active | ~5-10 | ✅ | < 1ms |
| Orders pending | ~50 | ✅ | < 2ms |
| Stale jobs | ~0-2 | ✅ | < 1ms |
| Orders by status | Full GROUP BY (~10k) | ✅ | < 20ms |

**Total endpoint response time: < 50ms at 10k orders.**

### At 100k Orders

GROUP BY queries may reach ~100ms. Consider materialized view or caching at that scale. Not needed for Zone-1 MVP.

---

## 7. Concurrency

- All queries are read-only SELECTs — no locking
- No conflict with routing/acceptance/order transactions
- Metrics endpoint can be called concurrently without contention
- No caching layer — each call reads current state

## 8. Transaction Boundaries

- Single autocommit query per metric (or batch in one round-trip)
- No BEGIN/COMMIT required
- No write operations

## 9. Legal Boundary

- Metrics expose aggregate counts only — no PII
- No prescription details, no user names, no phone numbers
- Admin authentication required — not publicly accessible

---

## 10. Invariants

| ID | Invariant | Enforcement |
|----|-----------|-------------|
| **OM-1** | Metrics are read-only | Application: only SELECT queries |
| **OM-2** | Metrics require admin auth | Middleware: `requireAdmin` |
| **OM-3** | No external infrastructure dependency | DB queries only |

---

## 11. Explicit Non-Goals

| Non-Goal | Reason |
|----------|--------|
| Prometheus/Grafana integration | Out of scope for MVP |
| Time-series storage | Not needed at Zone-1 scale |
| Alerting | Manual monitoring for MVP |
| Historical metrics | Use audit logs for historical data |
| Real-time websocket updates | REST polling is sufficient |

---

## 12. Implementation Impact

### New Files

| File | Description |
|------|-------------|
| `src/services/metricsService.js` | Metric query execution |
| `src/routes/admin.js` | `GET /admin/metrics` endpoint (added to admin routes) |
| Migration | Possible new indexes |

### Unmodified Files

All existing services, workers, and routes remain unchanged.
