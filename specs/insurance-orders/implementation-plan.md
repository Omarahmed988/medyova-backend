# Phase 18 — Implementation Plan

## Overview

Implement the Insurance Order Flow, Patient Profiles, and Subscription Inheritance as defined in the approved [spec](file:///d:/Our%20Project/medyova-backend/specs/insurance-orders/spec.md).

---

## Step 1 — Schema Migration

#### [NEW] [1776000000000_layer18-insurance-orders.js](file:///d:/Our%20Project/medyova-backend/migrations/1776000000000_layer18-insurance-orders.js)

Creates tables and extends existing ones in dependency order:

**1a. `patient_profiles`**
```sql
CREATE TABLE patient_profiles (
  id UUID PK DEFAULT gen_random_uuid(),
  user_id UUID FK → users(id) NOT NULL,
  name VARCHAR(100) NOT NULL,
  date_of_birth DATE,
  phone VARCHAR(20),
  national_id VARCHAR(50),
  insurance_profile_id UUID FK → user_insurance_profiles(id),
  default_address_id UUID,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
INDEX idx_patient_profiles_user (user_id)
```

**1b. `user_insurance_profiles`**
```sql
CREATE TABLE user_insurance_profiles (
  id UUID PK DEFAULT gen_random_uuid(),
  user_id UUID FK → users(id) NOT NULL,
  insurance_company_id UUID FK → insurance_companies(id) NOT NULL,
  insurance_card_number VARCHAR(100) NOT NULL,
  insurance_card_image_url TEXT,
  national_id_image_url TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
UNIQUE (user_id, insurance_company_id)
INDEX idx_user_insurance_profiles_user (user_id)
```

> Note: `user_insurance_profiles` must be created before `patient_profiles` due to the FK dependency.

**1c. `orders` extensions**
```sql
ALTER TABLE orders ADD insurance_profile_id UUID FK → user_insurance_profiles(id);
ALTER TABLE orders ADD patient_profile_id UUID FK → patient_profiles(id);
```

**1d. `insurance_documents`**
```sql
CREATE TABLE insurance_documents (
  id UUID PK DEFAULT gen_random_uuid(),
  order_id UUID FK → orders(id) NOT NULL,
  prescription_image_url TEXT,
  insurance_approval_image_url TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
INDEX idx_insurance_documents_order (order_id)
```

**1e. `subscriptions` extensions**
```sql
ALTER TABLE subscriptions ADD insurance_company_id UUID FK → insurance_companies(id);
ALTER TABLE subscriptions ADD insurance_profile_id UUID FK → user_insurance_profiles(id);
ALTER TABLE subscriptions ADD patient_profile_id UUID FK → patient_profiles(id);
```

---

## Step 2 — Patient Profiles API

#### [NEW] [patients.js](file:///d:/Our%20Project/medyova-backend/src/routes/patients.js)

CRUD endpoints for patient profiles. All require `requireAuth`.

| Method | Route | Behavior |
|--------|-------|----------|
| `GET` | `/patients` | List profiles for `req.user.id` |
| `POST` | `/patients` | Create profile (validate `insurance_profile_id` ownership if provided) |
| `PATCH` | `/patients/:id` | Update fields (name, DOB, phone, national ID, insurance link) |
| `DELETE` | `/patients/:id` | Delete (only if no active subscriptions reference it) |

Validation:
- UUID format for IDs
- Ownership check: `patient_profiles.user_id = req.user.id`
- If `insurance_profile_id` provided, verify it belongs to `req.user.id`

#### [MODIFY] [app.js](file:///d:/Our%20Project/medyova-backend/src/app.js)

Mount: `app.use('/patients', requireDb, requireAuth, patientsRouter);`

---

## Step 3 — User Insurance Profiles API

#### [NEW] [userInsuranceProfiles.js](file:///d:/Our%20Project/medyova-backend/src/routes/userInsuranceProfiles.js)

| Method | Route | Behavior |
|--------|-------|----------|
| `GET` | `/user/insurance-profiles` | List for `req.user.id` |
| `POST` | `/user/insurance-profiles` | Create (validate `insurance_company_id` exists) |
| `PATCH` | `/user/insurance-profiles/:id` | Update card number / image URLs |
| `DELETE` | `/user/insurance-profiles/:id` | Remove (only if no active orders/subscriptions reference it) |

Validation:
- `UNIQUE (user_id, insurance_company_id)` enforced at DB level, return `409` on conflict
- Ownership check on all mutations

#### [MODIFY] [app.js](file:///d:/Our%20Project/medyova-backend/src/app.js)

Mount: `app.use('/user', requireDb, requireAuth, userInsuranceProfilesRouter);`

---

## Step 4 — Insurance Order Service

#### [NEW] [insuranceOrderService.js](file:///d:/Our%20Project/medyova-backend/src/services/insuranceOrderService.js)

Static method: `createInsuranceOrder(userId, pharmacyId, areaId, patientProfileId, items, docUrls)`

Flow (mirrors `DirectOrderService` structure):

1. **Feature flag** — `settingsCache.getFlag('insurance_orders_enabled')`. Return `503` if disabled.
2. **Resolve patient** — Load `patient_profiles` by ID + `userId`. Extract `insurance_profile_id`. Return `404` / `422`.
3. **Resolve insurance** — Load `user_insurance_profiles` by `insurance_profile_id`. Extract `insurance_company_id`.
4. **Pharmacy + area check** — Same pattern as `DirectOrderService` step 1.
5. **Insurance contract check** — Same pattern as `DirectOrderService` step 1.5 but **mandatory** (not optional).
6. **Item validation loop** — Medicine active, `max_order_qty`, inventory stock, price snapshot.
7. **Insert order** — `type = 'insurance'`, include `insurance_company_id`, `insurance_profile_id`, `patient_profile_id`.
8. **Insert order items** — `price_snapshot` per item.
9. **Insert insurance documents** — If `prescription_image_url` or `insurance_approval_image_url` provided.
10. **Return** — `{ id, type, status, total_price, items, created_at }`.

---

## Step 5 — Insurance Order Route

#### [NEW] [insuranceOrders.js](file:///d:/Our%20Project/medyova-backend/src/routes/insuranceOrders.js)

`POST /orders/insurance`

Request body validation:
- `pharmacy_id` — required UUID
- `area_id` — required UUID
- `patient_profile_id` — required UUID
- `items` — required non-empty array
- `prescription_image_url` — optional string
- `insurance_approval_image_url` — optional string

Delegates to `InsuranceOrderService.createInsuranceOrder`.

#### [MODIFY] [app.js](file:///d:/Our%20Project/medyova-backend/src/app.js)

Mount: `app.use('/orders', requireDb, requireAuth, insuranceOrdersRouter);`

---

## Step 6 — Subscription Inheritance

#### [MODIFY] [subscriptions.js](file:///d:/Our%20Project/medyova-backend/src/routes/subscriptions.js)

**New endpoint:** `POST /subscriptions/from-order`

Request: `{ order_id, frequency_days }`

Logic:
1. Load completed order by `order_id` + ownership check.
2. Load order items.
3. Determine subscription type: `direct` → `medicine`, `insurance` → `insurance`.
4. If `insurance`: inherit `insurance_company_id`, `insurance_profile_id`, `patient_profile_id`.
5. Feature flag check: if `type = 'insurance'`, gate on `insurance_subscriptions_enabled`.
6. Create subscription + subscription items.
7. Return subscription object.

**Modify existing `POST /subscriptions`:** Accept optional `patient_profile_id` and `insurance_profile_id`. Same inheritance logic.

**Modify `GET /subscriptions`:** Include `insurance_company_id`, `insurance_profile_id`, `patient_profile_id` in response.

---

## Step 7 — Scheduler Integration

#### [MODIFY] [subscriptionOrderService.js](file:///d:/Our%20Project/medyova-backend/src/services/subscriptionOrderService.js)

In `processSubscription(sub)`:

```javascript
// After existing pharmacy, area, idempotency, and stock checks...

if (sub.type === 'insurance') {
    // Additional: verify pharmacy still accepts insurer
    const contract = await query(
        `SELECT contract_active FROM pharmacy_insurance_contracts
         WHERE pharmacy_id = $1 AND insurance_company_id = $2`,
        [sub.pharmacy_id, sub.insurance_company_id]
    );
    if (!contract.rowCount || !contract.rows[0].contract_active) {
        await this._pauseSubscription(sub.id, 'Pharmacy no longer accepts insurance');
        return { status: 'paused', reason: 'insurance_contract_lost' };
    }

    // Delegate to InsuranceOrderService
    const order = await InsuranceOrderService.createInsuranceOrder(
        sub.user_id, sub.pharmacy_id, sub.area_id,
        sub.patient_profile_id, orderItems, {}
    );
} else {
    // Existing: delegate to DirectOrderService (unchanged)
    const order = await DirectOrderService.createDirectOrder(...);
}
```

`subscription-scheduler.js` batch logic remains **completely untouched**.

---

## Step 8 — Feature Flag Seed

Insert into `settings` table (via migration or admin API):

| key | scope | value |
|-----|-------|-------|
| `insurance_orders_enabled` | `global` | `false` |
| `insurance_subscriptions_enabled` | `global` | `false` |

---

## Verification Plan

#### [NEW] [phase18.test.js](file:///d:/Our%20Project/medyova-backend/tests/phase18.test.js)

Test groups:

1. **Patient Profiles CRUD** — Create, list, update, delete. Ownership enforcement.
2. **User Insurance Profiles CRUD** — Create with valid insurer, duplicate rejection (`409`), update, delete.
3. **Insurance Order Creation** — Happy path with valid patient + pharmacy contract. Verify `type = 'insurance'`, `patient_profile_id`, `insurance_company_id` persisted.
4. **Insurance Order Rejections** — Missing contract (`422`), inactive pharmacy (`422`), out of stock (`422`), feature flag off (`503`).
5. **Insurance Documents** — Verify documents stored when URLs provided.
6. **Subscription from Order** — Create subscription from completed direct order (type = `medicine`). Create from insurance order (type = `insurance`, inherits context).
7. **Scheduler Insurance Branch** — Process insurance subscription, verify order generated. Verify pause on lost contract.

### Run Command

```
npx jest phase18
```

After Phase 18 tests pass, run the full suite to confirm zero regressions:

```
npx jest
```
