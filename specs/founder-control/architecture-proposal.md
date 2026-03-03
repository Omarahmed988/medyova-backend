# Phase 11 — Founder Control & Feature Governance Layer
# Architecture Proposal v2

> **Status**: v2 — Design Gate (Corrections Applied, Awaiting Final Approval)
> **Level**: CTO Architectural Review
> **Date**: 2026-03-03
> **Preceding version**: v1 (submitted 2026-03-03)

---

## Executive Summary

This v2 proposal incorporates four mandatory architectural refinements requested after the v1 review:

1. **Deterministic cache invalidation** — PostgreSQL `LISTEN/NOTIFY` replaces TTL-only refresh
2. **Strict `scope_id` validation** — application-layer enforcement without DB FKs
3. **Commission = 0% allowed** — with cap, audit, and reversibility guarantee
4. **Subscription engine OFF model** — evaluated, decision made (Hard Stop, Option A)

Core invariants (routing escalation, acceptance transaction, order state machine, JWT secret, atomicity guarantees) remain permanently non-configurable by design.

---

## A. Schema Design

### A.1 `system_settings` Table

```sql
CREATE TABLE system_settings (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    key          VARCHAR(100) NOT NULL UNIQUE,
    value        TEXT NOT NULL,
    type         VARCHAR(20) NOT NULL CHECK (type IN ('decimal', 'integer', 'boolean', 'string')),
    min_val      TEXT NULLABLE,      -- NULL = no lower bound (commission intentionally has no min)
    max_val      TEXT NULLABLE,      -- Hard upper cap enforced at write time
    description  TEXT NOT NULL,
    is_locked    BOOLEAN NOT NULL DEFAULT false,
    updated_by   UUID NULLABLE,      -- actor_id from last admin write
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

**Seeded values at migration time:**

| key | type | value | min_val | max_val | Notes |
|-----|------|-------|:---:|:---:|-------|
| `commission_rate_percent` | decimal | `10.00` | **NULL** | `30.00` | 0% explicitly allowed (rare medicine use case) |
| `pharmacy_confirm_timeout_sec` | integer | `900` | `60` | `7200` | SLA auto-cancel |
| `subscription_precheck_offset_days` | integer | `2` | `1` | `14` | Pre-check window |
| `routing_stale_job_threshold_sec` | integer | `600` | `120` | `3600` | Stale job detection |
| `max_active_requests_per_user` | integer | `5` | `1` | `20` | Abuse limit |
| `max_active_subscriptions_per_user` | integer | `10` | `1` | `50` | Abuse limit |

> [!CAUTION]
> `routing_wave_window_sec` is NOT in system_settings. Wave windows are per-tier in the `tiers` table and are not globally configurable in v1. Modifying them incorrectly would break escalation invariants. Deferred to v2 with explicit guards.

### A.2 `feature_flags` Table

```sql
CREATE TABLE feature_flags (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    key         VARCHAR(100) NOT NULL,
    scope       VARCHAR(20) NOT NULL CHECK (scope IN ('global', 'zone')),
    scope_id    UUID NULLABLE,          -- NULL for global; validated zone UUID for zone scope
    is_enabled  BOOLEAN NOT NULL DEFAULT true,
    description TEXT NOT NULL,
    updated_by  UUID NULLABLE,
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE(key, scope, scope_id)
);
```

**Seeded flags:**

| key | scope | default | Description |
|-----|-------|:---:|-------------|
| `insurance_routing_enabled` | global | `true` | Activates insurance JOIN in routing |
| `subscription_engine_enabled` | global | `true` | Sweep generates subscription requests |
| `rare_medicine_routing_enabled` | global | `true` | Enables rare-type routing path |
| `offer_visibility_enabled` | global | `true` | Safety kill-switch for offer display |
| `pharmacy_registration_open` | global | `false` | Pharmacy self-onboarding |

---

## B. Cache Refresh — Deterministic Invalidation

### B.1 Problem

Medyova is a **multi-process architecture**: one API process + three independent workers (`routing-worker`, `order-sla-sweep`, `subscription-sweep`). Each is a separate Node.js process with its own heap. A 60-second TTL in the API process does not propagate to any worker.

**Requirement**: Changes must propagate deterministically to all processes immediately after a PATCH, without requiring worker restarts.

### B.2 Solution: PostgreSQL `LISTEN / NOTIFY`

PostgreSQL's built-in pub/sub mechanism provides real-time, cross-process notification with no external infrastructure.

**Write path (API — admin PATCH handler):**
```javascript
// After UPDATE system_settings SET value = $1 WHERE key = $2
await client.query(`NOTIFY config_changed, 'system_settings:commission_rate_percent'`);
```

**Read path (`settingsCache.js` — all processes on startup):**
```javascript
// Each process (API, routing-worker, sla-sweep, subscription-sweep) runs:
notifyClient.query('LISTEN config_changed');
notifyClient.on('notification', async (msg) => {
    // Immediate DB re-read on notification receipt — no TTL wait
    await settingsCache.refresh();
});
```

**TTL background refresh (safety net)**: 60-second `setInterval` refresh remains as a safety net only, guarding against rare missed notifications (e.g., transient connection drops). It is not the primary invalidation mechanism.

### B.3 Propagation Guarantee

| Process | Notification Received | Time to Propagate |
|---------|-----------------------|:-----------------:|
| API server | Via own `notifyClient` | < 50ms |
| routing-worker | Via own `notifyClient` | < 50ms |
| order-sla-sweep | Via own `notifyClient` | < 50ms |
| subscription-sweep | Via own `notifyClient` | < 50ms |

**Deterministic behavior**: After a PATCH succeeds (HTTP 200), all processes will have refreshed their cache within < 50ms (PG NOTIFY round-trip). This is not eventual consistency — it is event-driven push.

### B.4 Single Non-Blocking Connection Per Process

Each process maintains **one dedicated PostgreSQL connection** for `LISTEN` (separate from the pg.Pool). This connection is long-lived but idle — zero query load. If it drops, the 60s TTL background refresh is the fallback.

---

## C. `scope_id` Validation Layer

### C.1 Policy

No database Foreign Key is used — by design — because `scope_id` references multiple entity types polymorphically. However, the application layer enforces equivalent integrity:

| Scope | scope_id Rule | Validation |
|-------|--------------|------------|
| `global` | MUST be `NULL` | If non-null received → `400 Bad Request` |
| `zone` | MUST be a valid, existing `zones.id` | `SELECT id FROM zones WHERE id = $1` — if 0 rows → `400 Bad Request` |

### C.2 Invariant

> **FC-1**: No orphan scope references allowed. The write layer guarantees `scope_id` always resolves to a real, existing entity of the correct type.

### C.3 Validation Tests Required

- `PATCH /admin/flags` with `scope=global` + `scope_id=<any UUID>` → 400
- `PATCH /admin/flags` with `scope=zone` + `scope_id=<non-existent UUID>` → 400
- `PATCH /admin/flags` with `scope=zone` + valid `scope_id` → 200 + cache refresh
- `PATCH /admin/flags` with `scope=global` + `scope_id=null` → 200

---

## D. Commission = 0% (Allowed with Guardrails)

### D.1 Business Rationale

Rare medicine orders may require 0% commission to incentivize pharmacy participation. Blocking 0% would prevent Medyova from supporting this population of patients.

### D.2 Rules

| Rule | Value |
|------|-------|
| Minimum | **None** (0% is explicitly allowed) |
| Maximum | `30.00%` hard cap (enforced at write time with 400 error) |
| Type | Decimal — stored as `'0.00'` to `'30.00'` TEXT, parsed at read time |
| Audit required | ✅ Every mutation must audit `previous_value → new_value` |
| Write requires | `super_admin` JWT |
| Reversibility | Instant — PATCH back to any valid value |

### D.3 Audit Metadata

Every commission change must produce an audit log entry with:

```json
{
  "entity_type": "system_setting",
  "entity_id": "<system_settings.id for commission key>",
  "action": "setting.commission_rate_changed",
  "actor_type": "admin",
  "actor_id": "<super_admin user_id>",
  "metadata": {
    "key": "commission_rate_percent",
    "previous_value": "10.00",
    "new_value": "0.00"
  }
}
```

### D.4 Invariant

> **FC-2**: Commission change must be auditable, capped, and reversible. A commission change at time T does not affect orders accepted before T — their `commission_amount` is stored at acceptance time and is immutable.

---

## E. Subscription Engine OFF Behavior — Decision

### E.1 Background

The `subscription_engine_enabled` feature flag can be set to `false` by a `super_admin`. When `false`, the `subscription-sweep` process must determine what to do with subscriptions whose `next_run_at` has passed.

### E.2 Option A — Hard Stop (Cycle Skipped)

**Behavior**: Sweep runs, observes flag is `false`. For any subscription where `next_run_at <= now()`:
- Advance `next_run_at` to the next computed cycle (e.g., +1 month)
- Update `last_run_at = now()`
- Do NOT generate a request
- Log: `subscription.skipped_disabled`

**Impact on fields:**
- `next_run_at`: Always stays in the future. Math remains clean.
- `last_run_at`: Updated to acknowledge the skipped cycle.
- `last_request_id`: Unchanged — refers to last actual request.

**Re-enable impact**: Zero load spike. The cycle already advanced. Normal sweep cadence resumes.

### E.3 Option B — Soft Pause (Cycles Queued on Re-enable)

**Behavior**: Sweep observes flag is `false` and does nothing — neither generates requests nor advances dates.

**Impact on fields:**
- `next_run_at`: Accumulates past-due timestamps in the DB.
- `last_run_at`: Stale.
- Re-enable impact: **Thundering herd**. Every subscription that was paused fires simultaneously, potentially generating hundreds/thousands of requests at once. This saturates the routing system.

### E.4 Decision: **Option A — Hard Stop**

**Rationale**:
1. **Medical safety**: Medyova manages chronic prescriptions. If the system is disabled for even one cycle, patients have sourced medication locally. Retroactively generating an order for medicine already acquired creates a dangerous dual-supply scenario.
2. **Routing safety**: A thundering herd from Option B would saturate the routing worker and routing_jobs table, violating Zone-1 capacity guarantees.
3. **Mathematical cleanliness**: Option A keeps `next_run_at` perpetually in the future, avoiding date arithmetic edge cases.
4. **Operational reversibility**: Option A is fully reversible — founders re-enable and the next legitimate cycle triggers normally.

> **FC-3**: When `subscription_engine_enabled = false`, the sweep advances `next_run_at` without creating requests. Missed cycles are intentionally and permanently skipped.

---

## F. Risk Matrix

### F.1 Operational Risk

| Change | Risk | Severity | Guard |
|--------|------|:---:|-------|
| Commission → 0% | Revenue elimination | 🟠 High | `super_admin` only, mandatory audit log |
| Commission → 30% | Pharmacy margin destruction | 🔴 Critical | `max_val = 30.00` hard cap at write |
| SLA timeout → 60s | Rapid auto-cancel flood | 🟠 High | `min_val = 60` |
| Disable subscription engine | Chronic patients miss monthly cycle | 🟠 High | Hard Stop (no thundering herd on re-enable) |
| Disable insurance routing | Insured users hit unfiltered routing | 🟡 Medium | Pharmacy is final eligibility gate |
| Disable rare routing | Rare requests get zero offers | 🔴 Critical | Fail-closed; request remains open but unserviced |
| Zone maintenance mode | All new requests rejected in zone | 🔴 Critical | Check metrics before enabling |

### F.2 Legal Risk

| Change | Risk | Severity | Notes |
|--------|------|:---:|-------|
| Commission mid-cycle | Orders before change use old rate | ❌ None | `commission_amount` stored at acceptance |
| Insurance routing off | Users might get unfiltered routing | 🟡 Medium | Pharmacies validate eligibility independently |
| Pharmacy block | No contractual mechanism | 🟡 Medium | Operational only; contracts are separate |

### F.3 Supply-Side Risk

| Change | Risk | Severity | Guard |
|--------|------|:---:|-------|
| Deactivate key pharmacy | Coverage gap in zone | 🟠 High | Check `GET /admin/metrics?zone_id=` first |
| Zone maintenance mode | All active requests freeze | 🔴 Critical | In-flight jobs complete; new users rejected |

---

## G. Mandatory Invariants Summary

| ID | Invariant |
|----|-----------|
| **FC-1** | No orphan scope references allowed (validated at write layer) |
| **FC-2** | Commission changes are auditable, capped, and reversible |
| **FC-3** | Subscription engine off = permanent hard stop per cycle |
| **FC-4** | Config changes NEVER alter transaction boundaries |
| **FC-5** | Config changes NEVER alter routing escalation semantics or tier precedence |
| **FC-6** | Feature flags wrap entire feature blocks — no partial execution |
| **FC-7** | Any disabled feature defaults to fail-closed (safe state) |
| **FC-8** | All PATCH routes require `super_admin` JWT, produce audit log, and are rate-limited |

---

## H. Concurrency Impact Statement

| Concern | Assessment |
|---------|-----------|
| Parallel setting updates | Extremely rare. Last-write-wins is acceptable for config values. If needed, `updated_at` can serve as an optimistic lock. |
| Cache refresh mid-request | Harmless. `settingsCache.getSetting()` returns the current cached value. Commission read at acceptance time is atomic. |
| Worker reads stale cache | TTL (60s) + NOTIFY (<50ms) provides dual-layer freshness guarantee. Staleness window is bounded. |
| LISTEN connection drops | Background TTL refresh (60s) acts as fallback. PG reconnects automatically via pool retry. |
| Multiple writers simultaneously | Application-level 429 rate limit on admin PATCH prevents rapid concurrent mutations. |

---

## I. Operational Guardrails

| Procedure | Protocol |
|-----------|---------|
| **Max commission change frequency** | Recommended ≤ once per billing period. No technical limit, but audit logs enable review. |
| **Feature toggle rollback** | Instant — PATCH back to previous value; NOTIFY propagates to all processes in <50ms. |
| **Safe zone maintenance** | Confirm `stale_routing_jobs = 0` + `routing_jobs_active = 0` in metrics before enabling maintenance mode. |
| **Emergency insurance disable** | PATCH `insurance_routing_enabled = false`. All subsequent routing jobs use standard (non-insured) path. In-flight insured waves complete using the active `job.insurance_profile_id` value cached in the job row. |
| **Emergency subscription disable** | PATCH `subscription_engine_enabled = false`. Running subscriptions already started their current cycle; only future cycles are affected. |

---

## J. Implementation Order (Locked — Post Approval Only)

| Step | Deliverable |
|:---:|------------|
| 1 | Migration: `system_settings` + `feature_flags` tables + seeds |
| 2 | `src/config/settingsCache.js` — LISTEN/NOTIFY + TTL fallback |
| 3 | `src/services/settingsService.js` — CRUD + scope validation |
| 4 | Admin PATCH routes with `super_admin` guard + audit integration |
| 5 | Controlled integration: `offerAcceptance` (commission), `routing-worker` (flags), `subscription-sweep` (flag), `order-sla-sweep` (SLA timeout) |
| 6 | Full regression suite — must remain at 103+ passing tests |

---

## K. Permanently Non-Configurable Boundaries

| Value | Reason for immutability |
|-------|------------------------|
| Routing tier rank order | Changing breaks escalation invariants |
| Wave window per tier | Per-tier DB value — v2 only, with guards |
| Acceptance transaction step count | Code structure, not data |
| Order state transition graph | Code structure, invariant enforced by tests |
| JWT secret | ENV-only; requires restart by design |
| Database connection pool size | ENV-only; operational concern |
| DB connection strings | ENV-only; security boundary |
