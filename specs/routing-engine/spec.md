# Routing Engine — Architectural Specification

> **Status**: v4 — Marketplace Fairness Model (Final)  
> **Layer**: 3 (Routing Infrastructure)  
> **Depends on**: Layer 1 (zones, tiers, pharmacies), Layer 2 (users, requests, request_items, offers)

---

## 1. Problem Definition

### Why Routing Must Be Asynchronous

Medyova is a **demand-routing marketplace**, not a storefront. When a user submits a prescription request, the system must identify, rank, and notify eligible pharmacies — then wait for their offers. This is inherently asynchronous because:

1. **Pharmacy response is non-instant.** A pharmacy needs time to check inventory, calculate pricing, and submit an offer. Blocking the HTTP response on this is architecturally wrong.
2. **Tier-based escalation requires time windows.** Gold-tier pharmacies get first exposure. If they don't respond within a configurable window, Silver gets exposed, then Bronze. This cannot happen inside a synchronous request cycle.
3. **Cross-zone routing for rare requests** may fan out to pharmacies across the entire network. The latency and coordination cost of this makes synchronous execution impractical.

### Why Synchronous Routing Inside `POST /broadcast` Is Rejected

If the broadcast endpoint attempted to synchronously route and wait for offers:

- **User-facing latency** would scale with the number of pharmacies contacted.
- **Timeout risk** — a slow or unresponsive pharmacy would block the entire response.
- **No escalation** — tier-based priority windows require a state machine that persists across time, not a single request/response cycle.
- **No retry** — if the process crashes mid-execution, the request is lost with no recovery path.

The broadcast endpoint must: validate the request, transition state to `broadcasted`, enqueue a routing job, and return `202 Accepted` immediately.

### Marketplace Governance Implications

The routing engine is the **governance layer** of the marketplace. It decides:

- **Who sees the request** (tier filtering + zone matching).
- **When they see it** (wave timing + escalation windows).
- **What trust score threshold applies** (trust-based ordering within a tier).
- **Whether cross-zone routing activates** (rare request override).

These are not business logic details — they are **marketplace rules** that determine fairness, competitiveness, and pharmacy trust incentives. The routing engine must be auditable, deterministic, and governed by explicit configuration rather than implicit code paths.

### Tier-Based Exposure Model

| Wave | Tier   | Behavior |
|------|--------|----------|
| 1    | Gold   | First exposure window. Only Gold-tier pharmacies in the request's zone are notified. |
| 2    | Silver | If Gold-tier window completes without full coverage offers, Silver-tier pharmacies are added. |
| 3    | Bronze | Final escalation. All remaining active pharmacies in the zone are exposed. |

Each wave has a **window duration snapshotted from tier-level configuration** at wave creation time (e.g., Gold = 300s, Silver = 180s). The routing engine must track which wave is active, when it started, and when to escalate.

> **Escalation depth** is not hardcoded. The number of waves is derived dynamically from the count of active tiers ordered by `tiers.rank ASC`. Adding or removing tiers automatically adjusts the escalation depth.

> **Escalation stop condition:** Escalation stops when at least one **full coverage** offer exists at the end of the current wave window, OR all active tiers are exhausted. A wave **never terminates early** — the full window must elapse to allow fair competition within the tier. This is a marketplace fairness rule, not a first-response-wins system.

> **Termination guarantee:** Routing always terminates. The number of waves is bounded by the count of active tiers. Each wave has a finite window duration. No infinite loops are possible.

### Rare Request Cross-Zone Logic

For requests with `type = 'rare'`:

- **Zone restriction is lifted.** Pharmacies from any active zone may receive the request.
- **Only pharmacies with `supports_rare = true`** are eligible regardless of zone.
- **Tier escalation still applies.** Gold-rare pharmacies across all zones get first window, then Silver-rare, then Bronze-rare.

This prevents rare medication requests from being trapped in a zone with no capable pharmacies.

---

## 2. Domain Model Additions (Layer 3 Schema Proposal)

### 2.1 New ENUM: `routing_job_status_enum`

| Value | Meaning |
|-------|---------|
| `pending` | Job created, not yet started |
| `active` | Currently routing (at least one wave in progress) |
| `completed` | Routing finished successfully (offers received or all waves exhausted) |
| `expired` | Parent request hit `expires_at` before completion |
| `failed` | Unrecoverable error during routing |
| `cancelled` | Parent request was cancelled |

### 2.2 New ENUM: `wave_status_enum`

| Value | Meaning |
|-------|---------|
| `pending` | Wave created, not yet started |
| `active` | Wave window is currently open |
| `completed` | Wave window elapsed, escalation triggered or job completed |
| `skipped` | No eligible pharmacies for this tier, auto-escalated |

### 2.3 Table: `routing_jobs`

One routing job per broadcasted request. Tracks the overall routing lifecycle.

| Field | Type | Nullable | Default | Constraints | Notes |
|-------|------|----------|---------|-------------|-------|
| `id` | UUID | NO | `gen_random_uuid()` | PK | |
| `request_id` | UUID | NO | — | FK → `requests(id)`, UNIQUE, ON DELETE CASCADE | One job per request |
| `status` | `routing_job_status_enum` | NO | `'pending'` | | |
| `current_wave` | SMALLINT | NO | `1` | CHECK > 0 | Tracks which wave is active |
| `started_at` | TIMESTAMPTZ | YES | — | | When the job began executing |
| `completed_at` | TIMESTAMPTZ | YES | — | | When the job reached a terminal state |
| `created_at` | TIMESTAMPTZ | NO | `now()` | | |
| `updated_at` | TIMESTAMPTZ | NO | `now()` | | |

> **Note:** `max_waves` is intentionally omitted. Escalation depth is derived dynamically from the count of active tiers (`SELECT COUNT(*) FROM tiers WHERE is_active = true`). This ensures adding or removing tiers automatically adjusts routing behavior without schema changes.

**Indexes:**
- `request_id` (covered by UNIQUE)
- `status`
- Composite: `(status, created_at)` — for worker polling

**Delete policy:** CASCADE from `requests`. If a request is deleted, its routing job is cleaned up.

### 2.4 Table: `routing_waves`

One row per escalation wave within a routing job. Tracks tier-level routing execution.

| Field | Type | Nullable | Default | Constraints | Notes |
|-------|------|----------|---------|-------------|-------|
| `id` | UUID | NO | `gen_random_uuid()` | PK | |
| `job_id` | UUID | NO | — | FK → `routing_jobs(id)`, ON DELETE CASCADE | |
| `wave_number` | SMALLINT | NO | — | CHECK > 0 | 1, 2, or 3 |
| `tier_id` | UUID | NO | — | FK → `tiers(id)`, ON DELETE RESTRICT | Which tier this wave targets |
| `status` | `wave_status_enum` | NO | `'pending'` | | |
| `pharmacies_targeted` | INTEGER | NO | `0` | CHECK >= 0 | Count of pharmacies notified in this wave |
| `offers_received` | INTEGER | NO | `0` | CHECK >= 0 | **Informational snapshot only** — not used for escalation decisions |
| `window_duration_sec` | INTEGER | NO | — | CHECK > 0 | Snapshotted from tier config at wave creation time |
| `started_at` | TIMESTAMPTZ | YES | — | | When the wave window opened |
| `expires_at` | TIMESTAMPTZ | YES | — | | `started_at + window_duration_sec` |
| `completed_at` | TIMESTAMPTZ | YES | — | | When the wave reached terminal state |
| `created_at` | TIMESTAMPTZ | NO | `now()` | | |
| `updated_at` | TIMESTAMPTZ | NO | `now()` | | |

**Indexes:**
- `job_id`
- `tier_id`
- `status`
- Composite: `(job_id, wave_number)` — UNIQUE constraint

**Delete policy:** CASCADE from `routing_jobs`.

> **Note on `offers_received`:** This field is an informational snapshot written at wave completion for observability and audit purposes. It is **never** used for escalation decisions. All escalation logic relies exclusively on `EXISTS` queries against the `offers` table filtering by `coverage_ratio = 100.00`.

### 2.5 Layer 2 Amendment: `offers.coverage_ratio`

The marketplace fairness model requires a `coverage_ratio` column on the `offers` table:

| Field | Type | Nullable | Default | Constraints | Notes |
|-------|------|----------|---------|-------------|-------|
| `coverage_ratio` | NUMERIC(5,2) | NO | — | CHECK >= 0 AND <= 100 | Percentage of request items covered by this offer |

**Full coverage** is strictly defined as `coverage_ratio = 100.00`. Any value below 100.00 is considered partial.

This column must be added via a Layer 2 amendment migration before worker Phase 4B implementation begins.

---

## 3. Routing Execution Model

### Event-Driven Lifecycle

```
User broadcasts request
        │
        ▼
  ┌─────────────────┐
  │ request.state =  │
  │ 'broadcasted'    │
  └────────┬────────┘
           │
           ▼
  ┌─────────────────┐
  │ Create           │
  │ routing_job      │
  │ status='pending' │
  └────────┬────────┘
           │
           ▼
  ┌─────────────────────────────────────┐
  │ Start Wave N (tier by rank ASC)        │
  │ → Query eligible pharmacies             │
  │ → ORDER BY trust_score DESC             │
  │ → Set pharmacies_targeted, started_at   │
  └────────┬────────────────────────────┘
           │
           ▼
  ┌─────────────────────────────────────┐
  │ Wait FULL window duration               │
  │ (NEVER terminate early)                 │
  │ Heartbeat routing_jobs.updated_at       │
  │ Check request.expires_at each cycle     │
  └────────┬────────────────────────────┘
           │
           ▼
  ┌─────────────────────────────────────┐
  │ Wave window elapsed                     │
  │ Mark wave 'completed'                   │
  │ Count offers_received for wave           │
  └────────┬────────────────────────────┘
           │
       ┌───┴─────────────┐
       │                   │
  Full coverage        No full coverage
  offer exists         offer yet
       │                   │
       ▼                   ▼
  ┌────────────┐    ┌──────────────┐
  │ STOP        │    │ Escalate to  │
  │ routing     │    │ next tier    │
  │ job done    │    │ wave         │
  └────────────┘    └──────┬───────┘
                           │
                           ▼
                     (repeat cycle)
                           │
                           ▼
  ┌─────────────────────────────────────┐
  │ All tiers exhausted OR               │
  │ request.expires_at reached            │
  │                                       │
  │ → Determine final request state:      │
  │   full coverage → 'fully_offered'     │
  │   partial only  → 'partially_offered' │
  │   no offers     → 'expired'           │
  └─────────────────────────────────────┘
```

### Rare Request Override

For `request.type = 'rare'`:

1. **Zone filter is removed.** The pharmacy query becomes:
   `WHERE supports_rare = true AND is_active = true AND tier_id = <current_wave_tier>`
   (all zones included, but tier filter still applies).
2. **Tier precedence is preserved.** Gold-rare pharmacies across all zones get first window, then Silver-rare, then Bronze-rare. Tier escalation is never bypassed.
3. **Trust score ordering is intra-tier only.** Within each wave, pharmacies are ordered by `trust_score DESC`. Trust does **not** override tier precedence — a Bronze pharmacy with trust 95 still waits for Wave 3, even if Gold pharmacies have trust 40.

### Two-Level Ranking Model

Offers are ranked using a two-level model:

**Level 1 — Coverage Classification:**
- **Full coverage** offers (`coverage_ratio = 100%`) are always ranked above partial offers.
- If full coverage offers exist, only full coverage offers are considered for ranking.
- If no full coverage offers exist, partial offers are used.

**Level 2 — Composite Score (within coverage level):**

| Factor | Weight | Source |
|--------|--------|--------|
| `trust_score` | Primary | `pharmacies.trust_score` |
| `acceptance_rate` | Secondary | `pharmacies.acceptance_rate` |
| Response speed | Tertiary | Time between wave start and offer submission |

> **Price is NOT a routing priority factor.** Price is visible to the client but is never used in the ranking algorithm. This prevents a race to the bottom and maintains pharmacy trust incentives.

### Marketplace Exposure Policy (Client Visibility)

The client must see a **controlled, competitive subset** of offers, not the full list:

| Rule | Value |
|------|-------|
| Default visible offers | 2 |
| Maximum visible offers | 3 |
| Show all offers | **Never** |

**Visibility rules:**
- If full coverage offers exist → show top 2–3 full coverage offers only.
- If no full coverage offers exist → show top 2–3 partial offers.
- Offers beyond the top 3 remain **stored but hidden** from the client.
- Ranking within the visible set follows the Two-Level Ranking Model above.

This ensures:
- Fair exposure — pharmacies compete on trust, not on speed of response.
- Controlled competition — showing too many offers overwhelms the client.
- No information asymmetry — all offers are stored for audit, but the client sees only the best.

### Wave Fairness Rule

Even if a full coverage offer appears early in a wave:

1. **DO NOT** close the wave immediately.
2. **Allow** all remaining pharmacies in the same tier to submit offers until the window ends.
3. **Prevent** escalation to the next tier after wave completion if full coverage exists.

This maintains fair competition inside the same tier. A pharmacy that submits a better offer 30 seconds before the window closes is treated equally to one that submitted immediately.

### Trust Score Ordering Logic

Within each wave, pharmacies are ordered by:

```
ORDER BY pharmacies.trust_score DESC
```

Higher-trust pharmacies appear first in the notification queue. This incentivizes pharmacies to maintain high response rates, SLA compliance, and low cancellation rates.

### Governance Rules

1. **Exclusive window.** A pharmacy only receives the request during its tier's active wave window. It cannot see requests meant for higher tiers.
2. **Cumulative exposure.** When Wave 2 starts, Wave 1 pharmacies can still submit offers. New pharmacies (Silver) are added, not substituted.
3. **No re-routing.** Once a routing job completes or expires, it cannot be re-opened. A new request must be created.
4. **No early wave termination.** A wave always runs for its full `window_duration_sec`, regardless of offers received.
5. **Full coverage stops escalation.** If a full coverage offer exists when a wave completes, no further tiers are escalated.

### Request State Transitions

When routing completes, the request state is determined by offer coverage:

| Condition | Request State |
|-----------|---------------|
| ≥1 full coverage offer exists (`coverage_ratio = 100.00`) | `fully_offered` |
| ≥1 partial offer exists, no full coverage | `partially_offered` |
| 0 offers | `expired` |

These states must be consistent across `requests.state`, `routing_jobs.status`, and `routing_waves.status`.

> **No ambiguity:** If zero offers exist at routing completion, the request state is always `expired`, regardless of whether `expires_at` was reached or all tiers were simply exhausted.

---

## 4. Invariants & Constraints

### DB-Enforced

| Invariant | Mechanism |
|-----------|-----------|
| One routing job per request | `UNIQUE(request_id)` on `routing_jobs` |
| One wave per tier per job | `UNIQUE(job_id, wave_number)` on `routing_waves` |
| One offer per pharmacy per request | `UNIQUE(request_id, pharmacy_id)` on `offers` (Layer 2) |
| Wave number must be positive | `CHECK(wave_number > 0)` |
| Pharmacy/offer counts non-negative | `CHECK(pharmacies_targeted >= 0)`, `CHECK(offers_received >= 0)` |
| Window duration positive | `CHECK(window_duration_sec > 0)` |
| Pricing bounds | `CHECK(total_price >= 0)`, `CHECK(delivery_fee >= 0)` on `offers` (Layer 2) |
| Coverage ratio bounds | `CHECK(coverage_ratio >= 0 AND coverage_ratio <= 100)` on `offers` (Layer 2) |

### Application-Enforced

| Invariant | Enforcement Location |
|-----------|---------------------|
| No cross-zone offers for `standard` requests | Routing Engine pharmacy query filter |
| No offers accepted after `request.expires_at` | Offer submission handler |
| Strict tier escalation order (rank ASC) | Routing job creation logic |
| Offer revisions update same row (no versioning) | Offer upsert logic (ON CONFLICT UPDATE) |
| `contact_phone` must match `users.phone` when `user_id` is set | Request creation handler |
| Request is immutable after `broadcasted` state | Request update handler |
| Cumulative exposure (earlier wave pharmacies remain eligible) | Wave pharmacy query logic |
| No early wave termination (full window must elapse) | Wave wait loop logic |
| Full coverage stops escalation (not any offer) | Escalation decision logic |
| Client sees max 2–3 offers (Marketplace Exposure Policy) | Offer API response layer |
| Request state reflects coverage level, not just offer count | Job completion logic |

### Idempotency Requirement

Wave execution **must be safe to re-run** without producing side effects. This is critical for crash recovery and retry scenarios.

| Operation | Idempotency Mechanism |
|-----------|----------------------|
| Wave creation | `UNIQUE(job_id, wave_number)` — duplicate insert is rejected |
| Offer insertion | `ON CONFLICT (request_id, pharmacy_id) DO NOTHING` — duplicate offers are silently ignored |
| Wave status transition | Only transitions from non-terminal states (`pending` → `active`, `active` → `completed`) |
| Job status transition | Only transitions from non-terminal states (`pending` → `active`, `active` → `completed/expired`) |
| Pharmacy count update | Recounted from source data, not incremented |

The routing worker must assume it can be interrupted at any point and restarted. No operation should produce duplicates or corrupt state when executed twice.

---

## 5. Failure Handling Strategy

### Routing Worker Crashes

**Scenario:** The background worker processing a routing job crashes mid-wave.

**Behavior:**
- The `routing_job.status` remains `active`.
- On worker restart, a **recovery sweep** queries for jobs with `status = 'active'` and `updated_at < now() - stale_threshold`.
- Stale jobs are either resumed (re-evaluate current wave) or marked `failed` if unrecoverable.
- **Idempotency requirement:** Wave execution must be safe to re-run. Offer inserts use `ON CONFLICT DO NOTHING`.

### Wave Execution Fails

**Scenario:** The database query to find eligible pharmacies fails, or notification delivery errors out.

**Behavior:**
- The wave is marked `status = 'completed'` with `pharmacies_targeted = 0`.
- The job logs the error and escalates to the next wave.
- If all waves fail, the job transitions to `status = 'failed'`.
- The request state transitions to `expired` or remains `broadcasted` depending on TTL.

### No Pharmacies Available

**Scenario:** A wave targets a tier, but no active pharmacies exist in the zone (or globally for rare).

**Behavior:**
- The wave is created with `pharmacies_targeted = 0` and immediately marked `status = 'skipped'`.
- Escalation to the next wave happens without waiting for the window duration.
- If all waves are skipped, the job completes with `status = 'completed'` and zero offers.
- The request transitions to `expired` (if `expires_at` reached) or remains in `partially_offered` state.

### Request Expires Mid-Wave

**Scenario:** `request.expires_at` is reached while a wave is still active.

**Behavior:**
- The active wave is immediately marked `status = 'completed'`.
- The routing job transitions to `status = 'expired'`.
- The request transitions to `state = 'expired'`.
- Any offers already submitted remain in the system with `status = 'expired'`.
- No new offers are accepted after this point.

---

## 6. Observability & Auditability

### What Must Be Logged

| Event | Data Captured |
|-------|--------------|
| Job created | `job_id`, `request_id`, `request_type`, `zone_id` |
| Wave started | `wave_id`, `job_id`, `tier_name`, `pharmacies_targeted`, `window_duration_sec` |
| Wave completed | `wave_id`, `offers_received`, `duration_actual` |
| Wave skipped | `wave_id`, `tier_name`, reason (`no_pharmacies`) |
| Job completed | `job_id`, `final_status`, `total_offers`, `total_waves`, `total_duration` |
| Job expired | `job_id`, `request_id`, `expired_at`, `waves_completed` |
| Job failed | `job_id`, `error_message`, `failed_wave` |

### What Must Be Queryable Later

- **Per-request routing history:** Given a `request_id`, reconstruct the full routing timeline (job → waves → offers).
- **Per-pharmacy offer history:** Given a `pharmacy_id`, list all requests it was targeted for and whether it responded.
- **Per-zone routing stats:** Average offers per request, average time to first offer, wave escalation frequency.
- **Tier effectiveness:** What percentage of requests are fulfilled at each tier level.

### Metrics Required for Trust Engine

The Trust Engine will consume these metrics to recalculate pharmacy trust scores:

| Metric | Source | Feeds Into |
|--------|--------|------------|
| Response rate | `offers_received / pharmacies_targeted` per pharmacy | `pharmacies.response_rate` |
| Acceptance rate | Offers with `status = 'accepted'` / total offers per pharmacy | `pharmacies.acceptance_rate` |
| SLA compliance | Offers submitted within wave window / total targeted | `pharmacies.sla_compliance` |
| Cancellation rate | Offers later cancelled or failed / total accepted | `pharmacies.cancellation_rate` |
| Trust score | Weighted composite of above 4 metrics | `pharmacies.trust_score` |

These metrics are **persisted snapshots** (as established in Layer 1), recalculated periodically by the Trust Engine and written back to the `pharmacies` table.

---

> **⛔ REVIEW GATE**
>
> This specification reflects the Marketplace Fairness Model (v4 — Final).
> No migrations, no code, no implementation.
>
> Awaiting architectural review and explicit approval.
