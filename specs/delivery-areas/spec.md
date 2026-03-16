# Phase 12 — Delivery Areas Specification

**Status:** Ready for Review  
**Objective:** Extend the request routing logic to respect localized delivery boundaries (areas) inside larger geographic zones without modifying the core escalation tier semantics.

---

## 1. Schema Extensions

The existing `zones` architecture remains the primary geographic boundary. The new `areas` represent localized delivery subdivisions within a zone.

```sql
CREATE TABLE areas (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    zone_id UUID NOT NULL REFERENCES zones(id) ON DELETE CASCADE,
    name VARCHAR(255) NOT NULL,
    is_active BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE pharmacy_delivery_areas (
    pharmacy_id UUID NOT NULL REFERENCES pharmacies(id) ON DELETE CASCADE,
    area_id UUID NOT NULL REFERENCES areas(id) ON DELETE CASCADE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (pharmacy_id, area_id) -- Enforces DA uniqueness
);
```

**Foreign Key Update on Requests:**
The `requests` table will be altered to strictly reference an `area_id` instead of implicitly assuming zone-wide delivery.
- `ALTER TABLE requests ADD COLUMN area_id UUID REFERENCES areas(id);`
- `ALTER TABLE requests ALTER COLUMN zone_id SET NOT NULL;` (Kept for broad partitioning, but `area_id` drives precise routing).

---

## 2. Routing Impact

The **only** functional modification to the routing loop occurs inside `src/services/routing-worker.js` within `queryEligiblePharmacies()`.

**Current Eligibility:**
Matches `zone_id`, checks pharmacy `is_active = true`, checks insurance filter if enabled, excludes `blocked_pharmacies`.

**Modified Eligibility:**
```sql
SELECT p.id, p.trust_score
FROM pharmacies p
JOIN pharmacy_delivery_areas pda ON p.id = pda.pharmacy_id
-- Existing joins for insurance/contracts remain untouched
WHERE p.zone_id = $1
  AND pda.area_id = $2
  AND p.is_active = true
  AND p.supports_rare_medicine = COALESCE($3, p.supports_rare_medicine)
  -- Existing blocked exclusion remains untouched
ORDER BY p.trust_score DESC;
```

**Escalation Logic Preservation:**
The `loadActiveTiers`, `processJob`, `createWave`, and `waitForWaveWindow` functions remain 100% untouched. The tiers (e.g., Tier 1 = Top 10%, Tier 2 = Top 50%) are simply applied to the narrowed result set of the new `queryEligiblePharmacies`.

---

## 3. Invariants

- **DA-1:** **Routing tier escalation order must not change.** A Top 10% pharmacy that delivers to the area will still be notified in Wave 1. A Top 50% pharmacy that delivers to the area will still be notified in Wave 2.
- **DA-2:** **Area filtering must only narrow pharmacy candidates, never widen.** Standard zone boundaries still apply. If a pharmacy is in Zone A, they cannot be assigned to an Area in Zone B. 
- **DA-3:** **Routing workers must not introduce additional transactions.** The `JOIN pharmacy_delivery_areas` occurs inside the existing read-only `queryEligiblePharmacies` query. No new lock acquisition or state machines are introduced.
- **DA-4:** **Zero-Area Fallback.** If a pharmacy has 0 entries in `pharmacy_delivery_areas`, they will receive 0 requests. It acts as an implicit fail-closed guard.
- **DA-5:** **Zone–Area Consistency.** An `area` belongs to exactly one `zone` via `areas.zone_id`. At request creation time, the system MUST validate that `requests.area_id → areas.zone_id = requests.zone_id`. A request may not reference an area belonging to a different zone. This must be enforced in the request creation service layer before any DB INSERT.

---

## 4. Performance & Indexes

To maintain `O(log n)` performance during the high-frequency worker sweep, the following indexes are mandatory:

```sql
-- Primary index for routing joins (area_id → pharmacy_id lookups)
CREATE INDEX idx_pharmacy_delivery_areas_area_pharmacy
    ON pharmacy_delivery_areas(area_id, pharmacy_id);

-- Optional but recommended for requests table if frequent lookups on area occur
CREATE INDEX idx_requests_area_id ON requests(area_id);
```

The composite primary key `(pharmacy_id, area_id)` natively provides an index for `pharmacy_id` lookups.

---

## 5. Admin & Pharmacy Operations

- **Super Admins:** Define `areas` dynamically via standard CRUD endpoints (`POST /admin/areas`).
- **Pharmacy Onboarding:** When a pharmacy is created or updated, they (or an admin) submit an array of `area_id`s representing their service range.
- **Update Behavior:** `PUT /pharmacies/:id/areas` will cleanly overwrite the `pharmacy_delivery_areas` pivot table (e.g., `DELETE WHERE pharmacy_id = $1`, then bulk `INSERT`).
- **Effect:** Changes to a pharmacy's delivery areas apply instantly to all subsequent routing jobs. Existing active jobs are NOT recalculated mid-wave (preserving immutability).

---

## 6. Implementation Order

1.  Phase 11 — Founder Control Layer (Complete)
2.  **Phase 12 — Delivery Areas (Next)**
3.  Phase 13 — Rating System
