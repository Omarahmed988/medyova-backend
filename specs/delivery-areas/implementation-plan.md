# Phase 12 — Delivery Areas Implementation Plan

**Status:** Ready for Review (v2 — corrected)  
**Objective:** Detail the exact execution steps for introducing precise delivery area routing without modifying escalation tiers or core invariants.

---

## 1. Staged Migration Rollout

To guarantee zero downtime and prevent request creation failures during deployment, the migrations follow a strict staged approach.

### Step 1 — Migration A: Base Tables

Creates the foundational delivery area schema. No impact on existing tables.

```sql
CREATE TABLE areas (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    zone_id UUID NOT NULL REFERENCES zones(id) ON DELETE CASCADE,
    name VARCHAR(255) NOT NULL,
    is_active BOOLEAN NOT NULL DEFAULT true,
    is_legacy BOOLEAN NOT NULL DEFAULT false,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE pharmacy_delivery_areas (
    pharmacy_id UUID NOT NULL REFERENCES pharmacies(id) ON DELETE CASCADE,
    area_id UUID NOT NULL REFERENCES areas(id) ON DELETE CASCADE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (pharmacy_id, area_id)
);

CREATE INDEX idx_pharmacy_delivery_areas_area_pharmacy
    ON pharmacy_delivery_areas(area_id, pharmacy_id);
```

### Step 2 — Migration B: Requests Column (Nullable) + Index

Adds `area_id` to `requests` as **nullable** first. This is safe to deploy before the application code sends `area_id`.

```sql
ALTER TABLE requests ADD COLUMN area_id UUID REFERENCES areas(id);
CREATE INDEX idx_requests_area_id ON requests(area_id);
```

### Step 3 — Backfill: Legacy Areas

Creates one "Legacy Area" per active zone and assigns all existing requests to it. Legacy Areas are permanent and **cannot be deleted** — they serve as the compatibility layer for historical requests.

```sql
-- Create one Legacy Area per zone
INSERT INTO areas (zone_id, name, is_legacy)
SELECT id, 'Legacy Area', true
FROM zones
WHERE is_active = true;

-- Backfill existing requests
UPDATE requests r
SET area_id = a.id
FROM areas a
WHERE a.zone_id = r.zone_id
  AND a.is_legacy = true
  AND r.area_id IS NULL;
```

> **Legacy Area Invariant:** Rows in `areas` where `is_legacy = true` must never be deleted. Admin delete endpoints must enforce `WHERE is_legacy = false`. This guarantees historical request integrity.

### Step 4 — Application Deployment

Deploy the updated application code that:
- Requires `area_id` in the request creation payload.
- Validates DA-5 (zone–area consistency) before INSERT.
- Modifies `queryEligiblePharmacies()` to include the `pharmacy_delivery_areas` JOIN.

### Step 5 — Final Migration: NOT NULL Constraint

Only after the application is deployed and all requests have an `area_id`:

```sql
ALTER TABLE requests ALTER COLUMN area_id SET NOT NULL;
```

---

## 2. Request Creation Validation (DA-5)

**Target:** Request creation service/route.

Before inserting a new request, validate the incoming `area_id` against the `zone_id`:

```javascript
const areaCheck = await client.query(
    'SELECT zone_id FROM areas WHERE id = $1 AND is_active = true',
    [area_id]
);
if (!areaCheck.rows.length || areaCheck.rows[0].zone_id !== zone_id) {
    throw new Error('DA-5 Violation: area_id does not belong to the specified zone_id');
}
```

---

## 3. Routing Worker Query Modification

**Target:** `src/workers/routing-worker.js` → `queryEligiblePharmacies()`

The existing eligibility query is modified to add an explicit `INNER JOIN` on `pharmacy_delivery_areas`. This narrows the candidate set to pharmacies that serve the request's specific area.

```sql
SELECT p.id, p.trust_score
FROM pharmacies p
JOIN pharmacy_delivery_areas pda
  ON pda.pharmacy_id = p.id
-- ... existing insurance / blocked logic unchanged ...
WHERE p.zone_id = $1
  AND pda.area_id = $2
  AND p.is_active = true
  AND p.supports_rare_medicine = COALESCE($3, p.supports_rare_medicine)
ORDER BY p.trust_score DESC;
```

**DA-4 Fail-Closed Enforcement:** The `INNER JOIN` naturally enforces this invariant. If a pharmacy has zero rows in `pharmacy_delivery_areas`, the `JOIN` produces zero matches, and the pharmacy receives zero requests. No additional `WHERE` clause is needed.

**Escalation Preservation:** The `loadActiveTiers`, `processJob`, `createWave`, `waitForWaveWindow`, and `completeWave` functions remain 100% untouched. Tier percentages are simply applied to the narrowed result set.

---

## 4. Concurrency Verification

- **Locking Risk:** ZERO. `queryEligiblePharmacies` is a read-only `SELECT`. The added `INNER JOIN` acquires no write locks.
- **MVCC Safety:** If an admin updates a pharmacy's delivery areas while a routing sweep is in progress, PostgreSQL's MVCC ensures the query sees the committed snapshot at query start time. No tearing or deadlock can occur.
- **Transaction Boundaries:** The worker's `FOR UPDATE SKIP LOCKED` on `routing_jobs` remains untouched. The area-filtered read occurs after the job lock is acquired, within the same existing transaction scope.

---

## 5. Admin Operations

- **Area CRUD:** `POST /admin/areas`, `GET /admin/areas`, `DELETE /admin/areas/:id` (enforces `is_legacy = false`).
- **Pharmacy Area Assignment:** `PUT /pharmacies/:id/areas` accepts an array of `area_id`s. Executes `DELETE WHERE pharmacy_id = $1` then bulk `INSERT`.
- **Effect Timing:** Changes apply to all subsequent routing jobs. In-flight jobs use their snapshotted pharmacy set.

---

## 6. Rollout Summary

| Step | Action | Risk |
|------|--------|------|
| 1 | Migration A: Base tables | None — new tables only |
| 2 | Migration B: Nullable `area_id` + index | None — additive column |
| 3 | Backfill: Legacy Areas | None — fills NULLs only |
| 4 | App Deploy: DA-5 + routing JOIN | Low — narrowing only |
| 5 | Final Migration: `NOT NULL` | None — all rows filled |
