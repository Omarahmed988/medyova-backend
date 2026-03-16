# Features 2–4 — Architecture Placeholders

**Status:** Future planning — not yet scheduled for implementation  
**Prerequisite:** Feature 1 (Medicine Search) must be implemented and approved first

---

## Feature 2 — Insurance-Aware Pharmacies

### Scope

Medyova does **NOT** process insurance claims.

Pharmacies declare which insurance providers they accept. Users can filter pharmacies by their insurance provider during medicine search.

### Existing Infrastructure

The routing engine already uses:
- `pharmacy_insurance_contracts` — links pharmacies to insurance companies
- `user_insurance_profiles` — links users to their insurance company
- Both tables already have `is_active` flags

### Architecture Plan

**No new table required.** The existing `pharmacy_insurance_contracts` table serves as `pharmacy_insurance_providers` conceptually.

**Integration point:** Add an optional `insurance_company_id` filter to `GET /medicines/search`:

```sql
-- Additional JOIN when insurance filter is active:
JOIN pharmacy_insurance_contracts pic ON pic.pharmacy_id = p.id
WHERE pic.insurance_company_id = $3
  AND pic.is_active = true
```

**Feature flag:** `insurance_filter_enabled`  
**Routing impact:** None — routing already handles insurance independently  
**Schema changes:** None

---

## Feature 3 — Monthly Medicine Subscriptions

### Scope

Chronic patients subscribe to a medicine at a specific pharmacy. The system generates monthly orders automatically.

### Planned Schema

```sql
CREATE TABLE medicine_subscriptions (
    id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id        UUID NOT NULL REFERENCES users(id),
    pharmacy_id    UUID NOT NULL REFERENCES pharmacies(id),
    medicine_id    UUID NOT NULL REFERENCES medicines(id),
    area_id        UUID NOT NULL REFERENCES areas(id),
    frequency_days INTEGER NOT NULL DEFAULT 30 CHECK (frequency_days >= 7),
    is_active      BOOLEAN NOT NULL DEFAULT true,
    next_order_at  TIMESTAMP WITH TIME ZONE NOT NULL,
    created_at     TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at     TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP
);
```

### Order Generation

A lightweight sweep worker (similar to `order-sla-sweep.js`) runs periodically:

```sql
SELECT id, user_id, pharmacy_id, medicine_id, area_id
FROM medicine_subscriptions
WHERE is_active = true
  AND next_order_at <= NOW();
```

For each row: create a `type = 'direct'` order and advance `next_order_at` by `frequency_days`.

**Price:** Uses `pharmacy_inventory.price` at fulfillment time (not subscription creation time).

**Feature flag:** `subscriptions_enabled`  
**Routing impact:** None — uses Flow B (direct order), not Flow A  
**Dependencies:** Feature 1 (medicines + pharmacy_inventory tables must exist)

---

## Feature 4 — Loyalty & Referral System

### Scope

Users accumulate points from completed orders. Points determine tier level. Referrals grant bonus points.

### Planned Schema

```sql
CREATE TABLE loyalty_accounts (
    id         UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id    UUID NOT NULL REFERENCES users(id) UNIQUE,
    points     INTEGER NOT NULL DEFAULT 0,
    tier       VARCHAR(20) NOT NULL DEFAULT 'bronze'
               CHECK (tier IN ('bronze', 'silver', 'gold')),
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE loyalty_transactions (
    id         UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    account_id UUID NOT NULL REFERENCES loyalty_accounts(id),
    order_id   UUID REFERENCES orders(id),
    points     INTEGER NOT NULL,
    type       VARCHAR(20) NOT NULL
               CHECK (type IN ('order_complete', 'referral_bonus', 'admin_adjustment')),
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE referral_codes (
    id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id     UUID NOT NULL REFERENCES users(id),
    code        VARCHAR(20) NOT NULL UNIQUE,
    uses        INTEGER NOT NULL DEFAULT 0,
    max_uses    INTEGER NOT NULL DEFAULT 10,
    is_active   BOOLEAN NOT NULL DEFAULT true,
    created_at  TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP
);
```

### Tier Thresholds (Configurable via `system_settings`)

| Tier | Points Required |
|------|----------------|
| Bronze | 0 |
| Silver | 500 |
| Gold | 2000 |

### Point Accumulation

Triggered after `orders.status = 'completed'`:
- `order_complete` → fixed points per order (configurable setting)
- `referral_bonus` → points for referrer when referred user completes first order

### Integration Points

- **Event source:** `orders` table (both `prescription` and `direct` types)
- **No modification to:** order lifecycle, acceptance transaction, or routing logic
- **Tier calculation:** Read-only query against `loyalty_accounts.points`

**Feature flags:** `loyalty_program_enabled`, `referral_program_enabled`  
**Routing impact:** None  
**Dependencies:** None beyond `orders` and `users` tables

---

## Cross-Feature Invariant Confirmations

| Invariant | Feature 2 | Feature 3 | Feature 4 |
|-----------|-----------|-----------|-----------|
| `queryEligiblePharmacies` unchanged | ✅ | ✅ | ✅ |
| Routing worker unchanged | ✅ | ✅ | ✅ |
| Acceptance transaction unchanged | ✅ | ✅ | ✅ |
| Escalation logic unchanged | ✅ | ✅ | ✅ |
| No long transactions | ✅ | ✅ | ✅ |
| No external infrastructure | ✅ | ✅ | ✅ |
| Feature flag controlled | ✅ | ✅ | ✅ |
| Fail-closed when disabled | ✅ | ✅ | ✅ |
