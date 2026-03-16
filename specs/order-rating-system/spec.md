# Phase 13 — Order Rating System Specification (Spec-Kit)

**Status:** Ready for Review  
**Phase Sequence:** Phase 11 (complete) → Phase 12 (complete) → **Phase 13 (planning)**  
**Objective:** Introduce verified customer reviews tied strictly to completed orders. Build trusted social proof without affecting v1 routing behavior.

---

## 1. Schema Extensions

### New Table: `order_reviews`

```sql
CREATE TABLE order_reviews (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    order_id UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
    pharmacy_id UUID NOT NULL REFERENCES pharmacies(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    rating SMALLINT NOT NULL CHECK (rating >= 1 AND rating <= 5),
    comment TEXT CHECK (char_length(comment) <= 500),
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT order_reviews_order_id_key UNIQUE (order_id)
);
```

**Key constraints:**
- `UNIQUE(order_id)` — one review per completed transaction, enforced at the DB level
- `CHECK (rating >= 1 AND rating <= 5)` — invalid ratings rejected at the DB level before application-layer validation even runs
- `CHECK (char_length(comment) <= 500)` — caps comment size at the DB layer
- `ON DELETE CASCADE` — if an order is purged, the review is purged with it (cleanup safe)

### Pharmacy Table Extension

```sql
ALTER TABLE pharmacies ADD COLUMN rating_avg NUMERIC(3, 2) NOT NULL DEFAULT 0.00;
ALTER TABLE pharmacies ADD COLUMN rating_count INTEGER NOT NULL DEFAULT 0;
```

**Defaults:** `0.00` and `0` represent "no reviews yet" and are safe to query before any review exists.

### Required Index

```sql
-- Supports fast pre-submission eligibility lookups and audit queries
CREATE INDEX idx_order_reviews_pharmacy_id ON order_reviews(pharmacy_id);
CREATE INDEX idx_order_reviews_user_id ON order_reviews(user_id);
```

---

## 2. Review Eligibility Rules

Both conditions must pass synchronously during the `POST /orders/:id/review` handler before any insert is attempted.

| Rule | Check |
|------|-------|
| **Order exists** | `SELECT status, user_id, pharmacy_id FROM orders WHERE id = $1` |
| **Order is completed** | `order.status = 'completed'` — any other status returns `422 Unprocessable Entity` |
| **Ownership** | Authenticated `user_id` must match `order.user_id` — mismatch returns `403 Forbidden` |
| **Not yet reviewed** | Handled by `UNIQUE(order_id)` — duplicate insert returns `409 Conflict` |

**Single query check** (minimizes round-trips):
```sql
SELECT status, user_id, pharmacy_id
FROM orders
WHERE id = $1;
```
No JOIN needed — all metadata needed for validation is on the `orders` row.

---

## 3. Aggregation Strategy

### Update Approach: Async Recalculation
After a successful `INSERT INTO order_reviews`, the pharmacy aggregate is updated using a **recalculation query** rather than an incremental delta:

```sql
UPDATE pharmacies
SET
    rating_count = (SELECT COUNT(*) FROM order_reviews WHERE pharmacy_id = $1),
    rating_avg   = COALESCE(
                     (SELECT AVG(rating)::NUMERIC(3,2) FROM order_reviews WHERE pharmacy_id = $1),
                     0.00
                   )
WHERE id = $1;
```

**Why recalculation, not increment?**
- Safer under concurrent inserts — no risk of double-counting
- Self-healing: if a future admin soft-delete of a review occurs, one recalculation restores correctness
- At launch volumes (≪10K reviews / pharmacy) this is fast. Incremental strategy deferred to post-launch hardening

**Execution model:** The aggregate update runs in the same request cycle (sequential await), not in a background job. This keeps the response consistent without the complexity of a job queue.

**Concurrency note:** Two simultaneous first-reviews for the same pharmacy would cause a brief race. The `UNIQUE(order_id)` prevents duplicate review inserts; the aggregate will always reconverge correctly on the next update since both reads of `COUNT(*)` and `AVG()` are isolated `SELECT`s with no locking.

---

## 4. API Design

### `POST /orders/:id/review`

**Header:** `Authorization: Bearer <user_token>`

**Payload:**
```json
{
    "rating": 4,
    "comment": "Fast delivery, medication was correct."
}
```

**Response codes:**
| Code | Condition |
|------|-----------|
| `201 Created` | Review inserted, aggregate updated |
| `400 Bad Request` | Missing `rating`, or `rating` not in `[1..5]` |
| `401 Unauthorized` | No valid auth token |
| `403 Forbidden` | Authenticated user is not the order owner |
| `409 Conflict` | Review already exists for this order |
| `422 Unprocessable Entity` | Order is not in `completed` status |

**Response body (201):**
```json
{
    "review_id": "<uuid>",
    "order_id": "<uuid>",
    "pharmacy_id": "<uuid>",
    "rating": 4,
    "comment": "Fast delivery, medication was correct.",
    "created_at": "<ISO timestamp>"
}
```

### `GET /orders/:id/review` *(optional read route)*
Returns the existing review for a given order. Returns `404` if no review exists. No write access.

---

## 5. Anti-Abuse Constraints

| Constraint | Mechanism |
|------------|-----------|
| One review per order | `UNIQUE(order_id)` at DB level — cannot be bypassed |
| Ownership enforcement | Auth token `user_id` must match `orders.user_id` |
| Review only for completed orders | `status = 'completed'` check before insert |
| No edits after submission | No `PATCH /orders/:id/review` endpoint in v1 — immutable |
| Comment length cap | `CHECK (char_length(comment) <= 500)` at DB + `400` in route layer |
| No standalone reviews | `order_id` FK required — impossible to create a review without a real order |
| Admin moderation | `DELETE /admin/reviews/:id` — super-admin only, triggers recalculation |

---

## 6. Concurrency Considerations

- **Duplicate submit protection:** The `UNIQUE(order_id)` constraint ensures exactly-once semantics at the database level, even under concurrent requests
- **Aggregate race:** As noted in §3, concurrent reviews for the same pharmacy produce a benign recalculation collision. The final state is always correct after both `UPDATE` queries complete
- **No transaction required:** The review `INSERT` and aggregate `UPDATE` are two separate statements. A failure in the aggregate `UPDATE` is caught and logged without rolling back the review. The review is the source of truth; the aggregate is a cache

---

## 7. Future Integration — Trust Score

**v1 explicit constraint:** `rating_avg` and `rating_count` do **NOT** influence `trust_score` or the `ORDER BY` clause in `queryEligiblePharmacies`. The routing engine remains entirely unaffected by customer reviews in Phase 13.

**Post-v1 pathway (not scheduled):**
A potential future `trust_score` formula could incorporate ratings:
```
trust_score = base_score * (1 + rating_weight * (rating_avg - 3) / 2)
```
Where `rating_weight` is a tunable admin setting (0 = off, 1 = full weight). This would require a governance decision and its own implementation phase.

---

## 8. Implementation Order (Planned)

| Phase | Action |
|-------|--------|
| ① Migration | Add `order_reviews` table, indexes, alter `pharmacies` |
| ② Service | `reviewService.js` — eligibility check, insert, recalcule |
| ③ Routes | `POST /orders/:id/review`, `GET /orders/:id/review` |
| ④ Admin | `DELETE /admin/reviews/:id` with super-admin guard |
| ⑤ Tests | Eligibility, anti-duplicate, ownership, aggregate correctness |

---

## 9. Invariant Confirmations

- **RI-1:** Acceptance transaction, commission calculation, and order lifecycle are zero-modified
- **RI-2:** `queryEligiblePharmacies` is zero-modified — `rating_avg` does not enter the routing query
- **RI-3:** No new worker loops or cron-style background jobs are introduced
- **RI-4:** The `system_settings` and `system_feature_flags` tables are not required by this feature in v1
