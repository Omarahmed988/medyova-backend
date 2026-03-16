# Launch Readiness — Operational Specification

**Status:** Ready for Review  
**Scope:** Documentation and operational readiness only — no new features, no schema changes beyond approved migrations  
**Test Baseline:** 179 tests / 11 suites / all passing

---

## 1. Required Production Migrations

### Migration C — `requests.area_id NOT NULL`

**File:** `migrations/1772651346487_layer8-delivery-areas-finalize.js`

**Pre-check (must return 0 before applying):**

```sql
SELECT COUNT(*) FROM requests WHERE area_id IS NULL;
```

**Apply:**

```sql
ALTER TABLE requests ALTER COLUMN area_id SET NOT NULL;
```

**Rollback:**

```sql
ALTER TABLE requests ALTER COLUMN area_id DROP NOT NULL;
```

**Rollback conditions:**
- Apply rollback if the application is not yet sending `area_id` on every request creation
- Apply rollback if Legacy Area backfill was incomplete

**Verification after apply:**

```sql
-- Confirm constraint is active
SELECT column_name, is_nullable
FROM information_schema.columns
WHERE table_name = 'requests' AND column_name = 'area_id';
-- Expected: is_nullable = 'NO'
```

### Migration Checklist

| Migration | Status | Pre-check |
|-----------|--------|-----------|
| A — `areas` + `pharmacy_delivery_areas` | Applied | None |
| B — `requests.area_id` (nullable) + backfill | Applied | None |
| C — `requests.area_id NOT NULL` | **Pending** | `COUNT(*) WHERE area_id IS NULL` = 0 |
| Phase 13 — `order_reviews` + pharmacy aggregates | Applied | None |

---

## 2. Monitoring & Operational Queries

### 2.1 Pharmacy Density per Area

```sql
SELECT a.id AS area_id, a.name, a.zone_id,
       COUNT(pda.pharmacy_id) AS pharmacy_count
FROM areas a
LEFT JOIN pharmacy_delivery_areas pda ON pda.area_id = a.id
WHERE a.is_legacy = false AND a.is_active = true
GROUP BY a.id, a.name, a.zone_id
ORDER BY pharmacy_count ASC;
```

**Frequency:** Daily  
**Action threshold:** `pharmacy_count ≤ 2`

### 2.2 Escalation Rate per Area (7-Day Rolling)

```sql
SELECT r.area_id, a.name,
       COUNT(*) AS total_requests,
       SUM(CASE WHEN rj.current_wave > 1 THEN 1 ELSE 0 END) AS escalated,
       ROUND(100.0 * SUM(CASE WHEN rj.current_wave > 1 THEN 1 ELSE 0 END) / COUNT(*), 2) AS escalation_pct
FROM requests r
JOIN routing_jobs rj ON rj.request_id = r.id
JOIN areas a ON a.id = r.area_id
WHERE r.created_at > NOW() - INTERVAL '7 days'
GROUP BY r.area_id, a.name
ORDER BY escalation_pct DESC;
```

**Frequency:** Daily  
**Action threshold:** `escalation_pct > 50%`

### 2.3 Zero-Area Pharmacies

```sql
SELECT id, name FROM pharmacies
WHERE is_active = true
  AND id NOT IN (SELECT DISTINCT pharmacy_id FROM pharmacy_delivery_areas);
```

**Frequency:** Daily  
**Expected:** Zero rows — any active pharmacy without areas receives zero routing traffic (DA-4 fail-closed)

### 2.4 Rating Aggregate Consistency

```sql
SELECT p.id, p.name, p.rating_avg, p.rating_count,
       COUNT(r.id) AS actual_count,
       COALESCE(AVG(r.rating)::NUMERIC(3,2), 0.00) AS actual_avg
FROM pharmacies p
LEFT JOIN order_reviews r ON r.pharmacy_id = p.id
GROUP BY p.id, p.name, p.rating_avg, p.rating_count
HAVING p.rating_count != COUNT(r.id)
    OR p.rating_avg != COALESCE(AVG(r.rating)::NUMERIC(3,2), 0.00);
```

**Frequency:** Weekly  
**Expected:** Zero rows — any drift is self-healed by running `recalculateAggregate(pharmacy_id)`

### 2.5 Configuration Integrity

```sql
-- Commission must exist and be numeric
SELECT key, value,
       CASE WHEN value ~ '^\d+(\.\d+)?$' THEN 'OK' ELSE 'INVALID' END AS status
FROM system_settings
WHERE key = 'commission_rate_percent';

-- SLA timeout must exist and be numeric
SELECT key, value,
       CASE WHEN value ~ '^\d+(\.\d+)?$' THEN 'OK' ELSE 'INVALID' END AS status
FROM system_settings
WHERE key = 'pharmacy_confirm_timeout_sec';
```

**Frequency:** On every deployment  
**Expected:** Both rows exist with status `OK`

---

## 3. Critical Alerts

| Alert | Trigger | Severity | Response |
|-------|---------|----------|----------|
| **Area liquidity critical** | Any area with `pharmacy_count ≤ 2` | HIGH | Assign more pharmacies to the area or merge into adjacent area |
| **High escalation rate** | `escalation_pct > 50%` for any area over 7 days | HIGH | Investigate pharmacy density in that area; consider onboarding |
| **Zero-area pharmacy** | Active pharmacy with no `pharmacy_delivery_areas` rows | MEDIUM | Assign delivery areas immediately — pharmacy is receiving zero traffic |
| **Settings cache not ready** | `settingsCache.isReady() === false` at application boot | CRITICAL | Application must fail-fast — do not serve requests. Investigate DB connectivity and `system_settings` table |
| **Commission missing or NaN** | `commission_rate_percent` key missing or non-numeric | CRITICAL | Application will reject all offer acceptances. Restore setting via `PATCH /admin/settings/commission_rate_percent` |
| **Rating aggregate drift** | Monitoring query §2.4 returns rows | LOW | Run `recalculateAggregate(pharmacy_id)` for affected pharmacies |
| **Abnormal request failure rate** | `requests` with `state = 'expired'` > 30% in rolling 24h | HIGH | Check area coverage, pharmacy availability, and SLA timeout setting |
| **Audit log write failure** | `[audit]` error in application logs | LOW | Audit failures do not affect operations — investigate DB write permission on `system_audit_logs` |

---

## 4. Operational Runbook

### Scenario 1: High Routing Escalation in a Specific Area

**Symptoms:** Escalation rate > 50%, SLA timeouts increasing for requests in one area.

**Diagnosis:**
1. Run query §2.1 — check pharmacy density for the area
2. Run query §2.2 — confirm escalation rate
3. Check if pharmacies assigned to the area are active

**Resolution:**
- If `pharmacy_count ≤ 2`: assign additional pharmacies via `PUT /pharmacies/:id/areas`
- If all pharmacies are inactive: reactivate or onboard new pharmacies
- If area is too granular: consider consolidating with adjacent areas

### Scenario 2: Pharmacies with No Delivery Areas Configured

**Symptoms:** Pharmacy reports receiving no requests despite being active.

**Diagnosis:**
1. Run query §2.3 — confirm pharmacy has zero `pharmacy_delivery_areas` rows

**Resolution:**
- Assign delivery areas via `PUT /pharmacies/:id/areas` with the appropriate `area_ids`
- Verify the pharmacy appears in routing results after assignment

### Scenario 3: Aggregate Rating Drift

**Symptoms:** Pharmacy rating displayed to users does not match actual review data.

**Diagnosis:**
1. Run query §2.4 — identify affected pharmacies

**Resolution:**
- For each affected `pharmacy_id`, trigger recalculation:
  ```js
  const { recalculateAggregate } = require('./src/services/reviewService');
  await recalculateAggregate(pharmacyId);
  ```
- Verify by re-running query §2.4 — should return zero rows

### Scenario 4: Misconfigured System Settings

**Symptoms:** Offer acceptances failing with `settingsCache not ready` or NaN errors.

**Diagnosis:**
1. Run query §2.5 — check commission and timeout values
2. Check application logs for `[settingsCache]` errors
3. Verify `LISTEN/NOTIFY` channel is active

**Resolution:**
- If key is missing: `INSERT INTO system_settings (key, value) VALUES ('commission_rate_percent', '10.00')`
- If value is non-numeric: `PATCH /admin/settings/commission_rate_percent` with valid numeric string
- If cache is not propagating: restart application to re-establish `LISTEN` connection

### Scenario 5: Legacy Area Accumulating Traffic

**Symptoms:** High volume of requests still assigned to Legacy Areas after new areas are deployed.

**Diagnosis:**
```sql
SELECT COUNT(*) FROM requests
WHERE area_id IN (SELECT id FROM areas WHERE is_legacy = true)
  AND created_at > NOW() - INTERVAL '7 days';
```

**Resolution:**
- Verify that the request creation flow is sending `area_id` for new requests
- Legacy Area traffic should trend toward zero as new areas are assigned — if not, the application may not be enforcing `area_id` on request creation

---

## 5. Rollback Strategy

### 5.1 Feature-Level Rollback via Settings

| Setting | Default | Emergency Value | Effect |
|---------|---------|----------------|--------|
| `commission_rate_percent` | `10.00` | `10.00` | Reset to baseline — no financial impact |
| `pharmacy_confirm_timeout_sec` | `900` | `1800` | Extend window to reduce SLA timeouts under load |

**How:** `PATCH /admin/settings/:key` with the emergency value.

### 5.2 Schema Rollback

| Migration | Rollback Command | Risk |
|-----------|-----------------|------|
| C — `NOT NULL` on `area_id` | `ALTER TABLE requests ALTER COLUMN area_id DROP NOT NULL` | Low — only loosens constraint |
| Phase 13 — `order_reviews` | `DROP TABLE order_reviews; ALTER TABLE pharmacies DROP COLUMN rating_avg, DROP COLUMN rating_count;` | Medium — destroys all review data |

### 5.3 Routing Load Reduction

If routing is causing excessive database load:

1. **Increase poll interval:** Set `WORKER_POLL_INTERVAL_MS` to `10000` (from default `3000`)
2. **Reduce stale recovery frequency:** Set `WORKER_STALE_JOB_THRESHOLD_SEC` to `1200` (from default `600`)
3. **Monitor with:** Check `routing-worker` structured logs for `metrics_summary` events

### 5.4 Full Feature Isolation

If a specific feature must be completely disabled:

| Feature | Isolation Method |
|---------|-----------------|
| Delivery area filtering | Remove `JOIN pharmacy_delivery_areas` from `queryEligiblePharmacies` — reverts to zone-only routing |
| Rating system | Stop serving `POST /orders/:id/review` — reviews become read-only; aggregates freeze |
| Admin control plane | Remove `requireAuth` from `/admin` mount — locks out all admin operations |

> These are emergency measures only. Each requires a code deployment and should be treated as a temporary circuit breaker, not a permanent configuration.
