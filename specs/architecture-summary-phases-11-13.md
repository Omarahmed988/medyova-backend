# Post-Phase Architecture Summary — Phases 11–13

**Date:** 2026-03-04  
**Test Suite:** 179 tests / 11 suites / all passing

---

## Current Marketplace Capabilities

### Phase 11 — Founder Control Layer

| Capability | Mechanism |
|------------|-----------|
| Dynamic `commission_rate_percent` | `system_settings` via `settingsCache` — strict `parseFloat` + `isNaN` validation, fail-fast if cache not ready |
| Dynamic `pharmacy_confirm_timeout_sec` | `system_settings` via `settingsCache` — permissive fallback to `900` if key missing |
| Setting mutation | `PATCH /admin/settings/:key` — super-admin only, rate-limited (20/min) |
| Feature flags | `PATCH /admin/flags/:key` — super-admin only |
| Audit trail | `system_audit_logs` — append-only, audit failure does not roll back config mutation |
| Cache propagation | `LISTEN/NOTIFY` on `system_settings` changes → instant cache invalidation |

### Phase 12 — Delivery Areas

| Capability | Mechanism |
|------------|-----------|
| Area management | `POST /areas`, `DELETE /areas/:id` — super-admin only, legacy areas protected (403 on delete) |
| Pharmacy area assignment | `PUT /pharmacies/:id/areas` — atomic full replace, not merge |
| Routing eligibility filter | `JOIN pharmacy_delivery_areas pda ON pda.pharmacy_id = p.id` in `queryEligiblePharmacies` standard paths |
| DA-4 fail-closed | `INNER JOIN` guarantees pharmacies with zero areas receive zero requests |
| DA-5 zone–area consistency | `validateAreaZoneConsistency()` — enforced at request creation service layer |
| Legacy compatibility | Auto-created Legacy Areas per zone, `is_legacy = true`, cannot be deleted |
| Final NOT NULL migration | Ready — run after deployment confirms zero NULL `area_id` values |

### Phase 13 — Order Rating System

| Capability | Mechanism |
|------------|-----------|
| Review submission | `POST /orders/:id/review` — one per order (`UNIQUE(order_id)`), rating 1–5, comment ≤ 500 chars |
| Eligibility enforcement | Order must be `completed`, user must own the order |
| Pharmacy aggregate | `pharmacies.rating_avg` (`NUMERIC(3,2)`) + `pharmacies.rating_count` — recalculated on each insert/delete |
| Anti-abuse | `UNIQUE(order_id)` at DB + ownership + status gate + no-edit policy |
| Admin moderation | `DELETE /admin/reviews/:id` — super-admin only, triggers aggregate recalc |
| Aggregate isolation | Insert and aggregate are decoupled — aggregate failure logged, never rolls back the review |
| Routing isolation | `rating_avg` does NOT affect `trust_score` or `queryEligiblePharmacies` in v1 |

---

## Operational Monitoring Recommendations

### Commission & Settings Health

```sql
-- Verify commission is set and numeric
SELECT key, value FROM system_settings WHERE key = 'commission_rate_percent';
```

- Alert if `settingsCache.isReady()` returns `false` at boot → application should fail-fast
- Monitor `system_audit_logs` for unexpected `UPDATE_SETTING` events

### Delivery Area Coverage

```sql
-- Pharmacies with zero delivery areas (receiving zero routing traffic)
SELECT id, name FROM pharmacies
WHERE id NOT IN (SELECT DISTINCT pharmacy_id FROM pharmacy_delivery_areas);

-- Areas with no assigned pharmacies (routing dead zones)
SELECT a.id, a.name, a.zone_id FROM areas a
WHERE a.is_legacy = false
  AND NOT EXISTS (SELECT 1 FROM pharmacy_delivery_areas pda WHERE pda.area_id = a.id);

-- Pharmacy density per area
SELECT area_id, COUNT(pharmacy_id) AS pharmacy_count
FROM pharmacy_delivery_areas
GROUP BY area_id
ORDER BY pharmacy_count ASC;
```

- Alert on areas with ≤ 1 pharmacy — high escalation risk
- Monitor Legacy Area request volume — decreasing trend expected as new areas are assigned

### Rating System Health

```sql
-- Pharmacies with reviews but stale aggregates (self-healing check)
SELECT p.id, p.rating_avg, p.rating_count,
       COUNT(r.id) AS actual_count,
       AVG(r.rating)::NUMERIC(3,2) AS actual_avg
FROM pharmacies p
LEFT JOIN order_reviews r ON r.pharmacy_id = p.id
GROUP BY p.id, p.rating_avg, p.rating_count
HAVING p.rating_count != COUNT(r.id)
    OR p.rating_avg != COALESCE(AVG(r.rating)::NUMERIC(3,2), 0.00);
```

- Run periodically — should return zero rows
- If rows appear, run `recalculateAggregate(pharmacy_id)` to self-heal

### Routing Liquidity Monitoring

> **Architectural note:** After Phase 12, routing eligibility is area-scoped rather than zone-wide. A zone may appear healthy overall while individual areas within it suffer from low pharmacy density. This is an expected consequence of the Delivery Areas model — not a routing bug.

**Symptoms of low area liquidity:**
- Increased Tier-1 escalation rate for specific areas
- Longer routing times localized to specific areas
- Apparent SLA degradation that does not appear at zone-level aggregation

```sql
-- Pharmacy density per area (sorted ascending — lowest first)
SELECT a.id AS area_id, a.name, a.zone_id,
       COUNT(pda.pharmacy_id) AS pharmacy_count
FROM areas a
LEFT JOIN pharmacy_delivery_areas pda ON pda.area_id = a.id
WHERE a.is_legacy = false AND a.is_active = true
GROUP BY a.id, a.name, a.zone_id
ORDER BY pharmacy_count ASC;

-- Escalation rate per area (requests that reached Tier 2+)
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

**Operational rule:** Areas with `pharmacy_count ≤ 2` or `escalation_pct > 50%` should be flagged for pharmacy onboarding or area consolidation.

---

## Post-Launch Hardening Roadmap

| Item | Priority | Notes |
|------|----------|-------|
| SLA sweep timeout parameter binding | Low | Currently interpolated into SQL interval string — safe but should migrate to `$N` binding for consistency |
| Incremental aggregate strategy | Medium | Replace full recalculation with `SET rating_count = rating_count + 1` once volumes justify it |
| Review edit capability (`PATCH`) | Low | Not in v1 scope — immutable reviews are safer for trust |
| Rating → trust_score integration | Medium | Requires governance decision + tunable `rating_weight` admin setting |
| Delivery area coverage alerts | Medium | Automated monitoring for low-density areas causing escalation spikes |
| `requests.area_id NOT NULL` migration | **Critical** | Must be applied after deployment — pre-check: `SELECT COUNT(*) FROM requests WHERE area_id IS NULL` must return 0 |
