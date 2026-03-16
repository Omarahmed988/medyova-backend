# Phase 11 — Step 5: Controlled Integration Spec

## 1. Scope Candidates (Evaluation)

### Allowed Candidates (Safe to Migrate)

1. **`commission_rate_percent`**
   - **Where used:** `src/services/offerAcceptance.js` — Order Creation Step 8.
   - **Inside/outside transaction?** Used inside the atomic 8-step transaction.
   - **Read type:** Currently read once at startup from `process.env`.
   - **Migration viability:** Safe, provided Option A (Snapshot before BEGIN) is used.
   - **Risk:** Mid-transaction drift if read dynamically. Resolved by snapshotting.
   - **Rollback:** Strict numeric parse. Fail-fast if cache uninitialized. Fallback to `10.00` ONLY if cache is ready but key is missing.

2. **`pharmacy_confirm_timeout_sec`**
   - **Where used:** `src/workers/order-sla-sweep.js` — Core `FOR UPDATE SKIP LOCKED` query.
   - **Inside/outside transaction?** Outside the inner per-order mutation transactions, but drives the outer sweep query.
   - **Read type:** Currently read once at startup from `process.env`.
   - **Migration viability:** Safe, provided Option A (Snapshot before query) is used.
   - **Risk:** Mid-sweep drift. Next sweep tick cleanly acquires the new timeout state without affecting in-flight order invalidation.
   - **Rollback:** `settingsCache.getSetting('pharmacy_confirm_timeout_sec') ?? 900`

### Rejected Candidates (Do Not Migrate)

1. **`max_active_requests_per_user`**
   - **Analysis:** Codebase analysis reveals this boundary is **NOT** currently implemented in the request flow or routing logic.
   - **Conclusion:** **REJECTED.** We cannot migrate env-based constants for logic that does not yet exist.

2. **`subscription_engine_enabled`, `insurance_routing_enabled`, `rare_medicine_routing_enabled`**
   - **Analysis:** Codebase analysis reveals these feature flags are **NOT** currently implemented as `process.env` guards or runtime checks in `routing-worker.js` or `subscription-sweep.js`.
   - **Conclusion:** **REJECTED.** Introducing new branching logic inside worker loops violates the constraint to not add new state machines or loops for these specific flags right now. They will remain seeded data for a future implementation phase.

---

## 2. Responsibility Boundary

- **Read Layer:** Service functions (`offerAcceptance.js`) and worker loops (`order-sla-sweep.js`) will read directly from the singleton `settingsCache.getSetting(key)`.
- **Boundaries:** All reads MUST occur **outside** of DB transactions (prior to `BEGIN` or prior to outer query execution). 
- **Mutation:** The execution layers will NEVER attempt to mutate settings. They treat `settingsCache` as purely read-only state.

---

## 3. Transaction Boundary Confirmation

- **Acceptance 8-Step Transaction:** 
  - `BEGIN` and `COMMIT` boundaries remain exactly where they are.
  - The `COMMISSION_RATE_PERCENT` becomes a local `const` resolved at the very first line of `acceptOffer()`, before the pool client is even connected or `BEGIN` is issued.
  - No new read-after-write races.
- **Order SLA Sweep:** 
  - `pharmacy_confirm_timeout_sec` becomes a local `const` resolved at the very first line of `runSweep()`.
  - The query `FOR UPDATE SKIP LOCKED` remains strictly untouched besides string interpolation of the snapshotted variable.
- **Rule Checked:** No read-after-write race is introduced. No dependency on stale cache exists *inside* an active transaction. 

---

## 4. Snapshot Strategy

**Option A — Snapshot before BEGIN.**

Both `offerAcceptance.js` and `order-sla-sweep.js` will adopt Option A. 
By snapshotting the variable at the function-entry boundary (before taking connections or beginning transactions), we absolutely guarantee deterministic execution. The transaction is completely insulated from any background `LISTEN/NOTIFY` updates that might mutate the `settingsCache` midway through the transaction.

---

## 5. Concurrency Audit

1. **Case A: commission changes while acceptance in progress.**
   - *Behavior:* The acceptance request in flight has already snapshotted the old `commission_rate_percent` at `acceptOffer` entry. The 8-step transaction completes atomically using the *old* rate. The very next `acceptOffer` invocation grabs the *new* rate.
   - *Why invariant safe:* Option A snapshot ensures the order row creation uses the exact same constant evaluated at function start.
2. **Case B: timeout changes while finding SLA orders mid-cycle.**
   - *Behavior:* The sweep loop snapshots the old timeout, effectively defining the bounds of "stale" for *this specific cycle*. If the timeout increases dramatically mid-cycle, this sweep uses the old bounds, and the next `tick()` 60 seconds later uses the new bounds.
   - *Why invariant safe:* Option A snapshot at the top of `runSweep()` isolates the sweep logic from mid-cycle mutation.
3. **Case C: subscription_engine_enabled toggled during generation.**
   - *Behavior:* Rejected candidate. Not applicable.

---

## 6. Failure Mode Analysis

If `settingsCache` is unavailable, if `LISTEN` is dropped, or if the initialization query failed:
- **Fatal runtime crash?** 
  - **commission_rate_percent**: **YES. MUST FAIL FAST.** If `settingsCache` is not initialized at boot (or is broken at runtime), the application **MUST** throw an error (e.g., `Error: settingsCache not initialized`) rather than implicitly running with defaults. `settingsCache.js` must expose an `isReady()` getter to enforce this.
  - **pharmacy_confirm_timeout_sec**: No, may remain permissive and fallback to 900.
- **Strict Parsing & Validation (Commission):** The commission value must be explicitly parsed as a numeric value (`parseFloat`) and validated before use. If the parsed value is `NaN`, the system must fail-fast and reject the acceptance flow.
- **Fallback Strategy:** 
  - **commission**: Fallback to the default (10.00) is **ONLY** permitted if `settingsCache.isReady()` is true AND the key is genuinely missing from the DB. It must **never** fallback to 10% just because the cache is stale or broken.
  - **timeout**: `const timeout = settingsCache.getSettingNumber('pharmacy_confirm_timeout_sec', 900);`
- **Silent wrong commission?** Impossible. The fail-fast constraint strictly prevents a 0% commission error caused by cache amnesia.

---

## 7. Explicit Invariant Confirmation

This spec confirms:
- **Routing precedence** remains unchanged.
- **Escalation logic** remains unchanged.
- **Acceptance 8-step atomicity** remains completely untouched.
- **Commission immutability** post-accept is strictly maintained.
- **Subscription Hard Stop model** is preserved.
- **Insurance routing JOIN behavior** is untouched.
- **No long-running transactions** introduced.
- **Routing-worker** is strictly unmodified in this step.
