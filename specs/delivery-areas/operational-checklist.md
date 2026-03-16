# Phase 12 — Delivery Areas Operational Checklist

**Status:** Post-deployment operations reference  
**Applicable after:** Migration A → Migration B → App Deployment → Migration C (NOT NULL)

---

## 1. Legacy Area Management

Legacy Areas are created automatically during Migration B — **one per active zone**.

| Rule | Action |
|------|--------|
| **Never delete** Legacy Areas | `DELETE /areas/:id` will return `403` for any area where `is_legacy = true` |
| **Do not rename** Legacy Areas in production | Changing the name serves no routing purpose and may confuse operators |
| **Do not deactivate** Legacy Areas | Existing historical requests point to them; deactivating would orphan records |
| **Purpose** | Provide a valid `area_id` for all requests created before the Delivery Areas feature went live |

> Legacy Areas act as a permanent compatibility shim. They should be treated as system-owned, not operator-owned.

---

## 2. How New Areas Are Created

**Who:** Super-admin via the Founder Control Panel.  
**Endpoint:** `POST /areas`

**Required payload:**
```json
{
  "zone_id": "<UUID of the target zone>",
  "name": "District 3"
}
```

**Validation:** The endpoint verifies that the `zone_id` maps to an active, existing zone before inserting. Non-existent or inactive zones return `404`.

**Effect:** Immediately available for use in request creation or pharmacy assignment. No migration required.

---

## 3. How Pharmacies Assign Delivery Areas

**Who:** Super-admin via the Founder Control Panel.  
**Endpoint:** `PUT /pharmacies/:id/areas`

**Required payload:**
```json
{
  "area_ids": ["<area-uuid-1>", "<area-uuid-2>"]
}
```

**Behavior:** This performs a clean atomic **replace**, not a merge. The existing delivery area list is wiped and replaced with the submitted set.

**Effect timing:** Routing uses the new area set on the very next job evaluation. In-flight routing jobs see the snapshot from when `queryEligiblePharmacies` was called — they are not retroactively affected.

**DA-4 reminder:** A pharmacy with an empty `area_ids` array will be submitted with zero entries and will receive **zero routing requests** until at least one area is assigned.

---

## 4. Routing Distribution Monitoring

After rollout, validate routing distribution has not concentrated unfairly:

| Check | Query |
|-------|-------|
| **Pharmacies with zero delivery areas** | `SELECT id, name FROM pharmacies WHERE id NOT IN (SELECT DISTINCT pharmacy_id FROM pharmacy_delivery_areas)` |
| **Areas with no assigned pharmacies** | `SELECT a.id, a.name, a.zone_id FROM areas a WHERE a.is_legacy = false AND NOT EXISTS (SELECT 1 FROM pharmacy_delivery_areas pda WHERE pda.area_id = a.id)` |
| **Legacy Area request volume** | `SELECT COUNT(*) FROM requests WHERE area_id IN (SELECT id FROM areas WHERE is_legacy = true)` |
| **Area distribution per zone** | `SELECT z.name, COUNT(a.id) AS area_count FROM zones z LEFT JOIN areas a ON a.zone_id = z.id WHERE a.is_legacy = false GROUP BY z.name` |
| **Offer coverage per area** | Join `routing_jobs` → `requests` on `area_id` to confirm escalation rate is not unusually high for specific areas (which would indicate pharmacy coverage gaps) |

**Escalation rate spike:** If a specific area sees a high rate of Wave 1 timeouts (no pharmacy accepting at Tier 1), it likely means few or no pharmacies serve that area. Correct by assigning more pharmacies to that area or reviewing tier composition.

---

## 5. Final Migration Timing (NOT NULL Constraint)

Run this **only after** the application is fully deployed and no `NULL` values remain in `requests.area_id`:

```sql
-- Verify all rows are filled before applying:
SELECT COUNT(*) FROM requests WHERE area_id IS NULL;
-- Must return 0 before proceeding.

-- Apply the constraint:
ALTER TABLE requests ALTER COLUMN area_id SET NOT NULL;
```

The migration file for this is: `migrations/1772649<next>_layer8-delivery-areas-finalize.js`
