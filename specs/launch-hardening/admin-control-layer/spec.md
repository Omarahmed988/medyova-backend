# Admin Control Layer — Specification

> **Status**: v1 — Draft (Pending Architectural Review)  
> **Layer**: 10A (Launch Hardening — Governance)  
> **Depends on**: All prior layers (zones, pharmacies, requests, routing, offers, orders, subscriptions, insurance)

---

## 1. Purpose

This specification defines a **minimal admin governance layer** that provides Zone-1 operators with the ability to control platform state through soft flags. The admin layer is a **control surface only** — it modifies flags that existing systems already check. It does NOT introduce new business logic, modify transaction flows, or touch acceptance/order/commission pathways.

---

## 2. Scope

### 2.1 Zone Control

| Action | Mechanism | Effect |
|--------|-----------|--------|
| **Disable zone** | `zones.is_active = false` | New requests in this zone are rejected at API level. Existing in-flight requests continue to completion. |
| **Freeze routing (maintenance)** | `zones.maintenance_mode = true` (new column) | Routing worker skips jobs for this zone. No new waves created. Existing waves complete naturally. |
| **Re-enable zone** | `zones.is_active = true` | Normal operation resumes. |

#### Maintenance Mode Semantics

When `zones.maintenance_mode = true`:
1. `claimNextJob()` adds `AND z.maintenance_mode = false` to its WHERE clause (join zones via request)
2. Existing active jobs are NOT interrupted — they complete their current wave naturally
3. No new jobs are claimed for this zone
4. Pre-existing offers remain visible and acceptable
5. Order lifecycle is unaffected

### 2.2 Pharmacy Control

| Action | Mechanism | Effect |
|--------|-----------|--------|
| **Soft deactivate** | `pharmacies.is_active = false` | Excluded from routing queries. Existing offers remain valid. |
| **Manual tier override** | `pharmacies.tier_override_id` (new nullable UUID FK → tiers) | If set, routing uses this tier instead of `tier_id`. Allows admin to temporarily promote/demote. |
| **Emergency block** | `pharmacies.is_blocked = true` (new column) | Immediately excluded from routing AND offer visibility. Stronger than deactivation. |

#### Tier Override Semantics

- `queryEligiblePharmacies()` uses `COALESCE(p.tier_override_id, p.tier_id)` in WHERE
- Override is temporary — admin can clear it (set NULL) to restore original tier
- No change to tier escalation logic itself

#### Emergency Block Semantics

- `is_blocked = true` acts as a hard filter in `queryEligiblePharmacies()`: `AND p.is_blocked = false`
- Blocked pharmacies' existing offers remain in the system but are NOT shown in offer selection
- `offerSelection.js` adds `AND p.is_blocked = false` to its pharmacy join

### 2.3 Insurance Control

| Action | Mechanism | Effect |
|--------|-----------|--------|
| **Deactivate company** | `insurance_companies.is_active = false` | No new profiles can reference this company. Existing profiles continue routing normally (their `is_active` is separate). |
| **Deactivate contract** | `pharmacy_insurance_contracts.is_active = false` | Pharmacy excluded from insured routing for this company. Already checked by routing JOIN. |
| **Deactivate user profile** | `user_insurance_profiles.is_active = false` | Insurance guard in subscription service skips. Routing JOIN excludes. Already implemented. |

### 2.4 Safety Invariants

| ID | Invariant | Enforcement |
|----|-----------|-------------|
| **AC-1** | No DELETE operations in admin APIs | Application: all endpoints use UPDATE with soft flags |
| **AC-2** | All admin actions are logged | Application: audit layer integration (spec 10B) |
| **AC-3** | Admin cannot modify request state directly | API: no endpoint exists for request.state mutation |
| **AC-4** | Admin cannot modify offer status directly | API: no endpoint exists for offer.status mutation |
| **AC-5** | Admin cannot modify order state directly | API: no endpoint exists for order lifecycle mutation |
| **AC-6** | Maintenance mode does not interrupt active routing | Application: only `claimNextJob` is gated, not `executeWave` |

---

## 3. Explicit Non-Goals

| Non-Goal | Reason |
|----------|--------|
| Admin UI/dashboard | Out of scope — API-only for MVP |
| Bulk admin operations | Single-entity operations only |
| Analytics panel | Separate spec (10C) |
| User management | Auth layer concern |
| Commission adjustment | Order lifecycle is frozen |
| Offer price override | Pharmacy responsibility |
| Routing rule customization | Routing logic is frozen |

---

## 4. Database Changes

### 4.1 New Columns

| Table | Column | Type | Default | Notes |
|-------|--------|------|---------|-------|
| `zones` | `maintenance_mode` | `BOOLEAN NOT NULL` | `false` | Freezes routing for zone |
| `pharmacies` | `tier_override_id` | `UUID NULLABLE` | `NULL` | FK → `tiers(id)`, ON DELETE SET NULL |
| `pharmacies` | `is_blocked` | `BOOLEAN NOT NULL` | `false` | Emergency routing block |

### 4.2 No New Tables

Admin control operates entirely through existing table flags + 3 new columns.

---

## 5. API Endpoints

### 5.1 Zone Control

| Method | Path | Body | Effect |
|--------|------|------|--------|
| `PATCH` | `/admin/zones/:id` | `{ is_active, maintenance_mode }` | Update zone flags |

### 5.2 Pharmacy Control

| Method | Path | Body | Effect |
|--------|------|------|--------|
| `PATCH` | `/admin/pharmacies/:id` | `{ is_active, is_blocked, tier_override_id }` | Update pharmacy flags |

### 5.3 Insurance Control

| Method | Path | Body | Effect |
|--------|------|------|--------|
| `PATCH` | `/admin/insurance-companies/:id` | `{ is_active }` | Toggle company |
| `PATCH` | `/admin/insurance-contracts/:id` | `{ is_active }` | Toggle contract |
| `PATCH` | `/admin/insurance-profiles/:id` | `{ is_active }` | Toggle user profile |

### 5.4 Authentication

All `/admin/*` routes require admin-level JWT claims. Non-admin tokens receive `403`.

---

## 6. Concurrency

- Admin flag changes are single-row UPDATEs — no transaction complexity
- Routing worker reads flags at query time — no stale cache
- No new locks introduced
- No conflict with `FOR UPDATE SKIP LOCKED` in routing/sweep workers

## 7. Transaction Boundaries

- Each admin PATCH is a single autocommit UPDATE
- No BEGIN/COMMIT needed
- No multi-table transactions
- Audit log insert is in same statement or same tick (see audit spec)

## 8. Performance

- All flag columns are indexed or part of existing queries
- `maintenance_mode` check adds one JOIN condition to `claimNextJob()` — negligible
- `is_blocked` adds one AND clause to existing pharmacy queries — negligible
- `COALESCE(tier_override_id, tier_id)` may prevent index use on `tier_id` — acceptable for MVP scale

## 9. Legal Boundary

- Admin actions are internal operational controls
- No user-facing legal implications
- Emergency pharmacy block is an operational safety measure, not a contractual action
- All admin actions are logged for accountability

---

## 10. Implementation Impact

### Modified Files

| File | Change |
|------|--------|
| `routing-worker.js` | `claimNextJob()`: add maintenance_mode check. `queryEligiblePharmacies()`: add `is_blocked = false`, `COALESCE` for tier override |
| `src/routes/admin.js` | **NEW** — admin PATCH endpoints |
| `src/middlewares/requireAdmin.js` | **NEW** — admin JWT validation |
| Migration | 3 new columns on existing tables |

### Unmodified Files

| File | Reason |
|------|--------|
| `offerAcceptance.js` | Acceptance flow unchanged |
| `orderService.js` | Order lifecycle unchanged |
| `order-sla-sweep.js` | SLA sweep unchanged |
| `subscriptionService.js` | Subscription logic unchanged |
| `subscription-sweep.js` | Sweep logic unchanged |
| `offerSelection.js` | May add `is_blocked` filter (minimal) |
