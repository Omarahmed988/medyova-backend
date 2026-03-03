# Audit Logging Layer — Specification

> **Status**: v1 — Draft (Pending Architectural Review)  
> **Layer**: 10B (Launch Hardening — Observability)  
> **Depends on**: Layer 10A (Admin Control Layer)

---

## 1. Purpose

This specification defines a **structured audit logging system** for Medyova. The audit layer provides a tamper-evident trail of significant state changes across the platform. It is designed for operational accountability (who changed what, when) — not for analytics or real-time monitoring.

---

## 2. Database Schema

### 2.1 `audit_logs` Table

| Column | Type | Constraints | Notes |
|--------|------|------------|-------|
| `id` | `UUID` | PK, DEFAULT `gen_random_uuid()` | |
| `entity_type` | `VARCHAR(50)` | NOT NULL | `'zone'`, `'pharmacy'`, `'request'`, `'offer'`, `'order'`, `'subscription'`, `'insurance_profile'`, `'insurance_contract'`, `'insurance_company'` |
| `entity_id` | `UUID` | NOT NULL | ID of the affected entity |
| `action` | `VARCHAR(100)` | NOT NULL | Machine-readable action code |
| `actor_type` | `VARCHAR(20)` | NOT NULL | `'system'`, `'admin'`, `'user'`, `'pharmacy'` |
| `actor_id` | `UUID` | NULLABLE | NULL for system-initiated actions |
| `metadata` | `JSONB` | NOT NULL, DEFAULT `'{}'` | Structured context (old/new values, reason) |
| `created_at` | `TIMESTAMPTZ` | NOT NULL, DEFAULT `now()` | Immutable — no `updated_at` |

### 2.2 Indexes

| Index | Columns | Purpose |
|-------|---------|---------|
| IDX | `entity_type, entity_id` | Entity history lookup |
| IDX | `actor_type, actor_id` | Actor activity lookup |
| IDX | `created_at` | Time-range queries |
| IDX | `action` | Action-type filtering |

### 2.3 Constraints

- **No UPDATE** — audit logs are append-only. No UPDATE or DELETE operations permitted.
- **No FK** on `entity_id` — entities may be soft-deleted, and audit logs must persist independently.
- **No FK** on `actor_id` — actor may be external or system.

---

## 3. What Must Be Logged

### 3.1 Admin Actions (actor_type = 'admin')

| Action Code | Entity Type | Trigger |
|-------------|-------------|---------|
| `zone.deactivated` | zone | Admin sets `is_active = false` |
| `zone.activated` | zone | Admin sets `is_active = true` |
| `zone.maintenance_on` | zone | Admin sets `maintenance_mode = true` |
| `zone.maintenance_off` | zone | Admin sets `maintenance_mode = false` |
| `pharmacy.deactivated` | pharmacy | Admin sets `is_active = false` |
| `pharmacy.activated` | pharmacy | Admin sets `is_active = true` |
| `pharmacy.blocked` | pharmacy | Admin sets `is_blocked = true` |
| `pharmacy.unblocked` | pharmacy | Admin sets `is_blocked = false` |
| `pharmacy.tier_overridden` | pharmacy | Admin sets `tier_override_id` |
| `pharmacy.tier_override_cleared` | pharmacy | Admin clears `tier_override_id` |
| `insurance_company.deactivated` | insurance_company | Admin sets `is_active = false` |
| `insurance_contract.deactivated` | insurance_contract | Admin sets `is_active = false` |
| `insurance_profile.deactivated` | insurance_profile | Admin sets `is_active = false` |

### 3.2 Business Events (actor_type = 'user' | 'pharmacy' | 'system')

| Action Code | Entity Type | Actor | Trigger |
|-------------|-------------|-------|---------|
| `offer.accepted` | offer | user | User accepts an offer |
| `offer.rejected` | offer | system | Auto-rejected during acceptance |
| `order.state_changed` | order | user / pharmacy / system | Any order state transition |
| `order.cancelled` | order | user / pharmacy / system | Cancellation event |
| `order.sla_timeout` | order | system | SLA sweep auto-cancel |
| `subscription.request_generated` | subscription | system | Sweep generates request |
| `subscription.precheck_failed` | subscription | system | Pre-check failure |
| `subscription.insurance_guard_skip` | subscription | system | Insurance guard skipped generation |

### 3.3 Metadata Schema Examples

```json
// Admin action
{
  "field": "is_active",
  "old_value": true,
  "new_value": false,
  "reason": "Pharmacy compliance violation"
}

// Order state change
{
  "from_state": "pending",
  "to_state": "confirmed_by_pharmacy",
  "cancelled_by": null
}

// Subscription generation
{
  "request_id": "uuid",
  "next_run_at": "2026-04-15T08:00:00Z"
}
```

---

## 4. What Must NOT Be Logged

| Event | Reason |
|-------|--------|
| Wave heartbeats (`routing_jobs.updated_at` updates) | High frequency, no audit value |
| Metrics emissions | Telemetry, not state changes |
| Worker poll cycles (no-op iterations) | No state change |
| Health check requests | Noise |
| Offer selection queries (read-only) | No state mutation |
| Request creation (user action, not admin) | Deferred — may add in future |

---

## 5. Insert Strategy Decision

### Decision: **Same-transaction insert for critical paths, fire-and-forget for admin**

| Path | Strategy | Reasoning |
|------|----------|-----------|
| **Offer acceptance** | Same transaction (Step 9) | Must guarantee audit log if acceptance succeeds. Atomic with business state. |
| **Order state transitions** | Same transaction | State change and audit must be atomic. |
| **Admin actions** | Same autocommit statement | Admin PATCH is already autocommit. Add INSERT after UPDATE in same request handler. If INSERT fails, log error but do not rollback the admin action. |
| **Subscription generation** | Same transaction | Already inside BEGIN/COMMIT. Add INSERT before COMMIT. |
| **SLA auto-cancel** | Same transaction | Already inside BEGIN/COMMIT in sweep. |

> [!IMPORTANT]
> **Audit logging must NOT block primary transactions.** For same-transaction inserts, the INSERT is a simple append with no FK validation (no foreign keys on `entity_id` or `actor_id`). This adds < 1ms to each transaction.

---

## 6. Invariants

| ID | Invariant | Enforcement |
|----|-----------|-------------|
| **AL-1** | Audit logs are append-only | Application: no UPDATE/DELETE endpoints. DB: can add rule/trigger to prevent. |
| **AL-2** | Critical state changes always produce an audit record | Same-transaction insert guarantees atomicity |
| **AL-3** | Audit log failure does not block admin operations | Admin path uses try/catch on INSERT |
| **AL-4** | `created_at` is server-side `now()` — not client-provided | DB DEFAULT, not application-set |

---

## 7. Concurrency

- Audit log INSERTs are append-only — no row contention
- No locks required on `audit_logs` table
- No conflict with existing `FOR UPDATE SKIP LOCKED` patterns
- High-write volume is naturally handled by PostgreSQL's WAL

## 8. Transaction Boundaries

- Critical paths (acceptance, order, subscription): audit INSERT added INSIDE existing transaction before COMMIT
- Admin paths: audit INSERT in same request handler, after the UPDATE, no explicit transaction
- No new BEGIN/COMMIT blocks created

## 9. Performance

- Append-only table with 4 indexes — write cost is minimal
- JSONB `metadata` column is stored as TOAST — no bloat on narrow index scans
- Query patterns (entity lookup, time-range) are all indexed
- At 10k orders, estimated ~50k audit rows/month — trivial for PostgreSQL
- Consider partitioning by `created_at` at 10M+ rows (deferred)

## 10. Legal Boundary

- Audit logs contain operational data, not personal health information
- No prescription content stored in audit metadata
- No insurance claim data
- `actor_id` references platform users/admins — standard operational logging

---

## 11. Implementation Impact

### New Files

| File | Description |
|------|-------------|
| Migration | `audit_logs` table |
| `src/services/auditService.js` | `logAuditEvent(client, { entity_type, entity_id, action, actor_type, actor_id, metadata })` |

### Modified Files

| File | Change |
|------|--------|
| `offerAcceptance.js` | Add Step 9: audit log INSERT inside tx |
| `orderService.js` | Add audit INSERT inside `updateState()` tx |
| `subscriptionService.js` | Add audit INSERT inside `generateRequest()` tx |
| `order-sla-sweep.js` | Add audit INSERT inside auto-cancel tx |
| `src/routes/admin.js` | Call `auditService` after each PATCH |

### Unmodified Files

| File | Reason |
|------|--------|
| `routing-worker.js` | No audit for wave/routing internals |
| `offerSelection.js` | Read-only — no state changes |
| `subscription-sweep.js` | Delegates to `subscriptionService` which handles audit |
