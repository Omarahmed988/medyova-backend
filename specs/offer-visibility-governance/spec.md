# Offer Visibility & Selection Governance — Specification

> **Status**: v2 — Final (Revised per Architectural Feedback)  
> **Layer**: API (Route + Service)  
> **Depends on**: Layer 2 (offers, requests, pharmacies), Layer 3 (routing_jobs), Routing Engine Spec v4, Routing Worker Spec v4

---

## 1. Purpose

This specification formalizes when, how, and what offers are visible to a client requesting offer data for a given prescription request. It covers:

- **Visibility gates** — preconditions for offer data to be served.
- **Per-state selection rules** — what the API returns for each `request.state`.
- **Ranking governance** — the deterministic composite score policy.
- **State invariant relationships** — how `routing_jobs.status` and `request.state` must align.
- **Separation of responsibilities** — which layer owns which decision.

---

## 2. Visibility Gate — When Is Selection Allowed?

### 2.1 Decision Authority

Visibility depends on **both** `request.state` AND `routing_jobs.status`. The `request.state` is the primary gate (it is the client-facing lifecycle), but `routing_jobs.status` is the authoritative signal that routing has completed. Selection is only allowed when routing is no longer actively mutating the offer set.

### 2.2 Gate Rule (Formal)

```
selection_allowed = (
    request.state IN ('fully_offered', 'partially_offered')
    AND routing_jobs.status IN ('completed', 'expired')
)
```

> [!IMPORTANT]
> Selection is **never** allowed while `routing_jobs.status = 'active'`. Even if offers exist, the routing worker may still be escalating tiers and the offer set is not final.

### 2.3 Rationale

- **`request.state` alone is insufficient.** The worker sets `request.state` atomically with `routing_jobs.status`, but if a crash occurs between the two (e.g., during stale recovery), `request.state` might not yet reflect the true routing status.
- **`routing_jobs.status` alone is insufficient.** The client should not need to know about routing infrastructure. `request.state` is the user-facing contract.
- **Both together** form a double-check that eliminates edge cases.

---

## 3. Per-State Visibility Rules

### 3.1 Visibility Decision Table

| `request.state` | `routing_jobs.status` | Selection Allowed? | API Response |
|------------------|-----------------------|--------------------|--------------|
| `draft` | N/A (no job exists) | ❌ No | `[]` empty array |
| `broadcasted` | `pending` or `active` | ❌ No | `[]` empty array |
| `fully_offered` | `completed` | ✅ Yes | Top N offers (full coverage only) |
| `partially_offered` | `completed` or `expired` | ✅ Yes | Top N offers (all offers, ranked) |
| `expired` | `expired` | ⚠️ Conditional | See §3.2 |
| `accepted` | `completed` | ❌ No | Accepted offer only (different endpoint) |
| `cancelled` | `cancelled` | ❌ No | `[]` empty array |

### 3.2 Edge Case: `expired` with Existing Offers

If `request.state = 'expired'` but offers exist in the database (partial offers arrived before TTL), the API must:

- **Return `[]` (empty array).** The request is expired — the user cannot act on these offers.
- Offers remain in the database for auditing but are **not selectable**.
- A separate admin/support endpoint may expose them for investigation.

> [!NOTE]
> This differs from `partially_offered`. If partial offers existed before expiry, the worker transitions `request.state` to `'partially_offered'`, NOT `'expired'`. The `'expired'` state strictly means **zero offers existed at routing termination** OR the request TTL was reached before any routing began.

### 3.3 Edge Case: `expired` with Full Coverage Offer

This state combination should be **impossible** under correct routing logic:

- The worker checks for full coverage after each wave.
- If full coverage exists, the worker transitions to `'fully_offered'`, never `'expired'`.

However, if this state is observed in production (bug in worker or stale recovery race), the API must **prioritize user experience over theoretical impossibility**:

- Log `invariant_violation_I1` as a warning.
- **Still return the full coverage offers**, ranked normally.
- The user should not be penalized for a backend state inconsistency.

> [!WARNING]
> This is a defensive recovery policy, not an endorsement of the state. The root cause (worker bug) must be investigated independently.

### 3.4 Edge Case: `broadcasted` with Existing Offers

During active routing, offers may already exist in the database (pharmacies responded during earlier waves). The API must:

- **Return `[]` (empty array).** Routing is in progress — the offer set is not final.
- **Do NOT return HTTP 409 or any error.** Routing in progress is not a conflict — it is a normal transient state.
- The client should poll `request.state` and only call offer selection once state transitions to a terminal offering state.

> [!NOTE]
> Rationale: returning an error would force the client to distinguish between "not ready" and "actual error". An empty array with a stable HTTP 200 is simpler and idempotent.

---

## 4. Marketplace Ranking Policy

### 4.1 Two-Level Ranking Model

Ranking is applied in two stages:

#### Level 1 — Coverage Classification (Filter)

| Condition | Filter Applied |
|-----------|---------------|
| ≥1 offer with `coverage_ratio = 100.00` | Only full coverage offers considered |
| No full coverage offers | All offers considered |

This ensures full coverage offers always take priority over partial ones when available.

#### Level 2 — Composite Score (Sort)

Within the filtered set, offers are ranked by:

| Priority | Column | Direction | Rationale |
|----------|--------|-----------|-----------|
| 1 (Primary) | `pharmacies.trust_score` | `DESC` | Trust incentivizes platform quality |
| 2 (Secondary) | `pharmacies.acceptance_rate` | `DESC` | Reliability signal — pharmacies that follow through |
| 3 (Tertiary) | `pharmacies.response_rate` | `DESC` | Responsiveness signal — pharmacies that consistently reply |
| 4 (Tiebreaker) | `offers.created_at` | `ASC` | Earliest response wins among equals |

### 4.2 Ranking Re-Evaluation: `acceptance_rate` vs `response_rate`

#### The Question

Should `response_rate` rank higher than `acceptance_rate`?

#### Metric Definitions

| Metric | Measures | Example |
|--------|----------|---------|
| `acceptance_rate` | % of assigned requests that the pharmacy **fulfills** (accepts and delivers) | A pharmacy that accepts 95 out of 100 assigned requests has 95% acceptance |
| `response_rate` | % of assigned requests that the pharmacy **responds to** (submits any offer, even partial) | A pharmacy that responds to 98 out of 100 requests has 98% response rate |

#### Analysis

| Factor | `acceptance_rate` higher | `response_rate` higher |
|--------|--------------------------|------------------------|
| **User impact** | User gets a pharmacy that follows through → fewer cancellations | User gets a pharmacy that replies quickly → faster initial offers |
| **Marketplace incentive** | Rewards commitment → pharmacies don't ghost after showing interest | Rewards engagement → pharmacies stay active on the platform |
| **Failure mode if low** | Pharmacy accepts but then cancels → worst UX (user thought they had it) | Pharmacy ignores requests → no harm (user never sees them) |
| **Trust correlation** | Strong — acceptance is the final promise | Moderate — response is necessary but not sufficient |

#### Decision: `acceptance_rate` > `response_rate`

**`acceptance_rate` remains higher priority (position 2) than `response_rate` (position 3).**

Rationale: A pharmacy that responds to every request but cancels frequently is **worse** for user experience than a pharmacy that responds less often but always fulfills. The marketplace must incentivize **commitment over engagement**. A high response rate with low acceptance rate indicates a pharmacy that window-shops — it creates false hope.

#### Weight Relationships (Final)

| Relationship | Decision | Reasoning |
|-------------|----------|----------|
| `trust_score` > `acceptance_rate` | Trust is strictly higher | Trust is the platform's quality signal, acceptance is one input to it |
| `acceptance_rate` > `response_rate` | Acceptance is strictly higher | Commitment > engagement (see analysis above) |
| `response_rate` > `created_at` | Response rate is strictly higher | Historical consistency > one-off speed |
| `price` involvement | **Excluded permanently** | Never. See §4.3 |

### 4.3 Price Exclusion Policy

> [!CAUTION]
> Price is **permanently excluded** from the ranking algorithm. Including price would create a race to the bottom that undermines pharmacy trust incentives and marketplace quality. The client sees price in the offer data and makes their own decision. This is a marketplace governance rule, not a technical limitation.

### 4.3 Exposure Limit

| Parameter | Value | Configurable? |
|-----------|-------|---------------|
| Default visible offers | 2 | Yes (API parameter, default) |
| Maximum visible offers | 3 | No (hardcoded ceiling) |
| Minimum visible offers | 1 | No (hardcoded floor) |

The client may request up to 3 offers via a `limit` query parameter. The API enforces `Math.min(Math.max(1, limit), 3)`.

---

## 5. State Invariants

### 5.1 Routing ↔ Request State Invariants

| Invariant | Rule |
|-----------|------|
| **I-1**: `fully_offered` guarantee | If `request.state = 'fully_offered'`, then `EXISTS(SELECT 1 FROM offers WHERE request_id = ? AND coverage_ratio = 100.00)` MUST be true. |
| **I-2**: `partially_offered` guarantee | If `request.state = 'partially_offered'`, then `EXISTS(SELECT 1 FROM offers WHERE request_id = ?)` MUST be true AND no full coverage offer exists. |
| **I-3**: `expired` guarantee | If `request.state = 'expired'` (set by routing), then zero offers existed at the time of state transition. |
| **I-4**: Routing completion | If `request.state IN ('fully_offered', 'partially_offered')`, then `routing_jobs.status IN ('completed', 'expired')`. |
| **I-5**: No backward transitions | `request.state` must never move backwards (e.g., `fully_offered` → `broadcasted`). |
| **I-6**: Deterministic ranking | Given the same offer set, `getTopOffersForRequest` must always return the same result in the same order. |
| **I-7**: Price independence | No column from the `offers` pricing fields (`total_price`, `delivery_fee`) may appear in `ORDER BY`. |
| **I-8**: Exposure cap | The function must never return more than 3 offers, regardless of input. |

### 5.2 Invariant Violation Handling

If an invariant is violated at query time:

| Violation | Detection | Response |
|-----------|-----------|----------|
| I-1 violated (`fully_offered` but no full coverage) | CTE returns `has_full_coverage = false` | Log `invariant_violation_I1`, return all offers ranked normally |
| I-4 violated (`fully_offered` but job still `active`) | Pre-query gate check | Return `[]`, log `invariant_violation_I4` |
| I-8 violated | Cannot occur (enforced by `LIMIT` in SQL) | N/A |

---

## 6. Separation of Responsibilities

### 6.1 Responsibility Matrix

| Decision | Owner | Layer |
|----------|-------|-------|
| Which pharmacies see the request | **Routing Worker** | Worker |
| When pharmacies see the request (wave timing) | **Routing Worker** | Worker |
| How long each wave window lasts | **Tier Configuration** (DB) | Config |
| When escalation triggers | **Routing Worker** | Worker |
| When routing terminates | **Routing Worker** | Worker |
| What `request.state` becomes | **Routing Worker** | Worker |
| Which offers the client sees | **Offer Selection Service** | Service |
| How offers are ranked | **Offer Selection Service** | Service |
| How many offers are visible | **Offer Selection Service** | Service |
| Whether selection is allowed | **API Route Handler** | API |
| HTTP status codes and response shape | **API Route Handler** | API |

### 6.2 Boundary Rules

1. **The worker MUST NOT know about ranking.** It writes all offers and manages state. It never filters or sorts offers for presentation.
2. **The service MUST NOT enforce visibility gates.** It is a pure ranking/filtering function. It receives a `requestId` and returns sorted offers. It never checks `request.state` or `routing_jobs.status`.
3. **The service MUST NOT modify state.** It reads `offers`, `pharmacies`, and `requests` and returns a sorted, filtered result set. It never writes to any table.
4. **The API route handler is the SOLE enforcer of the visibility gate** (§2.2). It checks `request.state` and `routing_jobs.status` before calling the service. If the gate fails, the route returns `[]` without invoking the service.
5. **Ranking policy changes** (e.g., adding a new factor) require updating only the service layer. No worker or route changes needed.
6. **Exposure policy changes** (e.g., increasing max from 3 to 5) require updating only the service layer constant.

> [!IMPORTANT]
> The visibility gate MUST NOT leak into the service layer. The service assumes every call is valid. This keeps the service testable with a simple mock of `db.query` and prevents coupling between access control and data retrieval.

---

## 7. Implementation Impact

### 7.1 Required Changes (After Approval)

| Component | Change |
|-----------|--------|
| `src/services/offerSelection.js` | Add `response_rate` to ORDER BY (position 3). No gate logic. |
| `src/routes/` (new) | Create `GET /requests/:id/offers` route with visibility gate (§2.2) |

### 7.2 No Changes Required

| Component | Reason |
|-----------|--------|
| `src/workers/routing-worker.js` | Routing is complete and stable |
| Database schema | No new columns needed |
| Migrations | No schema changes |

---

## 8. Resolved Questions

| # | Question | Resolution |
|---|----------|------------|
| 1 | Return HTTP 409 for `broadcasted` state? | **No.** Return `[]` with HTTP 200. Routing in progress is not a conflict. |
| 2 | Does `response_rate` column exist? | **Yes.** Layer 1 migration, `pharmacies` table, line 149. |
| 3 | Visibility gate in service or route? | **Route only.** Service is pure ranking/filtering (§6.2). |
