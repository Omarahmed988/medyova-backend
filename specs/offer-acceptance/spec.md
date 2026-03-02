# Offer Acceptance & Order Lifecycle — Specification

> **Status**: v2 — Final (Revised per Architectural Feedback)  
> **Layer**: API (Route + Service)  
> **Depends on**: Layer 2 (requests, offers), Layer 3 (routing_jobs), Governance Spec v2

---

## 1. Purpose

This specification defines what happens when a client accepts an offer. It covers the exact atomic state transitions, concurrency protection against double-acceptance and post-expiry acceptance, invariants that must hold, failure scenarios, and future extensibility for commission and order creation.

---

## 2. Acceptance Flow — Atomic Transaction

### 2.1 Endpoint

```
POST /requests/:requestId/offers/:offerId/accept
```

No request body required. The endpoint is idempotent — accepting an already-accepted offer returns success.

### 2.2 Preconditions (Checked Before Transaction)

| Check | Query | Failure Response |
|-------|-------|------------------|
| User authenticated | Auth middleware | `401 Unauthorized` |
| User owns request | `SELECT user_id FROM requests WHERE id = $1` | `403 Forbidden` |
| Request exists | `SELECT state FROM requests WHERE id = $1` | `404 Not Found` |
| Offer exists and belongs to request | `SELECT status FROM offers WHERE id = $1 AND request_id = $2` | `404 Not Found` |
| Request is in an acceptable state | `request.state IN ('fully_offered', 'partially_offered')` | `409 Conflict` — error code: `request_not_accepting` |
| Offer is still pending | `offer.status = 'pending'` | `409 Conflict` — error code: `offer_already_rejected` or `offer_already_accepted` |

### 2.3 Atomic Transaction (Single BEGIN/COMMIT)

Once preconditions pass, the following operations execute inside **one transaction**:

```sql
BEGIN;

-- Step 1: Lock the REQUEST row FIRST (deadlock-prevention rule)
-- Always acquire request lock before offer lock.
SELECT state FROM requests
WHERE id = $requestId
FOR UPDATE;

-- Step 2: Re-verify request state under lock
-- If state NOT IN ('fully_offered', 'partially_offered'), ROLLBACK → 409
-- (Prevents race with worker expiry or concurrent acceptance)

-- Step 3: Lock the target offer (prevent concurrent acceptance)
SELECT id, status FROM offers
WHERE id = $offerId AND request_id = $requestId
FOR UPDATE;

-- Step 4: Re-verify offer is still pending (inside lock)
-- If status != 'pending' AND status = 'accepted', return idempotent 200
-- If status != 'pending' AND status != 'accepted', ROLLBACK → 409

-- Step 5: Accept the target offer
UPDATE offers
SET status = 'accepted', updated_at = now()
WHERE id = $offerId AND status = 'pending';

-- Step 6: Reject all other pending offers for this request
UPDATE offers
SET status = 'rejected', updated_at = now()
WHERE request_id = $requestId
  AND id != $offerId
  AND status = 'pending';

-- Step 7: Transition request state
UPDATE requests
SET state = 'accepted', updated_at = now()
WHERE id = $requestId
  AND state IN ('fully_offered', 'partially_offered');

COMMIT;
```

> [!IMPORTANT]
> **Deadlock Prevention Rule:** The lock acquisition order is always `requests` FIRST, then `offers`. All code paths that write to both tables must follow this order. The routing worker already follows this: it updates `routing_jobs` (which doesn't conflict), then `requests`. No deadlock is possible because the acceptance endpoint and the worker never hold locks on the same table pair in reverse order.

### 2.4 Response

```json
{
    "accepted": true,
    "offer_id": "<uuid>",
    "request_id": "<uuid>",
    "request_state": "accepted"
}
```

HTTP 200 on success (including idempotent re-acceptance of the same offer).

HTTP 409 on precondition failure, with structured error:

```json
{
    "error": "Conflict",
    "error_code": "offer_already_rejected",
    "message": "This offer has already been rejected because another offer was accepted.",
    "statusCode": 409
}
```

#### Defined Error Codes

| Error Code | Condition |
|------------|----------|
| `request_not_accepting` | `request.state` not in `fully_offered/partially_offered` |
| `offer_already_accepted` | Different offer already accepted for this request |
| `offer_already_rejected` | This specific offer was rejected |
| `offer_expired` | Offer expired |
| `request_not_found` | Request ID does not exist |
| `offer_not_found` | Offer ID does not exist or doesn't belong to request |

---

## 3. State Transitions

### 3.1 Complete State Transition Map

| Entity | Before | After | Condition |
|--------|--------|-------|-----------|
| `offers` (target) | `status = 'pending'` | `status = 'accepted'` | Selected offer |
| `offers` (others) | `status = 'pending'` | `status = 'rejected'` | All other pending offers for this request |
| `requests` | `state IN ('fully_offered', 'partially_offered')` | `state = 'accepted'` | Always on successful acceptance |
| `routing_jobs` | `status IN ('completed', 'expired')` | **No change** | Job already in terminal state; no transition needed |

### 3.2 Why `routing_jobs` Is NOT Modified

The routing job is already in a terminal state (`completed` or `expired`) before acceptance is allowed (enforced by the Visibility Gate — Governance Spec v2 §2.2). Acceptance is a **user-side** event, not a routing event. Modifying `routing_jobs.status` would conflate two different lifecycle domains:

- **Routing lifecycle**: pending → active → completed/expired (managed by worker)
- **Request lifecycle**: broadcasted → offered → accepted (managed by API)

These remain separate. The routing job's purpose ends at offer generation.

---

## 4. Concurrency Protection

### 4.1 Double Acceptance Prevention

**Threat:** Two concurrent requests attempt to accept different offers for the same request.

**Protection:** The `requests` row is locked FIRST (Step 1) via `SELECT ... FOR UPDATE`. This serializes all acceptance attempts for the same request. The first transaction completes all steps and commits. The second transaction acquires the request lock, re-verifies state (Step 2), sees `state = 'accepted'`, and immediately rolls back with `409`.

If both transactions attempt to accept the **same** offer, the second sees `status = 'accepted'` at Step 4 and returns idempotent `200` success.

**Key:** Because the `requests` row is locked first, there is no window for partial state. The request-level lock acts as a global serialization point for all acceptance attempts on the same request.

### 4.2 Acceptance After Expiry Prevention

**Threat:** User submits acceptance after the request has expired but before the UI reflects the state change.

**Protection:** Precondition check (§2.2) verifies `request.state IN ('fully_offered', 'partially_offered')`. If the request has expired, `request.state = 'expired'`, and the check fails with `409 Conflict`.

**Edge case:** What if expiry happens between precondition check and transaction?

**Resolution:** The request row is locked inside the transaction (Step 1 — `SELECT ... FOR UPDATE`). This prevents the worker's `expireJob` from modifying `request.state` while the acceptance transaction is in progress. The in-transaction re-verification (Step 2) catches any state change that occurred before the lock was acquired.

No compensating transaction is needed. The lock + re-verify pattern eliminates the race condition entirely.

### 4.3 Worker Running During Acceptance

**Threat:** The routing worker is still processing waves when the user accepts an offer.

**Protection:** This scenario is **impossible** under the Visibility Gate (Governance Spec v2 §2.2). The API only allows acceptance when `routing_jobs.status IN ('completed', 'expired')`. If the worker is still active, `routing_jobs.status = 'active'`, and the visibility gate returns `[]` — the client never sees offers to accept.

**However:** If the visibility gate is bypassed (bug or direct API access), the request-level lock in §4.2 prevents state corruption. The worker's `completeJobWithState()` will try to set `request.state = 'fully_offered'` or similar, but the acceptance transaction holds the lock on the `requests` row.

### 4.4 Transaction Boundaries Summary

| Operation | Scope | Duration |
|-----------|-------|----------|
| Precondition checks | Two autocommit queries | < 5ms |
| Acceptance transaction | `BEGIN → FOR UPDATE (requests, offers) → 3 UPDATEs → COMMIT` | < 20ms |
| Post-commit response | No transaction | Immediate |

No long-running transactions. No connection held during user think time.

---

## 5. Invariants

### 5.1 Acceptance Invariants

| ID | Invariant | Enforcement |
|----|-----------|-------------|
| **A-1** | If `request.state = 'accepted'`, exactly one offer has `status = 'accepted'` | Transaction Step 5 — only one offer is accepted per transaction |
| **A-2** | If `request.state = 'accepted'`, zero offers remain `status = 'pending'` | Transaction Step 6 — all other pending offers are rejected |
| **A-3** | `offer.status` can only transition: `pending → accepted`, `pending → rejected`, `pending → expired` | Application-level guard + SQL `WHERE status = 'pending'` |
| **A-4** | `request.state = 'accepted'` is a terminal state — no further transitions allowed | Application-level guard — acceptance endpoint rejects requests not in `fully_offered/partially_offered` |
| **A-5** | Acceptance must not change `routing_jobs.status` | No routing_jobs UPDATE in acceptance transaction |
| **A-6** | The accepted offer MUST belong to the request | `WHERE offer.request_id = $requestId` in all queries |
| **A-7** | If `request.state = 'accepted'`, then `routing_jobs.status` must be terminal (`completed` or `expired`) | Enforced by visibility gate precondition (§2.2) — acceptance is only reachable after routing terminates |

### 5.2 Cross-Invariant Alignment

| Governance Invariant | Acceptance Invariant | Relationship |
|---------------------|---------------------|--------------|
| I-1 (`fully_offered` → ≥1 full coverage) | A-1 (exactly one accepted) | Full coverage guarantee survives acceptance |
| I-4 (routing completed before selection) | A-7 (routing_jobs terminal) | Routing must be terminal before acceptance is possible |
| I-5 (no backward transitions) | A-4 (`accepted` is terminal) | State only moves forward |

---

## 6. Failure Scenarios

### 6.1 Stale Job Recovery During Acceptance

**Scenario:** The stale recovery sweep runs while a user is mid-acceptance.

**Risk:** The sweep might try to expire the routing job and request while the acceptance transaction holds locks.

**Resolution:** Safe by design:
- The stale sweep targets `routing_jobs.status = 'active'` — but acceptance only proceeds when the job is already `completed/expired`.
- If the request has already been accepted (`request.state = 'accepted'`), the sweep's `UPDATE requests SET state = ...` would need to match `state IN ('broadcasted', 'fully_offered', 'partially_offered')` — it won't match `'accepted'`.
- **No conflict is possible.**

### 6.2 Pharmacy Cancellation After Acceptance

**Scenario:** A pharmacy cancels their offer after the user has already accepted it.

**Current scope:** This is an **order-level concern**, not an acceptance concern. At acceptance time, the transaction is atomic and final. Post-acceptance cancellation requires a separate endpoint and lifecycle:

```
POST /offers/:offerId/cancel  (pharmacy-side)
```

This endpoint would:
1. Check `offer.status = 'accepted'`
2. Transition `offer.status` → a new status (e.g., `'pharmacy_cancelled'`)
3. Transition `request.state` → a new status (e.g., `'cancelled_by_pharmacy'`)
4. Potentially re-open selection for remaining offers

> [!WARNING]
> Pharmacy cancellation after acceptance requires new enum values and a separate spec. It is NOT part of Phase 6. Document this as a future requirement.

### 6.3 Network Failure Mid-Transaction

**Scenario:** The database connection drops between BEGIN and COMMIT.

**Resolution:** PostgreSQL automatically rolls back uncommitted transactions on connection close. No partial state is possible. The client receives a 500 error and can retry safely (the acceptance endpoint is idempotent for the same offer).

### 6.4 Concurrent Acceptance of Same Offer

**Scenario:** Two browser tabs both click "Accept" on the same offer at the same time.

**Resolution:** `SELECT ... FOR UPDATE` serializes the two transactions. The first one accepts; the second one sees `status = 'accepted'` and returns idempotent success (not an error — the user's intent was fulfilled).

### 6.5 Acceptance of Already-Rejected Offer

**Scenario:** Offer A was rejected because the user accepted Offer B. Now the user tries to accept Offer A.

**Resolution:** Precondition check fails — `offer.status = 'rejected'` ≠ `'pending'`. Returns `409 Conflict`.

---

## 7. Commission & Future Extensibility

### 7.1 Commission Model (Not Implemented Yet)

When the marketplace introduces a commission model, the acceptance transaction will need to be extended:

```sql
-- Future Step 6 (inside same transaction):
INSERT INTO orders (
    id, request_id, offer_id, pharmacy_id, patient_id,
    total_price, delivery_fee, commission_rate, commission_amount,
    status, created_at
)
VALUES (
    gen_random_uuid(), $requestId, $offerId, $pharmacyId, $patientId,
    $totalPrice, $deliveryFee, $commissionRate,
    $totalPrice * $commissionRate / 100,
    'pending', now()
);
```

### 7.2 Required Schema for Orders (Future)

| Column | Type | Notes |
|--------|------|-------|
| `id` | `UUID` | Primary key |
| `request_id` | `UUID` | FK → requests |
| `offer_id` | `UUID` | FK → offers |
| `pharmacy_id` | `UUID` | FK → pharmacies |
| `patient_id` | `UUID` | FK → users |
| `total_price` | `NUMERIC(10,2)` | From accepted offer |
| `delivery_fee` | `NUMERIC(10,2)` | From accepted offer |
| `commission_rate` | `NUMERIC(5,2)` | Platform percentage |
| `commission_amount` | `NUMERIC(10,2)` | Calculated |
| `status` | `order_status_enum` | pending → confirmed → delivered → completed |
| `created_at` | `TIMESTAMPTZ` | Audit |

### 7.3 Extensibility Guarantee

The acceptance transaction is designed so that adding Steps 6+ (order creation, commission calculation) only requires:
1. Adding the `INSERT` inside the same `BEGIN/COMMIT` block.
2. No changes to Steps 1–5.
3. No changes to concurrency protection.

The transaction remains short (< 50ms even with order insertion).

---

## 8. Implementation Impact

### 8.1 Required Changes

| Component | Change |
|-----------|--------|
| `src/services/offerAcceptance.js` (new) | Acceptance transaction logic |
| `src/routes/offers.js` (modify) | Add `POST /:requestId/offers/:offerId/accept` |
| `tests/offerAcceptance.test.js` (new) | Unit tests for all scenarios |

### 8.2 No Changes Required

| Component | Reason |
|-----------|--------|
| `src/workers/routing-worker.js` | No routing changes |
| `src/services/offerSelection.js` | Selection is read-only |
| Database schema | All required columns and enums already exist |
| Migrations | No schema changes |

---

## 9. Resolved Questions

| # | Question | Resolution |
|---|----------|------------|
| 1 | Auth required for acceptance? | **Yes.** User must be authenticated. User must own the request (`user_id` match), otherwise `403 Forbidden`. |
| 2 | Idempotent re-accept HTTP code? | **200** with standard response body. Not 204. |
| 3 | 409 error detail? | **Yes.** Include structured `error_code` field (see §2.4 for full list). |
