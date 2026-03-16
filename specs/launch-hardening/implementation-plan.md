# Phase 15 — Launch Hardening Implementation Plan

> **Goal**: Develop operational tooling and monitoring mechanisms required to safely scale Medyova's new Medicine Search flow (Flow B) to production.
> **Scope**: Admin APIs, Monitoring Cron Jobs/Queries, and Health Scoring.

---

## 1. Pharmacy Onboarding Tooling

We need to build out the Admin APIs that power the operational portal.

### [NEW] Admin Alias Management endpoints (Extensions)
Phase 14 mostly implemented `POST` and `DELETE` for aliases. Now we need querying capabilities for the dashboard.
- **`GET /admin/medicines/aliases/unmatched`**
  - Reads from a new table (or log) of failed searches/uploads. 
  - To keep it simple, we will create an `unmatched_medicines` log table:
    `id, raw_name, source (search|upload), frequency_count, created_at, updated_at`
  - Upsert on new failures to increment `frequency_count`.
- **`POST /admin/medicines/:id/aliases/bulk`**
  - Accepts an array of strings (aliases) to map to a canonical `medicine_id` at once.
  - Automatically deletes them from `unmatched_medicines` if they exist.

### [NEW] Admin Delivery-Area Assignment
- **`POST /admin/pharmacies/:id/areas`**
  - Maps a pharmacy to an area by inserting into `pharmacy_delivery_areas`.
- **`DELETE /admin/pharmacies/:id/areas/:areaId`**
  - Removes a pharmacy from an area.
- This controls the `[Delivery Area Assigned]` stage of the Pharmacy Activation Workflow.

---

## 2. Medicine Catalog Expansion Strategy

### Duplicate Detection Cron Job
- **[NEW] `src/workers/catalog-duplicate-scanner.js`**
  - A background process (triggered via `node-cron` or standard PM2 interval) that uses `pg_trgm` to find medicines with `similarity(name, other_name) > 0.85`.
  - Results are written to a new table: `catalog_duplicates_report` (id, medicine_a_id, medicine_b_id, similarity_score, resolved, created_at).
- **[NEW] `GET /admin/medicines/duplicates`**
  - Returns the unresolved reports for admin review.
- **[NEW] `POST /admin/medicines/merge`**
  - Accepts `{ source_id, target_id }`.
  - Re-points `pharmacy_inventory` and `order_items` references.
  - Converts `source_id` name to an alias mapping to `target_id`.
  - Soft-deletes `source_id` (sets `is_active = false`).

---

## 3. Operational Monitoring & Health Scores

We will expose the SQL queries defined in the Spec via a new set of Admin Metric endpoints.

### [NEW] `src/services/marketplaceMonitorService.js`
- `getStaleInventory(thresholdHours)`
- `getLowDensityAreas(minPharmacies)`
- `getFragileMedicines(minCoverage)`

### [NEW] `GET /admin/monitoring/inventory-health`
Returns a scored list of pharmacies based on the composite Health Score:
- **Freshness**: Delta since `pi.updated_at`.
- **Frequency**: Uploads per week (we will track uploads in an `inventory_upload_logs` table).
- **Catalog Breadth**: `COUNT(pi.medicine_id)`.

---

## Required Migrations

1. **`unmatched_medicines`**
   - Tracks missing aliases to drive the admin dashboard.
2. **`catalog_duplicates_report`**
   - Stores background scanner results.
3. **`inventory_upload_logs`**
   - Replaces the in-memory array rate-limiter with persistent DB tracking, which also enables the "Upload Frequency" metric for the Health Score.

## Verification Plan

- **Automated Tests**: Unit tests for the duplicate scanner trigram logic, API tests covering the bulk alias mapping, area assignment, and merge cascade logic.
- **Monitoring Queries**: Execute the Grafana-intended SQL views directly against the seed DB to verify output formatting and performance bounds.
