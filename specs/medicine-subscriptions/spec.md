# MEDYOVA — PHASE 16: MEDICINE SUBSCRIPTIONS (RECURRING ORDERS) SPEC

> **Status**: Specification — Revision 3 (finalized).

---

## 1. Goal

Introduce recurring medicine deliveries for chronic treatments (insulin, hypertension, diabetes medications, long-term supplements).

Users subscribe to a set of medicines tied to a **specific pharmacy**. A background scheduler generates **Flow B direct orders** on a recurring cadence. Prices are always snapshotted at order time from `pharmacy_inventory`.

---

## 2. Relationship to Existing Schema

Layer 5 already created `subscriptions` and `subscription_items` tables targeting **Flow A** (prescription routing via `requests`). Phase 16 introduces a parallel subscription type that generates **Flow B** direct orders instead. Rather than forking the existing table, we extend it.

### Schema Extensions

```sql
-- Extend the existing subscriptions table
ALTER TABLE subscriptions ADD COLUMN type VARCHAR(20) NOT NULL DEFAULT 'prescription';
  -- Values: 'prescription' (existing Flow A) | 'medicine' (new Flow B)
ALTER TABLE subscriptions ADD COLUMN pharmacy_id UUID REFERENCES pharmacies(id);
  -- Required when type = 'medicine'; NULL for prescription subscriptions
ALTER TABLE subscriptions ADD COLUMN area_id UUID REFERENCES areas(id);
  -- Delivery area for direct order routing
ALTER TABLE subscriptions ADD COLUMN frequency_days INTEGER NOT NULL DEFAULT 30;
  -- Replaces preferred_day_of_month for medicine subscriptions
ALTER TABLE subscriptions ADD COLUMN pause_reason TEXT;
  -- Populated when status transitions to 'paused'
ALTER TABLE subscriptions ADD COLUMN last_order_id UUID REFERENCES orders(id) ON DELETE SET NULL;
  -- Traceability to last generated direct order

-- Extend subscription_items with medicine catalog FK
ALTER TABLE subscription_items ADD COLUMN medicine_id UUID REFERENCES medicines(id);
  -- Required for type = 'medicine' subscriptions

-- Idempotency index to prevent duplicate order generation on worker crash/retry
CREATE UNIQUE INDEX idx_subscription_idempotency
  ON orders (subscription_id, subscription_cycle_at)
  WHERE subscription_id IS NOT NULL;

-- Supporting columns on orders table for idempotency tracking
ALTER TABLE orders ADD COLUMN subscription_id UUID REFERENCES subscriptions(id) ON DELETE SET NULL;
ALTER TABLE orders ADD COLUMN subscription_cycle_at TIMESTAMPTZ;

-- Scheduler performance index (partial, medicine-type only)
CREATE INDEX idx_subscriptions_scheduler
  ON subscriptions (type, is_active, next_run_at)
  WHERE type = 'medicine';
```

### Subscription Status Machine

```
active → paused (stock unavailable / pharmacy inactive / area inactive / user action)
active → cancelled (user cancels)
paused → active (user resumes / stock restored)
cancelled → (terminal)
```

> [!IMPORTANT]
> Existing `subscriptions` rows with `type = 'prescription'` are **untouched**. The `subscription-sweep.js` worker continues to process them via Flow A. Phase 16's scheduler only processes `type = 'medicine'`.

---

## 3. Order Generation Strategy

Medicine subscriptions generate orders exclusively through **Flow B** (`directOrderService.createDirectOrder`).

They **never** invoke:
- `routing-worker.js`
- Escalation waves
- `offerAcceptance.js`
- `queryEligiblePharmacies`

### Generation Flow

```
subscription-scheduler.js
  │
  ├─ SELECT WHERE type = 'medicine' AND is_active = true
  │   AND next_run_at <= NOW()
  │
  ├─ For each subscription:
  │   ├─ Check pharmacy.is_active (pause if inactive)
  │   ├─ Validate stock (pharmacy_inventory.stock_status)
  │   ├─ If any item out_of_stock → pause subscription
  │   ├─ Idempotency: skip if order already exists for this cycle
  │   ├─ Otherwise → DirectOrderService.createDirectOrder(...)
  │   ├─ Missed-run collapse: set next_run_at = NOW() + frequency_days
  │   └─ Record last_order_id, last_run_at
  │
  └─ Process in batches of 25 with 500ms delay between batches
```

---

## 4. Subscription Scheduler Worker

**File**: `src/workers/subscription-scheduler.js`

### Behavior

```
1. Query: SELECT * FROM subscriptions
     WHERE type = 'medicine'
       AND is_active = true
       AND next_run_at <= NOW()
     ORDER BY next_run_at ASC
     LIMIT 25
     FOR UPDATE SKIP LOCKED

2. For each subscription:
   a. PHARMACY CHECK:
      - SELECT is_active FROM pharmacies WHERE id = subscription.pharmacy_id
      - If is_active = false → PAUSE with reason 'Pharmacy is inactive' + skip

   b. AREA CHECK:
      - SELECT is_active FROM areas WHERE id = subscription.area_id
      - If is_active = false → PAUSE with reason 'Delivery area is inactive' + skip

   c. IDEMPOTENCY CHECK:
      - SELECT id FROM orders
        WHERE subscription_id = sub.id
          AND subscription_cycle_at = sub.next_run_at
      - If row exists → skip (already generated for this cycle)

   c. Load subscription_items (with medicine_id and quantity)

   d. STOCK CHECK: For each item, check pharmacy_inventory:
      - WHERE pharmacy_id = subscription.pharmacy_id
        AND medicine_id = item.medicine_id
      - If stock_status = 'out_of_stock' → PAUSE + skip

   e. Call DirectOrderService.createDirectOrder(
        subscription.user_id,
        subscription.pharmacy_id,
        subscription.area_id,
        items
      )
      -- Pass subscription_id and subscription_cycle_at = sub.next_run_at
      -- These are stored on the generated order for idempotency

   f. MISSED-RUN COLLAPSE:
      -- Always reset to NOW() + frequency_days, not next_run_at + frequency_days
      -- This prevents cascading backlogged orders
      UPDATE subscriptions SET
        next_run_at = NOW() + INTERVAL '{frequency_days} days',
        last_run_at = NOW(),
        last_order_id = <generated_order_id>,
        updated_at = NOW()
      WHERE id = subscription.id

3. If batch was full (25 items), wait 500ms, then repeat from step 1
4. If batch was empty, exit (or sleep until next cron interval)
```

### Pause Behavior

When any subscription item is `out_of_stock`:

```sql
UPDATE subscriptions
SET is_active = false,
    pause_reason = 'Medicine out of stock: ' || <medicine_name>,
    updated_at = NOW()
WHERE id = $1
```

> [!NOTE]
> Notification of the user on pause is documented but left as a future integration point. The `pause_reason` field provides the operational context.

### Pharmacy Inactive Behavior

When the target pharmacy is inactive:

```sql
UPDATE subscriptions
SET is_active = false,
    pause_reason = 'Pharmacy is currently inactive',
    updated_at = NOW()
WHERE id = $1
```

### Area Inactive Behavior

When the delivery area is inactive:

```sql
UPDATE subscriptions
SET is_active = false,
    pause_reason = 'Delivery area is currently inactive',
    updated_at = NOW()
WHERE id = $1
```

### Idempotency Guarantee

The unique index `idx_subscription_idempotency` on `orders(subscription_id, subscription_cycle_at)` ensures that even if the worker crashes mid-batch and retries, no duplicate order can be created for the same subscription cycle.

### Missed-Run Collapse

If a subscription's `next_run_at` is significantly in the past (e.g., user inactive for months), the scheduler generates **exactly one order** and resets `next_run_at = NOW() + frequency_days`. This prevents a cascade of backlogged orders.

---

## 5. Price Handling

Subscriptions **never store prices**. Every order generation reads the current price from `pharmacy_inventory.price` at execution time via `DirectOrderService.createDirectOrder`, which already snapshots prices into `order_items.price_snapshot`.

This ensures:
- Pharmacies can update prices freely between cycles
- Historical orders retain their original price snapshot
- No stale pricing risk

---

## 6. Subscription Management API

All endpoints require authentication. Ownership is enforced via `req.user.id === subscription.user_id`.

### `POST /subscriptions`

Creates a new medicine subscription.

```json
{
  "pharmacy_id": "uuid",
  "area_id": "uuid",
  "frequency_days": 30,
  "items": [
    { "medicine_id": "uuid", "quantity": 2 },
    { "medicine_id": "uuid", "quantity": 1 }
  ]
}
```

**Validation**:
- Pharmacy must serve the specified area
- Pharmacy must be active
- All medicines must exist in `pharmacy_inventory` for this pharmacy
- `frequency_days` must be between 7 and 90
- `quantity` must respect `medicines.max_order_qty` (scarcity)

**Sets**: `type = 'medicine'`, `is_active = true`, `next_run_at = NOW() + frequency_days`

### `GET /subscriptions`

Returns all subscriptions owned by the authenticated user.

```sql
SELECT s.*, json_agg(si.*) AS items
FROM subscriptions s
JOIN subscription_items si ON si.subscription_id = s.id
WHERE s.user_id = $1 AND s.type = 'medicine'
GROUP BY s.id
ORDER BY s.created_at DESC
```

### `PATCH /subscriptions/:id`

Allows updating:
- `frequency_days` (7–90)
- `is_active` (resume from paused)
- Item quantities

**Cannot update** `pharmacy_id` or `area_id` — user should cancel and create a new subscription.

When resuming (`is_active: true` from a paused state), the system recalculates `next_run_at = NOW() + frequency_days`.

### `DELETE /subscriptions/:id`

Sets `is_active = false` and `status = 'cancelled'`. Soft delete — row persists for audit trail.

---

## 7. Invariant Confirmation

> [!CAUTION]
> The following components remain **completely unchanged** by Phase 16:

| Component | Status |
|-----------|--------|
| `routing-worker.js` | ❌ Not modified |
| `offerAcceptance.js` | ❌ Not modified |
| `queryEligiblePharmacies` | ❌ Not modified |
| `offerSelection.js` | ❌ Not modified |
| Flow A prescription routing | ❌ Not modified |
| `subscription-sweep.js` (Flow A) | ❌ Not modified |
| `order-sla-sweep.js` | ❌ Not modified |
| Trust score calculations | ❌ Not modified |

Medicine subscriptions operate **exclusively** through Flow B direct orders via `DirectOrderService.createDirectOrder`.

---

## 8. Feature Flag

The subscription system is gated behind:

```
medicine_subscriptions_enabled = false (default)
```

Registered in `feature_flags` as a standard Founder Control toggle. Both the API and the scheduler respect this flag before processing.

---

## 9. File Summary

| File | Type | Purpose |
|------|------|---------|
| `migrations/layer16-medicine-subscriptions.js` | Migration | Schema extensions |
| `src/routes/subscriptions.js` | Route | CRUD API for subscriptions |
| `src/services/subscriptionOrderService.js` | Service | Subscription-specific order generation logic |
| `src/workers/subscription-scheduler.js` | Worker | Background scheduler (PM2 / cron) |
| `tests/phase16.test.js` | Test | Integration tests |
