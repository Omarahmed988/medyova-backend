# MEDYOVA — PHASE 18: INSURANCE ORDER FLOW + SUBSCRIPTION INHERITANCE + PATIENT PROFILES

## Context

Phase 17 introduced the Insurance Pharmacy Filter (discovery only).

Phase 18 extends the platform with a full **Insurance Order Flow**, **Subscription Inheritance**, and **Patient Profiles (Family Accounts)**, while preserving the strict architectural boundary:

> **Medyova does NOT process insurance claims.**
> The pharmacy remains fully responsible for insurance approval, claim submission, dispensing, and delivery fulfillment.

---

## Supported Order Flows

| Flow | Description | Order Type |
|------|-------------|------------|
| **Flow A** | Prescription Routing (marketplace) | `prescription` |
| **Flow B** | Medicine Search → Direct Order | `direct` |
| **Flow C** | Insurance Order | `insurance` |
| **Flow D** | Subscriptions (inherits original flow) | Inherited from originating order |

---

## Feature A — Patient Profiles (Family Accounts)

Users may order medicines not only for themselves but for family members (e.g., a son ordering for his father, a mother ordering for her child).

A single user account may manage multiple **patient identities**.

### `patient_profiles` [NEW]

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| `id` | UUID | PK | Profile identifier |
| `user_id` | UUID | FK → users(id), NOT NULL | Account owner |
| `name` | VARCHAR(100) | NOT NULL | Patient display name |
| `date_of_birth` | DATE | NULLABLE | Patient DOB |
| `phone` | VARCHAR(20) | NULLABLE | Contact phone |
| `national_id` | VARCHAR(50) | NULLABLE | National ID number |
| `insurance_profile_id` | UUID | FK → user_insurance_profiles(id), NULLABLE | Linked insurance |
| `default_address_id` | UUID | NULLABLE | Default delivery address |
| `created_at` | TIMESTAMPTZ | DEFAULT NOW() | |
| `updated_at` | TIMESTAMPTZ | DEFAULT NOW() | |

- `CREATE INDEX idx_patient_profiles_user ON patient_profiles (user_id);`

### API Endpoints

- `GET /patients` — List profiles for authenticated user.
- `POST /patients` — Create a new patient profile.
- `PATCH /patients/:id` — Update profile fields.
- `DELETE /patients/:id` — Remove a profile.

All endpoints enforce ownership (`user_id = req.user.id`).

### UX Flow

Before placing any order, the user selects:

```
Order for:
  • Myself
  • Father
  • Mother
```

The selected patient profile determines:
- Insurance validation (via `patient_profiles.insurance_profile_id`)
- Subscription ownership
- Delivery address defaults

---

## Feature B — Insurance Order Flow

Users can explicitly order medicines using their insurance coverage.

### User Flow

1. User selects **"Use My Insurance"** and chooses a patient profile.
2. System shows pharmacies that accept the patient's insurance company (Phase 17 filter).
3. User uploads prescription or insurance approval documents.
4. User places an **Insurance Order** (`orders.type = 'insurance'`).

### Endpoint

```
POST /orders/insurance
```

### Request Body

```json
{
  "pharmacy_id": "UUID",
  "area_id": "UUID",
  "patient_profile_id": "UUID",
  "items": [{ "medicine_id": "UUID", "quantity": 1 }],
  "prescription_image_url": "string (optional)",
  "insurance_approval_image_url": "string (optional)"
}
```

### Flow Steps

1. **Feature flag gate** — `insurance_orders_enabled` must be `true`. Fail closed `503`.
2. **Resolve patient context** — Load `patient_profiles` by `patient_profile_id` + `req.user.id`. Return `404` if not found or not owned.
3. **Resolve insurance context** — Load `user_insurance_profiles` via `patient_profiles.insurance_profile_id`. Extract `insurance_company_id`. Return `422` if patient has no linked insurance.
4. **Pharmacy eligibility** — Validate pharmacy is active, serves area, has active insurance contract.
5. **Item validation** — Check medicine exists/active, enforce `max_order_qty`, verify inventory, snapshot `price`.
6. **Create order** — Insert with `type = 'insurance'`, `user_id`, `patient_profile_id`, `insurance_company_id`, `insurance_profile_id`.
7. **Create order items** — Insert with `price_snapshot`.
8. **Create insurance documents** — Insert into `insurance_documents` if URLs provided.
9. **Return** — `201` with `{ data: { id, type, status, total_price, created_at } }`.

### Service

New `InsuranceOrderService` at `src/services/insuranceOrderService.js`. Mirrors `DirectOrderService` but enforces mandatory insurance + patient context. Does **not** modify `DirectOrderService`.

---

## Feature C — Subscription Activation After Order

After a successful order, the user may activate a subscription.

### UX

```
✅ Order Complete
┌─────────────────────────────┐
│ Repeat this order monthly   │
│            [ ON / OFF ]     │
└─────────────────────────────┘
```

### Inheritance Rule

**Subscriptions inherit the order type from the original order.**

| Original Order Type | Subscription Type |
|---------------------|-------------------|
| `direct` | `medicine` |
| `insurance` | `insurance` |

Insurance subscriptions inherit `insurance_company_id`, `insurance_profile_id`, and `patient_profile_id`.

### Endpoint

```
POST /subscriptions/from-order
```

```json
{
  "order_id": "UUID",
  "frequency_days": 30
}
```

Backend resolves pharmacy, area, items, patient, and insurance context from the completed order.

---

## Feature D — Pharmacy Locking

`subscriptions.pharmacy_id` locks the subscription to the original pharmacy. Subscriptions must **not** dynamically switch pharmacies. The locked pharmacy is validated each cycle.

---

## Feature E — Subscription Scheduler Behavior

Scheduler core batch logic (`FOR UPDATE SKIP LOCKED`, batch 25) remains **unchanged**.

`SubscriptionOrderService.processSubscription` gains a conditional branch:

```
if (sub.type === 'insurance') {
    → insurance contract check
    → delegate to InsuranceOrderService.createInsuranceOrder
} else {
    → existing DirectOrderService.createDirectOrder (unchanged)
}
```

Insurance subscription safety checks before each cycle:
1. Pharmacy is active.
2. Pharmacy still accepts the subscription's `insurance_company_id`.
3. All medicines are in stock.
4. Pharmacy serves the delivery area.

Fail → pause with descriptive `pause_reason`.

---

## Data Model Summary

### `user_insurance_profiles` [NEW]

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| `id` | UUID | PK | Profile identifier |
| `user_id` | UUID | FK → users(id), NOT NULL | Owning patient |
| `insurance_company_id` | UUID | FK → insurance_companies(id), NOT NULL | Selected insurer |
| `insurance_card_number` | VARCHAR(100) | NOT NULL | Card/member number |
| `insurance_card_image_url` | TEXT | NULLABLE | Card image |
| `national_id_image_url` | TEXT | NULLABLE | National ID image |
| `created_at` | TIMESTAMPTZ | DEFAULT NOW() | |
| `updated_at` | TIMESTAMPTZ | DEFAULT NOW() | |

- `UNIQUE (user_id, insurance_company_id)`
- `CREATE INDEX idx_user_insurance_profiles_user ON user_insurance_profiles (user_id);`

**API:** `GET/POST/PATCH/DELETE /user/insurance-profiles`

### `insurance_documents` [NEW]

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| `id` | UUID | PK | Document identifier |
| `order_id` | UUID | FK → orders(id), NOT NULL | Associated order |
| `prescription_image_url` | TEXT | NULLABLE | Prescription image |
| `insurance_approval_image_url` | TEXT | NULLABLE | Approval document |
| `created_at` | TIMESTAMPTZ | DEFAULT NOW() | |

- `CREATE INDEX idx_insurance_documents_order ON insurance_documents (order_id);`

### `orders` table extensions

| Column | Type | Description |
|--------|------|-------------|
| `insurance_profile_id` | UUID, FK → user_insurance_profiles(id), NULLABLE | Insurance profile |
| `patient_profile_id` | UUID, FK → patient_profiles(id), NULLABLE | Actual patient |

> `insurance_company_id` already exists from Phase 17.

Allowed types: `prescription | direct | insurance`

### `subscriptions` table extensions

| Column | Type | Description |
|--------|------|-------------|
| `insurance_company_id` | UUID, FK, NULLABLE | Insurance context |
| `insurance_profile_id` | UUID, FK, NULLABLE | Insurance profile |
| `patient_profile_id` | UUID, FK → patient_profiles(id), NULLABLE | Patient identity |

---

## Feature Flags

| Flag | Default | Behavior |
|------|---------|----------|
| `insurance_orders_enabled` | `false` | Gates `POST /orders/insurance`. Fail closed `503`. |
| `insurance_subscriptions_enabled` | `false` | Gates insurance subscription creation + scheduler. |

---

## Architectural Invariants

Phase 18 does **NOT** modify:

| Component | Status |
|-----------|--------|
| `routing-worker.js` | **Untouched** |
| `offerAcceptance.js` | **Untouched** |
| `queryEligiblePharmacies` | **Untouched** |
| `DirectOrderService.createDirectOrder` | **Untouched** |
| `subscription-scheduler.js` core batch logic | **Untouched** |

Patient profiles operate purely as an **identity abstraction layer**.
Insurance orders operate entirely through **Flow B architecture**.
Flow A remains completely isolated.

---

## File Summary

| File | Action |
|------|--------|
| `migrations/1776000000000_layer18-insurance-orders.js` | [NEW] Schema migration |
| `src/services/insuranceOrderService.js` | [NEW] Insurance order creation |
| `src/routes/insuranceOrders.js` | [NEW] `POST /orders/insurance` |
| `src/routes/userInsuranceProfiles.js` | [NEW] CRUD insurance profiles |
| `src/routes/patients.js` | [NEW] CRUD patient profiles |
| `src/services/subscriptionOrderService.js` | [MODIFY] Insurance branch |
| `src/routes/subscriptions.js` | [MODIFY] `POST /subscriptions/from-order` + insurance context |
| `src/app.js` | [MODIFY] Mount new routes |
| `tests/phase18.test.js` | [NEW] Integration tests |
