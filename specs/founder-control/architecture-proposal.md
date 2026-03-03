# Phase 11 — Founder Control & Feature Governance Layer
# Architecture Proposal

> **Status**: v1 — Design Gate (Pre-Implementation Review)
> **Level**: CTO Architectural Review
> **Date**: 2026-03-03
> **Spec kit discipline**: Additive only. No routing/acceptance/order logic changes.

---

## Executive Summary

Medyova requires a control layer that allows founders and operators to govern platform behavior at runtime — without code deployments, without direct DB manipulation, and without breaking any safety invariants established in Phases 1–10.

This proposal defines two composable tables (`system_settings`, `feature_flags`), a cached read layer, a write-protected API surface, and a risk matrix for every configurable value.

---

## A. Architecture Proposal

### A.1 Design Principles

| Principle | Implication |
|-----------|-------------|
| **No direct DB access for operators** | All changes via authenticated API |
| **Audit every mutation** | All writes go through `auditService` |
| **Config reads are hot-path safe** | Cached in memory, refreshed on interval |
| **Invariants are non-negotiable** | Certain values have hard limits enforced at write time |
| **Additive only** | No existing table is modified |

---

### A.2 New Tables

#### A.2.1 `system_settings`

Stores named scalar configuration values that govern business behavior.

```
PK:         id UUID DEFAULT gen_random_uuid()
Columns:    key     VARCHAR(100) NOT NULL UNIQUE
            value   TEXT NOT NULL
            type    VARCHAR(20) NOT NULL  -- 'decimal', 'integer', 'boolean', 'string'
            min_val TEXT NULLABLE         -- hard lower bound (enforced at write)
            max_val TEXT NULLABLE         -- hard upper bound (enforced at write)
            description TEXT NOT NULL
            is_locked BOOLEAN NOT NULL DEFAULT false  -- cannot be changed via API if true
            updated_by UUID NULLABLE     -- actor_id of last admin
            updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
            created_at TIMESTAMPTZ NOT NULL DEFAULT now()
```

**No FK on `updated_by`** — audit trail is in `audit_logs`, not FK chain.

**Seeded values at migration time:**

| key | type | value | min | max | Notes |
|-----|------|-------|-----|-----|-------|
| `commission_rate_percent` | decimal | `10.00` | `0.00` | `30.00` | Platform commission per order |
| `pharmacy_confirm_timeout_sec` | integer | `900` | `60` | `7200` | SLA auto-cancel threshold |
| `subscription_precheck_offset_days` | integer | `2` | `1` | `14` | Days before run to pre-check |
| `routing_stale_job_threshold_sec` | integer | `600` | `120` | `3600` | Stale job detection threshold |
| `max_active_requests_per_user` | integer | `5` | `1` | `20` | Business abuse limit |
| `max_active_subscriptions_per_user` | integer | `10` | `1` | `50` | Business abuse limit |

> [!CAUTION]
> `routing_wave_window_sec` is **NOT** in system_settings. Wave windows are on the `tiers` table per-tier. They are not globally configurable to prevent breaking escalation invariants accidentally.

#### A.2.2 `feature_flags`

Stores boolean feature toggles with optional zone and actor scoping.

```
PK:         id UUID DEFAULT gen_random_uuid()
Columns:    key          VARCHAR(100) NOT NULL
            scope        VARCHAR(20) NOT NULL  -- 'global', 'zone', 'pharmacy', 'user'
            scope_id     UUID NULLABLE          -- NULL means applies to all in scope
            is_enabled   BOOLEAN NOT NULL DEFAULT true
            description  TEXT NOT NULL
            updated_by   UUID NULLABLE
            updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
            created_at   TIMESTAMPTZ NOT NULL DEFAULT now()

UNIQUE: (key, scope, scope_id)
```

**Seeded feature flags:**

| key | scope | Default | Description |
|-----|-------|:---:|-------------|
| `insurance_routing_enabled` | global | `true` | Toggles insurance JOIN in routing |
| `subscription_engine_enabled` | global | `true` | Sweep generates subscriptions |
| `rare_medicine_routing_enabled` | global | `true` | Enables rare-type requests |
| `offer_visibility_enabled` | global | `true` | Safety: disable offer display |
| `new_user_registration_enabled` | global | `true` | User self-registration |
| `pharmacy_registration_open` | global | `false` | Pharmacy self-onboarding |

---

### A.3 Config Cache Layer

> [!IMPORTANT]
> Config must NEVER be read from the DB on every request. A hot config cache is mandatory.

**Design: In-process singleton cache**

```
src/config/settingsCache.js
```

- On startup: loads all `system_settings` and `feature_flags` into memory Maps
- Refreshes every `SETTINGS_CACHE_TTL_SEC` (default: 60s) via `setInterval`
- Provides synchronous reads: `getSetting('commission_rate_percent')` → returns cached value
- Provides synchronous flag reads: `isEnabled('insurance_routing_enabled', { scope: 'global' })`
- On write (admin PATCH): cache is invalidated immediately (forced refresh)

**Trade-off accepted**: 60-second staleness window means founder changes take up to 60s to propagate to all processes. This is acceptable for operational config. Routing workers pick up changes on next sweep/poll cycle.

---

### A.4 API Surface

#### A.4.1 System Settings

| Method | Path | Body | Effect |
|--------|------|------|--------|
| `GET` | `/admin/settings` | — | List all settings |
| `GET` | `/admin/settings/:key` | — | Get single setting |
| `PATCH` | `/admin/settings/:key` | `{ value }` | Update value (enforces min/max, is_locked) |

#### A.4.2 Feature Flags

| Method | Path | Body | Effect |
|--------|------|------|--------|
| `GET` | `/admin/flags` | — | List all flags |
| `PATCH` | `/admin/flags/:key` | `{ is_enabled, scope_id }` | Toggle flag |

**All writes**: require `role = 'super_admin'`. Reads: require `role = 'admin' OR 'super_admin'`.

#### A.4.3 Role Hierarchy

| Role | Settings Read | Settings Write | Flags Read | Flags Write | Admin Control |
|------|:---:|:---:|:---:|:---:|:---:|
| `operator` | ✅ | ❌ | ✅ | ❌ | ✅ (zone/pharmacy) |
| `admin` | ✅ | ❌ | ✅ | ❌ | ✅ |
| `super_admin` | ✅ | ✅ | ✅ | ✅ | ✅ |

---

### A.5 Operational Controls via Existing Mechanisms

These do not require `system_settings` — they are already soft-flag controlled:

| Action | Table | Column | API |
|--------|-------|--------|-----|
| Deactivate pharmacy | `pharmacies` | `is_active`, `is_blocked` | Phase 10A |
| Add pharmacy | `pharmacies` | INSERT | New admin route |
| Deactivate insurance company | `insurance_companies` | `is_active` | Phase 10A |
| Add insurance company | `insurance_companies` | INSERT | New admin route |
| Zone enable/disable | `zones` | `is_active`, `maintenance_mode` | Phase 10A |

---

## B. Transaction Safety Analysis

### B.1 What changes require transaction isolation?

| Config Change | Transaction Needed? | Reasoning |
|---------------|:---:|---------|
| `PATCH system_settings` | ❌ No | Single-row UPDATE + audit INSERT. Two separate autocommit ops. |
| `PATCH feature_flags` | ❌ No | Same as above. |
| `PATCH zones` | ❌ No | Single-row UPDATE. |
| `PATCH pharmacies` | ❌ No | Single-row UPDATE. |
| INSERT pharmacy | ✅ Yes | INSERT + audit in same tx recommended |
| INSERT insurance company | ✅ Yes | INSERT + audit |

### B.2 What is read-only?

- `GET /admin/settings` — pure SELECT
- `GET /admin/flags` — pure SELECT
- `GET /admin/metrics` — pure SELECT (Phase 10C)
- All cache reads — in-memory

### B.3 What must NEVER be runtime-configurable?

| Value | Reason |
|-------|--------|
| Routing tier rank order | Changing rank at runtime could cause wave escalation to skip tiers or loop. Requires code + migration. |
| Wave window duration per tier | Already in DB (`tiers.window_duration_sec`) but changes require admin-level API with guards. NOT in founder settings for Phase 11 v1. |
| Acceptance transaction steps | Code logic — cannot be config-driven |
| Order state transition graph | Code logic — invariant structural |
| Commission calculation formula | Must be audit-safe percent-only (no formula engine) |
| Database connection pool | ENV-only, restart required |
| JWT secret | ENV-only, security concern |

### B.4 Config Read Integration Points

| File | Current Source | Phase 11 Source |
|------|---------------|----------------|
| `offerAcceptance.js` | `process.env.COMMISSION_RATE_PERCENT` | `settingsCache.getSetting('commission_rate_percent')` |
| `order-sla-sweep.js` | `process.env.PHARMACY_CONFIRM_TIMEOUT_SEC` | `settingsCache.getSetting('pharmacy_confirm_timeout_sec')` |
| `subscriptionService.js` | Hardcoded `precheck_offset_days` per subscription row | Subscription row value wins if set; global default from `settingsCache` |
| `routing-worker.js` (insurance) | `job.insurance_profile_id` check | Feature flag `insurance_routing_enabled` gates the JOIN |
| `subscription-sweep.js` | Always runs | Feature flag `subscription_engine_enabled` gates sweep iteration |
| `routing-worker.js` (rare) | `request_type === 'rare'` | Feature flag `rare_medicine_routing_enabled` gates rare path |

---

## C. Risk Matrix

### C.1 Operational Risk

| Change | Risk | Severity | Guard |
|--------|------|:---:|-------|
| Commission rate → 0% | Revenue destruction | 🔴 Critical | `min_val = 0.00` allowed only if founder explicitly enables locked override |
| Commission rate → 100% | All orders become unprofitable for pharmacies | 🔴 Critical | `max_val = 30.00` hard cap |
| SLA timeout → 60s | Pharmacies get auto-cancelled before they can confirm | 🟠 High | `min_val = 60` but warn if < 300 |
| SLA timeout → 7200s (2hr) | Orders stuck pending for 2 hours — bad UX | 🟡 Medium | `max_val = 7200` — acceptable |
| Disable subscription engine | All chronic users stop receiving monthly requests | 🟠 High | No automatic recovery — founder must re-enable |
| Disable rare routing | Rare medicine requests get no offers | 🔴 Critical | Existing rare requests continue, new ones set `type=rare` still get broadcast but zero pharmacies |

### C.2 Legal Risk

| Change | Risk | Severity | Guard |
|--------|------|:---:|-------|
| Toggle insurance routing off | Insured users get unfiltered routing — pharmacy may not accept insurance | 🟡 Medium | Flag is operational, not legal. Pharmacy still validates eligibility. |
| Commission rate change mid-cycle | Orders accepted before rate change use old rate | ❌ No risk | `commission_amount` is calculated at acceptance time and stored. Not recalculated. |
| Pharmacy block without notice | No legal mechanism — operational only | 🟡 Medium | Must document: block is operational, contract terms are separate. |

### C.3 Supply-Side Risk

| Change | Risk | Severity | Guard |
|--------|------|:---:|-------|
| Deactivate large pharmacy | Reduces routing coverage in zone | 🟠 High | Metrics endpoint shows active pharmacies per zone — check before deactivating |
| Zone maintenance mode | All new requests in zone blocked | 🔴 Critical | Existing requests complete; new users get rejected. Document blast radius. |
| Disable pharmacy registration | Blocks pharmacy growth | 🟡 Medium | Feature flag — reversible instantly |

### C.4 Subscription Risk

| Change | Risk | Severity | Guard |
|--------|------|:---:|-------|
| Increase precheck_offset_days | Pre-check runs earlier — may show false negatives | 🟡 Medium | Notification stub only — no real impact in v1 |
| Subscription engine off | Active subscriptions miss their `next_run_at` cycle | 🟠 High | Sweep skips when flag is off; `next_run_at` not advanced. Cycles are missed (not queued). |
| Reduce precheck_offset_days to 1 | Very short pre-check window | 🟡 Medium | `min_val = 1` is acceptable |

### C.5 Insurance Misuse Risk

| Change | Risk | Severity | Guard |
|--------|------|:---:|-------|
| Deactivate legitimate insurance company | Breaks routing for all users with that company's profile | 🟠 High | Audit log required. Metrics to show affected user count (future). |
| Deactivate user profile directly | That user's subscription guard skips | 🟡 Medium | Audit logged. Reversible. |
| Enable insurance routing with no contracts | Insured requests find zero pharmacies — all waves skipped | 🟡 Medium | Existing escalation handles zero-pharmacy tiers gracefully. |

---

## D. Implementation Phasing Plan

### D.1 v1 — Minimal Founder Control

**Goal**: Give founders runtime control of the most critical business levers. Zero UI. API only.

**Scope**:

| Feature | Included |
|---------|:---:|
| `system_settings` table | ✅ |
| `feature_flags` table (global scope only) | ✅ |
| Settings cache (in-process, 60s TTL) | ✅ |
| `GET/PATCH /admin/settings` | ✅ |
| `GET/PATCH /admin/flags` | ✅ |
| Commission rate via DB | ✅ |
| SLA timeout via DB | ✅ |
| Insurance routing flag | ✅ |
| Subscription engine flag | ✅ |
| Rare medicine flag | ✅ |
| Pharmacy INSERT via admin API | ✅ |
| Insurance company INSERT via admin API | ✅ |
| `super_admin` role JWT claim | ✅ |
| Audit logging for all changes | ✅ |
| Zone-scoped feature flags | ❌ (v2) |
| Per-pharmacy feature flags | ❌ (v2) |
| Per-user feature flags | ❌ (v2) |
| Wave window configuration | ❌ (v2, guarded) |

**Files to create/modify**:

| File | Action |
|------|--------|
| Migration: `system_settings` + `feature_flags` | NEW |
| `src/config/settingsCache.js` | NEW |
| `src/routes/admin.js` | MODIFY — add settings/flags endpoints |
| `src/services/offerAcceptance.js` | MODIFY — read commission from cache |
| `src/workers/order-sla-sweep.js` | MODIFY — read SLA timeout from cache |
| `src/workers/routing-worker.js` | MODIFY — check `insurance_routing_enabled` + `rare_medicine_routing_enabled` flags |
| `src/workers/subscription-sweep.js` | MODIFY — check `subscription_engine_enabled` flag |

---

### D.2 v2 — Extended Governance

**Goal**: Zone-scoped controls, per-pharmacy overrides, wave window governance, and operator role granularity.

**Scope**:

| Feature | Description |
|---------|-------------|
| Zone-scoped feature flags | e.g., disable insurance routing in Zone-2 only |
| Pharmacy-scoped flags | e.g., disable subscription generation for specific pharmacy zone |
| Wave window configuration | With guards: cannot reduce below 30s; requires super_admin |
| Tier creation/deactivation | Admin can add new tier or deactivate |
| `operator` role scoped to zone | Operator can only control pharmacies in their zone |
| Scheduled config changes | `effective_at` column on `system_settings` |
| Config change history table | Full history of every settings mutation |

---

## E. Concurrency & Performance

### Concurrency

- All setting writes are single-row UPDATEs — no concurrency conflicts
- Feature flag reads are in-memory (no DB hit on hot path)
- Cache refresh is a background `setInterval` — no blocking
- Multiple worker instances share no in-process cache; each has its own TTL refresh. This is acceptable — 60s staleness per process

### Transaction Boundaries

- Settings PATCH: autocommit UPDATE + separate autocommit audit INSERT
- Feature flag PATCH: same pattern
- No new transaction complexity introduced

### Performance

- Cache hit: < 0.1ms (Map lookup)
- Cache miss (first read / refresh): < 5ms (indexed SELECT by key)
- Settings admin endpoints: < 10ms total
- No impact on routing, acceptance, or order hot paths

---

## F. Legal Boundary Confirmation

| Boundary | Confirmed |
|----------|:---:|
| No insurance claim processing | ✅ |
| No pricing override (pharmacy sets price) | ✅ |
| Commission is a platform service fee only | ✅ |
| No medical validation logic | ✅ |
| All founder actions are audit-logged | ✅ |
| Settings are operational, not contractual | ✅ |

---

## G. Schema Dependency Map

```
system_settings     ← no FKs
feature_flags       ← no FKs (scope_id is untyped UUID)
audit_logs          ← references settings/flags changes via entity_type='system_setting'|'feature_flag'
```

Zero impact on:
- `requests`, `routing_jobs`, `routing_waves`, `offers`, `orders`, `subscriptions`
- No existing table is altered

---

## FOUNDER CONTROL ARCHITECTURE PROPOSAL READY FOR REVIEW
