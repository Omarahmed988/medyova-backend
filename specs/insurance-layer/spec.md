# Insurance MVP Layer — Specification

> **Status**: v1 — Awaiting Architectural Review  
> **Layer**: 5 (Insurance Routing Gate)  
> **Depends on**: Layer 1 (pharmacies, users), Layer 2 (requests), Layer 3 (routing engine)

---

## 1. Purpose

This specification defines a **simplified insurance routing layer** for Medyova. It enables users to associate an insurance profile with their requests. When a request has insurance, the routing engine filters pharmacies to only those with active contracts with the user's insurance company. This layer does **not** implement claim processing, coverage calculation, or approval validation. The pharmacy remains solely responsible for insurance verification.

---

## 2. Database Schema

### 2.1 `insurance_companies` Table

| Column | Type | Constraints | Notes |
|--------|------|------------|-------|
| `id` | `UUID` | PK, DEFAULT `gen_random_uuid()` | |
| `name` | `VARCHAR(255)` | NOT NULL, UNIQUE | Company display name |
| `code` | `VARCHAR(50)` | NOT NULL, UNIQUE | Short code for API use (e.g., `'BUPA_SA'`) |
| `is_active` | `BOOLEAN` | NOT NULL, DEFAULT `true` | Soft-disable without deletion |
| `created_at` | `TIMESTAMPTZ` | NOT NULL, DEFAULT `now()` | |
| `updated_at` | `TIMESTAMPTZ` | NOT NULL, DEFAULT `now()` | |

### 2.2 `user_insurance_profiles` Table

| Column | Type | Constraints | Notes |
|--------|------|------------|-------|
| `id` | `UUID` | PK, DEFAULT `gen_random_uuid()` | |
| `user_id` | `UUID` | NOT NULL, FK → `users(id)` | Profile owner |
| `insurance_company_id` | `UUID` | NOT NULL, FK → `insurance_companies(id)` | |
| `member_id` | `VARCHAR(100)` | NOT NULL | Insurance member/policy number |
| `id_document_url` | `TEXT` | NULLABLE | URL to uploaded national ID scan |
| `card_document_url` | `TEXT` | NULLABLE | URL to uploaded insurance card scan |
| `is_verified` | `BOOLEAN` | NOT NULL, DEFAULT `false` | Future: admin verification flag |
| `is_active` | `BOOLEAN` | NOT NULL, DEFAULT `true` | User can deactivate without deleting |
| `created_at` | `TIMESTAMPTZ` | NOT NULL, DEFAULT `now()` | |
| `updated_at` | `TIMESTAMPTZ` | NOT NULL, DEFAULT `now()` | |

**Constraints:**
- UNIQUE on (`user_id`, `insurance_company_id`) — one profile per company per user

### 2.3 `pharmacy_insurance_contracts` Table

| Column | Type | Constraints | Notes |
|--------|------|------------|-------|
| `id` | `UUID` | PK, DEFAULT `gen_random_uuid()` | |
| `pharmacy_id` | `UUID` | NOT NULL, FK → `pharmacies(id)` | |
| `insurance_company_id` | `UUID` | NOT NULL, FK → `insurance_companies(id)` | |
| `is_active` | `BOOLEAN` | NOT NULL, DEFAULT `true` | Contract can be deactivated |
| `created_at` | `TIMESTAMPTZ` | NOT NULL, DEFAULT `now()` | |
| `updated_at` | `TIMESTAMPTZ` | NOT NULL, DEFAULT `now()` | |

**Constraints:**
- UNIQUE on (`pharmacy_id`, `insurance_company_id`) — one contract per pair

### 2.4 `requests` Table Modification

**Add column:**

| Column | Type | Constraints | Notes |
|--------|------|------------|-------|
| `insurance_profile_id` | `UUID` | NULLABLE, FK → `user_insurance_profiles(id)` | If set, triggers insurance-filtered routing |

**No other columns changed. No state transitions changed. No enum changes.**

### 2.5 Indexes

| Table | Index | Columns | Purpose |
|-------|-------|---------|---------|
| `insurance_companies` | UNIQUE | `name` | Prevent duplicates |
| `insurance_companies` | UNIQUE | `code` | API lookup |
| `user_insurance_profiles` | IDX | `user_id` | User profile lookup |
| `user_insurance_profiles` | UNIQUE | `(user_id, insurance_company_id)` | One per pair |
| `pharmacy_insurance_contracts` | IDX | `pharmacy_id` | Pharmacy lookup |
| `pharmacy_insurance_contracts` | IDX | `insurance_company_id` | Company lookup |
| `pharmacy_insurance_contracts` | UNIQUE | `(pharmacy_id, insurance_company_id)` | One per pair |
| `pharmacy_insurance_contracts` | IDX | `(insurance_company_id, is_active)` | Routing filter query |
| `requests` | IDX | `insurance_profile_id` | Optional filter |

---

## 3. Routing Modification

### 3.1 Insurance-Filtered Routing

The **only** change to the routing engine is an additional filter in the pharmacy selection query.

**Current routing query** (simplified):
```sql
SELECT p.id FROM pharmacies p
WHERE p.zone_id = $zoneId
  AND p.is_active = true
  AND p.tier_id = $tierId
  -- ... existing filters
```

**Modified routing query** when `request.insurance_profile_id IS NOT NULL`:
```sql
SELECT p.id FROM pharmacies p
WHERE p.zone_id = $zoneId
  AND p.is_active = true
  AND p.tier_id = $tierId
  AND p.id IN (
      SELECT pic.pharmacy_id
      FROM pharmacy_insurance_contracts pic
      JOIN user_insurance_profiles uip ON uip.insurance_company_id = pic.insurance_company_id
      WHERE uip.id = $insuranceProfileId
        AND pic.is_active = true
        AND uip.is_active = true
  )
  -- ... existing filters unchanged
```

**When `request.insurance_profile_id IS NULL`**: no change to routing query at all.

### 3.2 Implementation Strategy

The routing worker reads `request.insurance_profile_id`. If non-null, it passes it as a parameter to the pharmacy selection query. The filter is applied as an additional `AND` clause — an **additive filter**, not a replacement.

```
if request.insurance_profile_id IS NOT NULL:
    add insurance contract filter to pharmacy query
else:
    standard routing (unchanged)
```

### 3.3 Edge Case: No Insured Pharmacies

If insurance filtering results in zero eligible pharmacies for a tier:

- The routing engine treats this identically to zero pharmacies in any tier: **skip tier, escalate to next**
- If all tiers exhausted with zero pharmacies: request follows existing expiration logic
- No special error code — the user sees the standard flow

---

## 4. What This Layer Does NOT Do

| Feature | Status | Rationale |
|---------|--------|-----------|
| **Approval validation** | ❌ Not implemented | Pharmacy responsibility |
| **Claims engine** | ❌ Not implemented | Out of scope for MVP |
| **Coverage calculation** | ❌ Not implemented | Pharmacy validates independently |
| **Co-pay computation** | ❌ Not implemented | Pharmacy sets price in offer |
| **Real-time insurance API** | ❌ Not implemented | No external integrations |
| **Insurance company portal** | ❌ Not implemented | Admin-managed data only |

---

## 5. Offer & Acceptance Impact

### 5.1 Offers

When a request has `insurance_profile_id`, the pharmacy knows the request involves insurance (the profile info can be included in the offer request context). The pharmacy sets:

- `total_price` — which may reflect insurance pricing
- `delivery_fee` — unchanged

**No new offer columns.** The offer model remains identical. The pharmacy decides pricing; Medyova does not calculate insurance discounts.

### 5.2 Acceptance & Orders

**Zero changes to acceptance transaction.** The 8-step atomic transaction remains identical. The `orders` table gets its price from the offer, which the pharmacy already adjusted for insurance.

**No `insurance_profile_id` on orders.** Traceability flows through: `orders.request_id → requests.insurance_profile_id`.

---

## 6. Invariants

| ID | Invariant | Enforcement |
|----|-----------|-------------|
| **I-1** | Insurance filtering is additive, not replacement | Routing query adds `AND`, does not replace existing `WHERE` |
| **I-2** | Null `insurance_profile_id` = standard routing | `IF NULL` guard in routing worker |
| **I-3** | One insurance profile per company per user | UNIQUE constraint on `(user_id, insurance_company_id)` |
| **I-4** | One contract per pharmacy-company pair | UNIQUE constraint on `(pharmacy_id, insurance_company_id)` |
| **I-5** | No acceptance transaction changes | Step 1–8 remain identical |
| **I-6** | No order schema changes | Orders reference requests, which reference insurance profiles |
| **I-7** | Inactive profiles/contracts excluded from routing | `WHERE is_active = true` in filter |

---

## 7. Legal Constraints

> [!CAUTION]
> **Medyova is not an insurance processor, claims administrator, or coverage validator.**

### 7.1 Medyova's Role

| Responsibility | Owner |
|---------------|-------|
| Storing user's insurance profile (member ID, card image) | **Medyova** — as data custodian only |
| Routing requests to pharmacies with matching contracts | **Medyova** — as routing filter only |
| Verifying insurance eligibility | **Pharmacy** — must validate independently |
| Approving insurance claims | **Insurance Company** — not Medyova |
| Determining co-pay amounts | **Pharmacy + Insurance Company** |
| Setting offer prices | **Pharmacy** — reflects their insurance arrangement |

### 7.2 Explicit Disclaimers (must appear in user-facing documentation)

1. **Medyova does not guarantee insurance coverage.** The presence of an insurance profile does not mean the user's prescription is covered.
2. **The pharmacy is responsible for insurance verification.** Medyova transmits the user's insurance information but does not validate eligibility.
3. **The user must present original documents upon delivery.** Digital copies are for routing purposes only. Pharmacies may require physical ID and insurance card.
4. **Pricing in offers may differ from final insurance-adjusted pricing.** The pharmacy determines the final price after their own insurance validation.
5. **Medyova does not process insurance claims.** Claim submission is between the pharmacy and the insurance company.

### 7.3 Data Privacy

| Data | Storage | Access |
|------|---------|--------|
| Insurance member ID | Encrypted at rest (future) | User, admin |
| ID document URL | Private storage (signed URLs, future) | User, admin, pharmacy (on accepted order) |
| Card document URL | Private storage (signed URLs, future) | User, admin, pharmacy (on accepted order) |

> [!IMPORTANT]
> Document URLs should be served via signed, time-limited URLs in production. For MVP, they are stored as plain URLs. Document security hardening is a Phase 10+ concern.

---

## 8. Implementation Impact

### 8.1 Required Changes

| Component | Change |
|-----------|--------|
| `migrations/` (new) | `insurance_companies`, `user_insurance_profiles`, `pharmacy_insurance_contracts` tables + `requests.insurance_profile_id` column |
| `src/workers/routing-worker.js` (modify) | Add insurance filter to pharmacy selection query |
| `src/routes/insurance.js` (new) | Insurance CRUD API (companies, profiles, contracts) |
| `src/services/insuranceService.js` (new) | Insurance profile management |
| `tests/` (new) | Insurance routing filter tests |

### 8.2 No Changes Required

| Component | Reason |
|-----------|--------|
| `src/services/offerAcceptance.js` | Acceptance unchanged (I-5) |
| `src/services/orderService.js` | Order lifecycle unchanged (I-6) |
| `src/routes/offers.js` | Offer visibility unchanged |
| `src/workers/order-sla-sweep.js` | SLA sweep unchanged |
| `src/services/offerSelection.js` | Selection ranking unchanged |

---

## 9. Open Questions

1. Should the insurance profile information (member_id, company name) be included in the payload sent to pharmacies when they receive a routing wave, or should they query it separately?
2. Should there be an admin API for managing `insurance_companies` and `pharmacy_insurance_contracts`, or is this seed-data-only for MVP?
3. Should the `user_insurance_profiles.is_verified` flag gate routing (i.e., only verified profiles trigger insurance routing)?
