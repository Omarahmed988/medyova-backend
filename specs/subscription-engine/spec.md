# Subscription Engine — Specification

> **Status**: v2 — Approved (Revised per Architectural Feedback)  
> **Layer**: 5 (Subscription Management)  
> **Depends on**: Layer 1 (users, zones), Layer 2 (requests, request_items), Layer 3 (routing engine)

---

## 1. Purpose

This specification defines a **Chronic Subscription Engine** that enables users with recurring medication needs to automate their request cycle. Subscriptions generate standard `requests` on a configurable schedule, which then flow through the existing routing engine unchanged. The subscription layer is a convenience wrapper — it never bypasses routing, offer selection, or acceptance.

---

## 2. Database Schema

### 2.1 `subscriptions` Table

| Column | Type | Constraints | Notes |
|--------|------|------------|-------|
| `id` | `UUID` | PK, DEFAULT `gen_random_uuid()` | |
| `user_id` | `UUID` | NOT NULL, FK → `users(id)` | Owner of the subscription |
| `insurance_profile_id` | `UUID` | NULLABLE, FK → `user_insurance_profiles(id)` | If user has insurance (Phase 9 integration point) |
| `zone_id` | `UUID` | NOT NULL, FK → `zones(id)` | Delivery zone for generated requests |
| `contact_phone` | `VARCHAR(20)` | NOT NULL | Copied to generated requests |
| `preferred_day_of_month` | `INTEGER` | NOT NULL, CHECK `1–28` | Day of month to generate request. Capped at 28 to avoid month-length issues. |
| `next_run_at` | `TIMESTAMPTZ` | NOT NULL | Next scheduled request creation |
| `last_run_at` | `TIMESTAMPTZ` | NULLABLE | Last successful request creation |
| `last_request_id` | `UUID` | NULLABLE, FK → `requests(id)` | Last generated request for traceability |
| `precheck_offset_days` | `INTEGER` | NOT NULL, DEFAULT `2` | Days before `next_run_at` to run availability pre-check |
| `precheck_status` | `VARCHAR(20)` | DEFAULT `'none'` | `'none'`, `'passed'`, `'failed'` |
| `precheck_ran_at` | `TIMESTAMPTZ` | NULLABLE | When last pre-check was executed |
| `is_active` | `BOOLEAN` | NOT NULL, DEFAULT `true` | Can be deactivated without deletion |
| `notes` | `TEXT` | NULLABLE | User notes copied to generated requests |
| `prescription_url` | `TEXT` | NULLABLE | Recurring prescription image URL |
| `created_at` | `TIMESTAMPTZ` | NOT NULL, DEFAULT `now()` | |
| `updated_at` | `TIMESTAMPTZ` | NOT NULL, DEFAULT `now()` | |

### 2.2 `subscription_items` Table

| Column | Type | Constraints | Notes |
|--------|------|------------|-------|
| `id` | `UUID` | PK, DEFAULT `gen_random_uuid()` | |
| `subscription_id` | `UUID` | NOT NULL, FK → `subscriptions(id)`, ON DELETE CASCADE | |
| `product_name` | `VARCHAR(255)` | NOT NULL | Mirrors `request_items.product_name` |
| `quantity` | `INTEGER` | NOT NULL, CHECK `> 0`, DEFAULT `1` | Mirrors `request_items.quantity` |
| `is_substitution_allowed` | `BOOLEAN` | NOT NULL, DEFAULT `true` | Mirrors `request_items.is_substitution_allowed` |
| `created_at` | `TIMESTAMPTZ` | NOT NULL, DEFAULT `now()` | |
| `updated_at` | `TIMESTAMPTZ` | NOT NULL, DEFAULT `now()` | |

### 2.3 Indexes

| Table | Index | Columns | Purpose |
|-------|-------|---------|---------|
| `subscriptions` | IDX | `user_id` | User lookup |
| `subscriptions` | IDX | `next_run_at, is_active` | Sweep query |
| `subscriptions` | IDX | `is_active` | Status filtering |
| `subscription_items` | IDX | `subscription_id` | Item lookup |

---

## 3. Subscription Lifecycle

### 3.1 Creation

A subscription is created via API. The user provides:

- `zone_id`, `contact_phone`
- `preferred_day_of_month` (1–28)
- `items[]` (product_name, quantity, is_substitution_allowed)
- Optional: `prescription_url`, `notes`, `insurance_profile_id`

The system computes `next_run_at`:

```
If today's day < preferred_day_of_month:
    next_run_at = this month on preferred_day_of_month at 08:00 local
Else:
    next_run_at = next month on preferred_day_of_month at 08:00 local
```

### 3.2 Pre-Check Phase

**Trigger**: `next_run_at - precheck_offset_days` (default: 2 days before)

**What it does**:
1. Query pharmacies in the subscription's `zone_id` that are `is_active = true`
2. Check that at least 1 pharmacy exists in the zone
3. If `insurance_profile_id` is set, check at least 1 pharmacy has an active insurance contract (Phase 9)
4. Update `precheck_status` to `'passed'` or `'failed'`
5. Update `precheck_ran_at`
6. If `precheck_status = 'failed'`, call notification stub (no external integration yet)

**What it does NOT do**:
- No offer creation
- No routing job creation
- No request creation
- No price checking

> [!NOTE]
> Pre-check is advisory only. A failed pre-check does NOT prevent request creation. It exists to allow the user to be notified early if their zone has no active pharmacies.

### 3.3 Request Generation Phase

**Trigger**: `next_run_at` (on or after the scheduled time)

**Process**:
1. Verify `subscription.is_active = true`
2. **Insurance guard**: If `subscription.insurance_profile_id IS NOT NULL`, check that the referenced `user_insurance_profiles.is_active = true`. If inactive → skip generation, log warning, do not advance `next_run_at`.
3. Create a new `requests` row **directly as broadcasted** (no draft step):
   - `user_id` = subscription.user_id
   - `zone_id` = subscription.zone_id
   - `contact_phone` = subscription.contact_phone
   - `state` = `'broadcasted'`
   - `broadcasted_at` = `now()`
   - `type` = `'standard'`
   - `insurance_profile_id` = subscription.insurance_profile_id (Phase 9)
   - `prescription_url` = subscription.prescription_url
   - `notes` = subscription.notes
4. Copy all `subscription_items` → `request_items` for the new request
5. Update subscription:
   - `last_run_at` = now()
   - `last_request_id` = new request ID
   - `next_run_at` = compute next month (same day)
   - `precheck_status` = `'none'` (reset for next cycle)

### 3.4 `next_run_at` Computation

```
next_run_at = first occurrence of preferred_day_of_month
              in the month AFTER last_run_at
              at 08:00 local time
```

If `preferred_day_of_month` = 28, then every month runs on the 28th. No February edge cases since max is 28.

---

## 4. Sweep Worker

### 4.1 `subscription-sweep.js`

Two sweep functions, run on configurable intervals:

| Sweep | Query | Action |
|-------|-------|--------|
| Pre-check sweep | `WHERE is_active AND next_run_at - interval 'N days' <= now() AND precheck_status = 'none'` | Run pre-check, update status |
| Request generation sweep | `WHERE is_active AND next_run_at <= now()` | Create request + items, advance `next_run_at` |

Both use `FOR UPDATE SKIP LOCKED` for concurrency safety.

### 4.2 Idempotency

The request generation sweep must be idempotent:

- If `last_run_at` is within the current cycle window, skip (prevents duplicate requests on crash recovery)
- Guard: `WHERE is_active AND next_run_at <= now() AND (last_run_at IS NULL OR last_run_at < next_run_at - interval '1 day')`

---

## 5. Integration with Existing Engine

### 5.1 Routing Reuse

```
subscription sweep → creates request → routing engine picks it up
                                         ↓
                                    normal wave/tier escalation
                                         ↓
                                    offers presented to user
                                         ↓
                                    user accepts (or not)
                                         ↓
                                    order lifecycle (Phase 7)
```

**No special routing path.** Subscription-generated requests are indistinguishable from manually-created requests in the routing layer.

### 5.2 No Bypass

| Component | Modified? | Reason |
|-----------|-----------|--------|
| Routing worker | ❌ No | Standard request handling |
| Offer selection | ❌ No | Standard selection |
| Acceptance transaction | ❌ No | Standard 8-step tx |
| Order lifecycle | ❌ No | Standard order flow |

---

## 6. Invariants

| ID | Invariant | Enforcement |
|----|-----------|-------------|
| **S-1** | Subscription generates standard requests only | `type = 'standard'` hardcoded in generation |
| **S-2** | No direct order creation from subscription | Request must go through routing → offers → acceptance |
| **S-3** | `preferred_day_of_month` ∈ [1, 28] | CHECK constraint |
| **S-4** | Pre-check does not create offers or requests | Application-level: pre-check is read-only |
| **S-5** | Deactivated subscriptions produce no requests | `WHERE is_active = true` in sweep |
| **S-6** | No duplicate requests per cycle | Idempotency guard on `last_run_at` |

---

## 7. Legal Boundary

> [!CAUTION]
> **Medyova is not a pharmacy and does not dispense medications.**

| Concern | Position |
|---------|----------|
| Prescription validation | **Pharmacy responsibility.** Medyova transmits the prescription image. Pharmacy must validate independently. |
| Drug interaction checks | **Pharmacy responsibility.** Medyova does not perform clinical validation. |
| Refill authorization | **Pharmacy responsibility.** Recurring subscriptions do not imply automatic refill authorization. Pharmacies must verify prescription validity on each request. |
| Substitution decisions | **Pharmacy responsibility.** The `is_substitution_allowed` flag is a user preference, not a clinical directive. |
| Auto-generation disclaimer | Subscriptions auto-generate requests. The user may cancel at any time. Medyova does not guarantee availability or pricing. |

---

## 8. Implementation Impact

### 8.1 Required Changes

| Component | Change |
|-----------|--------|
| `migrations/` (new) | Create `subscriptions` + `subscription_items` tables |
| `src/services/subscriptionService.js` (new) | CRUD, pre-check, request generation |
| `src/workers/subscription-sweep.js` (new) | Pre-check + request generation sweeps |
| `src/routes/subscriptions.js` (new) | Subscription CRUD API |
| `tests/` (new) | Subscription lifecycle tests |

### 8.2 No Changes Required

| Component | Reason |
|-----------|--------|
| `src/workers/routing-worker.js` | Handles generated requests normally |
| `src/services/offerAcceptance.js` | Unaffected |
| `src/services/orderService.js` | Unaffected |
| `src/routes/offers.js` | Unaffected |

---

## 9. Resolved Questions

| # | Question | Resolution |
|---|----------|------------|
| 1 | Pre-check notification? | **Yes.** Notification stub called on failure (no external integration yet). |
| 2 | Store `last_request_id`? | **Yes.** Added as nullable FK for traceability. |
| 3 | Max retries? | **Deferred.** Not needed for v1 — sweep naturally retries on next interval. |
