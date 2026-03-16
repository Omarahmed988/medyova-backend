# MEDYOVA — LAUNCH HARDENING SPEC (REVISION 2)

This specification details the tooling, scaling strategy, monitoring, and readiness requirements necessary to bring Medyova to production, ensuring maximum reliability and liquidity.

## 1. Pharmacy Onboarding Tooling
To onboard pharmacies efficiently without paralyzing the operations team, the following tooling and workflows must be established:

- **Inventory Upload UX (Portal)**: 
  A drag-and-drop web interface for pharmacies to upload their Point of Sale (POS) Excel exports. Before applying the upload, the portal renders a **Validation Preview** detailing:
  - Exact matches
  - Unmatched rows (flagged for alias creation)
  - Errors (e.g., missing prices, invalid quantities)
- **Alias Management Dashboard (Admin)**: 
  A centralized admin view that aggregates the most frequently unmatched `rawName` strings from recent pharmacy uploads. Admins can bulk-map these strings to canonical `medicine_id`s, instantly resolving the unmatched items for all future uploads.
- **Delivery-Area Assignment (Admin)**: 
  A geospatial or dropdown assignment tool allowing founders to strictly bind newly registered pharmacies to their operational `areas` via `pharmacy_delivery_areas`. 
- **Pharmacy Activation Workflow**: 
  Pharmacies cannot receive orders immediately upon registration. The system enforces a staggered workflow:
  `[Registered] → [Inventory Uploaded (>= x items)] → [Delivery Area Assigned] → [is_active = true]`

## 2. Medicine Catalog Expansion Strategy
The catalog must safely scale from the initial seed dataset (Egypt Drug Authority subset) to a comprehensive, localized registry.

- **Alias Expansion Strategy**:
  Pharmacies use highly fragmented naming conventions. The alias table (`medicine_aliases`) will continuously grow probabilistically. The system will harvest unmatched search queries and unmatched inventory uploads, aggregating them by frequency to prioritize admin mapping efforts.
- **Duplicate Detection**:
  A background cron job will analyze the `medicines` table using trigram similarity (e.g., `similarity > 0.85`), flagging potential duplicates for admin review.
- **Data Correction Workflow**:
  When an admin confirms a duplicate, a "Target ID" is chosen. The system performs a cascade merge:
  - Re-points all `pharmacy_inventory.medicine_id` references to the Target ID.
  - Re-points all `order_items.medicine_id` references.
  - Converts the duplicate's name into a new alias mapping to the Target ID.
  - Soft-deletes or hard-deletes the duplicate record.

## 3. Operational Monitoring
Crucial signals required to maintain a healthy marketplace. These will be monitored via Grafana / Metabase SQL queries.

- **Stale Inventory (> 48h)**:
  Identifies pharmacies falling behind on inventory syncs.
  ```sql
  SELECT p.id, p.name, MAX(pi.updated_at) AS last_sync
  FROM pharmacies p
  JOIN pharmacy_inventory pi ON pi.pharmacy_id = p.id
  WHERE p.is_active = true
  GROUP BY p.id, p.name
  HAVING MAX(pi.updated_at) < NOW() - INTERVAL '48 hours';
  ```
- **Low Pharmacy Density Areas**:
  Alerts when an area drops below the minimum required liquidity.
  ```sql
  SELECT a.name, COUNT(pda.pharmacy_id) AS active_pharmacies
  FROM areas a
  LEFT JOIN pharmacy_delivery_areas pda ON pda.area_id = a.id
  LEFT JOIN pharmacies p ON pda.pharmacy_id = p.id AND p.is_active = true
  WHERE a.is_active = true AND a.founder_override = false
  GROUP BY a.id, a.name
  HAVING COUNT(pda.pharmacy_id) < 2;
  ```
- **Medicine Search Failures**:
  Aggregates empty search queries to identify missing catalog items.
  *(Requires application-level logging of `q` when `MedicinesSearch` returns 0 results).*
- **High Escalation Rates in Routing (Flow A)**:
  Alerts on routing decay.
  ```sql
  SELECT area_id, 
         COUNT(*) as total_requests,
         SUM(CASE WHEN status IN ('escalated', 'failed', 'cancelled') THEN 1 ELSE 0 END) as failure_count
  FROM requests
  WHERE created_at >= NOW() - INTERVAL '24 hours'
  GROUP BY area_id
  HAVING (SUM(CASE WHEN status IN ('escalated', 'failed', 'cancelled') THEN 1 ELSE 0 END) * 100.0 / COUNT(*)) > 15.0;
  ```
- **Medicine Coverage (Fragile Supply)**:
  Detects medicines available in fewer than two active pharmacies, flagging them before they disappear from search completely if one pharmacy runs out of stock.
  ```sql
  SELECT
      m.name,
      COUNT(DISTINCT pi.pharmacy_id) AS pharmacies_with_medicine
  FROM medicines m
  JOIN pharmacy_inventory pi ON pi.medicine_id = m.id
  JOIN pharmacies p ON p.id = pi.pharmacy_id
  WHERE p.is_active = true
  GROUP BY m.name
  HAVING COUNT(DISTINCT pi.pharmacy_id) < 2;
  ```
- **Medicine Search Latency**:
  Medicine search is a core entry point. This requires tracking `GET /medicines/search` metrics (e.g., via Prometheus/Grafana or application logs):
  - Average latency
  - 95th percentile latency
  - Query failure rate
  *Alert Trigger*: If 95th percentile search latency consistently exceeds 300ms, indicating trigram index scaling issues.
  
  *Search Response Guardrail*: To ensure consistent latency and manageable client payload responses, search results must strictly limit the number of active pharmacies returned per medicine to **max 5 pharmacies**.
- **Pharmacy Inventory Health Score (0-100)**:
  A composite, purely operational score to identify pharmacies needing intervention. Variables include:
  - **Freshness**: Delta since last update.
  - **Frequency**: Average number of Excel uploads per week.
  - **Catalog Breadth**: Number of active medicines listed in their inventory.
  Pharmacies dropping below a threshold score are flagged for operational outreach.

## 4. Marketplace Liquidity Monitoring
Because Medyova relies on **strict area-level routing fragmentation** (fail-closed architecture via `INNER JOIN`), users are physically restricted to pharmacies explicitly mapped to their area. 

**Operational Implications**:
- If an area has high pharmacy count but low catalog diversity, users will experience search failures even if adjacent areas have the medicine.
- If an area's pharmacies all drop offline, the entire geographical sector fails-closed immediately.

**Monitoring Signals for Low Liquidity**:
- **Offer Velocity (Routing latency)**: The average time delta between a request entering `pending` and receiving its first `offer`. High latency directly signals low pharmacy engagement within that sector.
- **Out-of-Stock Cascades**: Frequent occurrences where users attempt Flow B searches and see results heavily skewed towards `stock_status = 'out_of_stock'`.
- **Active Node Churn**: Monitoring intra-day drops in `pharmacies.is_active`. If pharmacies log off during evening shifts, the active density monitor must explicitly measure *online* pharmacies, triggering failover alerts if density falls below the threshold.

## 5. Launch Readiness Checklist
Before the platform goes live, the following assertions must evaluate strictly to true:

- [ ] **Routing Stability**: The routing worker must execute under load without database deadlocks; `orders_prescription_integrity` constraints remain strictly upheld.
- [ ] **Minimum Pharmacies per Area**: Every `is_active=true` area has at least 2 active pharmacies mapped to it (or explicitly carries the `founder_override` flag).
- [ ] **Catalog Completeness**: The 500 most heavily prescribed medicines in the region are seeded into the database with accurate trigram mappings and common local aliases.
- [ ] **Inventory Freshness Compliance**: At least 80% of active pharmacies have successfully pushed an Excel inventory update via the normalization pipeline within the 48 hours preceding launch.
- [ ] **Audit Trail Resilience**: The Founder Control Layer is actively logging config mutations to `system_audit_logs` securely without blocking application responses.
