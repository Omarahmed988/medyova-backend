# Phase 13 — Order Rating System Implementation Plan

**Status:** Ready for Review  
**Spec:** `specs/order-rating-system/spec.md` (approved)

---

## 1. Migration

**File:** `migrations/<timestamp>_layer9-order-rating-system.js`

### Up

```sql
-- 1. Core reviews table
CREATE TABLE order_reviews (
    id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    order_id    UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
    pharmacy_id UUID NOT NULL REFERENCES pharmacies(id) ON DELETE CASCADE,
    user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    rating      SMALLINT NOT NULL CHECK (rating >= 1 AND rating <= 5),
    comment     TEXT CHECK (char_length(comment) <= 500),
    created_at  TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT order_reviews_order_id_key UNIQUE (order_id)
);

-- 2. Indexes for audit and admin queries
CREATE INDEX idx_order_reviews_pharmacy_id ON order_reviews(pharmacy_id);
CREATE INDEX idx_order_reviews_user_id     ON order_reviews(user_id);

-- 3. Pharmacy aggregate columns
ALTER TABLE pharmacies ADD COLUMN rating_avg   NUMERIC(3,2) NOT NULL DEFAULT 0.00;
ALTER TABLE pharmacies ADD COLUMN rating_count INTEGER      NOT NULL DEFAULT 0;
```

### Down (safe reversal)

```sql
ALTER TABLE pharmacies DROP COLUMN IF EXISTS rating_count;
ALTER TABLE pharmacies DROP COLUMN IF EXISTS rating_avg;
DROP TABLE IF EXISTS order_reviews;
```

---

## 2. Service Layer — `reviewService.js`

**Location:** `src/services/reviewService.js`

### `submitReview(authenticatedUserId, orderId, rating, comment)`

1. **Eligibility check** — single read:
   ```sql
   SELECT status, user_id, pharmacy_id FROM orders WHERE id = $1;
   ```
2. **Status gate:** if `status !== 'completed'` → throw `422`
3. **Ownership gate:** if `user_id !== authenticatedUserId` → throw `403`
4. **Insert review** — `pharmacy_id` sourced from the orders row (never from client payload):
   ```sql
   INSERT INTO order_reviews (order_id, pharmacy_id, user_id, rating, comment)
   VALUES ($1, $2, $3, $4, $5)
   RETURNING id, order_id, pharmacy_id, user_id, rating, comment, created_at;
   ```
5. **Aggregate update** — immediately after insert:
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
6. **Aggregate failure handling:** catch and log the error without re-throwing — the review insert is already committed.

### `getReview(orderId)`

Single read: `SELECT * FROM order_reviews WHERE order_id = $1`. Returns `null` if none.

### `deleteReview(reviewId)` *(admin only)*

1. Fetch `pharmacy_id` from `order_reviews WHERE id = $1`
2. `DELETE FROM order_reviews WHERE id = $1`
3. Run the same aggregate recalculation on the pharmacy

---

## 3. Routes

### `POST /orders/:id/review`

**Auth:** `requireAuth` middleware  
**Body validation:** `rating` (integer 1–5, required), `comment` (string ≤ 500 chars, optional)

```
201  → review object
400  → missing / invalid rating
401  → no auth
403  → not order owner
409  → review already exists (UNIQUE constraint)
422  → order not completed
```

### `GET /orders/:id/review`

**Auth:** none (public pharmacy rating display)  
Returns the review or `404` if none exists.

---

## 4. Admin Moderation Route

### `DELETE /admin/reviews/:id`

**Auth:** `requireAuth` + `role === 'super_admin'`  
Calls `reviewService.deleteReview(id)`. Triggers aggregate recalculation. Returns `{ status: 'deleted' }`.

**Mounted:** On existing `src/routes/admin.js` (no new file required).

---

## 5. Application Mount

No new router file needed for the admin delete — it extends `admin.js`.  
The review routes (`POST` / `GET`) will be added to a new `src/routes/reviews.js` and mounted in `app.js`:

```js
app.use('/orders', requireDb, reviewsRouter);
```

This mounts cleanly alongside the existing `/requests` offer routes.

---

## 6. Test Coverage Boundaries

| Test | Expected outcome |
|------|-----------------|
| `POST /orders/:id/review` — completed order, correct user | `201`, review returned |
| `POST /orders/:id/review` — order not completed | `422` |
| `POST /orders/:id/review` — wrong user | `403` |
| `POST /orders/:id/review` — second submission | `409` |
| `POST /orders/:id/review` — rating < 1 or > 5 | `400` |
| `GET /orders/:id/review` — exists | `200`, review data |
| `GET /orders/:id/review` — missing | `404` |
| `DELETE /admin/reviews/:id` — super-admin | `200`, aggregate recalculated |
| `DELETE /admin/reviews/:id` — non-super-admin | `403` |
| `pharmacy_id` sourced from DB, not client | Verify `INSERT` uses `orders.pharmacy_id` |
| Aggregate `rating_avg` after 2 reviews | Correct `AVG` value |
| Aggregate `rating_count` increments | Correct count post-insert |
| Aggregate failure does not rollback review | Review row persists on aggregate error |

---

## 7. Rollout Order

1. Run migration (`order_reviews` + pharmacy columns)
2. Deploy `reviewService.js`
3. Deploy `src/routes/reviews.js` + mount in `app.js`
4. Add `DELETE /admin/reviews/:id` to `admin.js`
5. Run test suite (all existing + 13 new tests must pass)
6. Verify `rating_avg` and `rating_count` on a seeded test pharmacy

---

## 8. Invariant Confirmations

- `queryEligiblePharmacies` — **zero modifications** in this phase
- Acceptance transaction — **zero modifications**
- `routing-worker.js` — **zero modifications**
- Order lifecycle (`orderService.js`) — **zero modifications**
- No new worker loops or background queues introduced
- `rating_avg` does **not** feed into `trust_score` in v1
