# Medyova — Phase 19 Implementation Plan
## Pharmacy Performance Scoring & Loyalty System

### Overview
This phase introduces the Pharmacy Performance Score calculation. It implements the approved 5-factor weighted algorithm via an asynchronous background worker that runs periodically, ensuring core order flows and routing remain fully decoupled and highly performant.

### 1. Database Schema Additions
A new `pharmacy_scores` table is required to store the aggregated scores.

#### `migrations/1777000000000_layer19-pharmacy-scores.js`
Create the `pharmacy_scores` table.
- `id` (uuid, primary key)
- `pharmacy_id` (uuid, foreign key to pharmacies, unique)
- `total_score` (numeric, default 50.00)
- `response_time_score` (numeric)
- `availability_score` (numeric)
- `rating_score` (numeric)
- `freshness_score` (numeric)
- `cancellation_rate` (numeric)
- `tier` (character varying, e.g., 'platinum', 'gold', 'silver', 'bronze')
- `last_calculated_at` (timestamp)
- `created_at`, `updated_at`

*Note: If `pharmacies` needs an explicit trigger or foreign key linking to this cache table, it can be defined here.*

### 2. Score Calculator Logic Module
A dedicated module to query the rolling 30-day stats and compute the score for each pharmacy.

#### `src/services/pharmacyScoreService.js` [NEW]
- `calculateScores()`
  - Identifies pharmacies with activity in the last 24 hours.
  - Filters out pharmacies with $< 20$ completed orders in the rolling 30 days (they default to a neutral baseline score of 50.00 / Bronze).
  - For active, qualified pharmacies, calculates:
    1. **Median Response Time**: Uses PostgreSQL percentile calculations (`percentile_cont(0.5) WITHIN GROUP (ORDER BY (offer_response_at - offer_created_at))`). Caps result at a maximum of 15 minutes.
    2. **Medicine Availability**: `successful_items / requested_items` extracted from `order_items` attached to the orders falling within the rolling 30 days.
    3. **Customer Ratings**: Average score for completed orders over 30 days.
    4. **Cancellation Rate**: `canceled_orders / (completed_orders + canceled_orders)`.
    5. **Inventory Freshness**: Time since last `updated_at` modification on `pharmacy_inventory`.
  - Normalizes each factor to a 0-100 scale.
  - Applies Weights: `(Response * 0.25) + (Availability * 0.35) + (Rating * 0.20) + (Freshness * 0.10)`.
  - Applies Penalty: `FinalScore = RawScore * (1 - CancellationRate)`.
  - **Tier Mapping**: Assesses `platinum` (90+), `gold` (75+), `silver` (60+), or `bronze` (<60).
  - Upserts into `pharmacy_scores`.

### 3. Background Worker Process
The calculation must be run automatically via schedule.

#### `src/workers/pharmacy-score-calculator.js` [NEW]
- Standalone script/process (similar to existing workers) that instantiates `PharmacyScoreService`.
- Wraps the calculation in a transaction to safely compute and save scores across all active pharmacies in chunks.
- Scheduled via `node-cron` or an OS crontab in production. (For implementation mapping we just provide the executable node script).

### 4. Admin API Exposure

#### `src/routes/admin/pharmacies.js` [MODIFY]
- Extend existing GET `/admin/pharmacies/:id` or list endpoints to optionally `JOIN` with `pharmacy_scores` to display the transparency matrix to admins.

#### `src/routes/pharmacy/dashboard.js` [MODIFY]
- The pharmacy's own dashboard can fetch their breakdown from `pharmacy_scores`.

### 5. Architectural Invariants Safeguard
- **No changes** will be made to:
  - `queryEligiblePharmacies`
  - `routing-worker.js`
  - `offerAcceptance.js`
  - `DirectOrderService`
  - `InsuranceOrderService`
  - `SubscriptionOrderService` scheduler
- This guarantees zero impact on Flow A, Flow B, Flow C, or Flow D.

---
### Verification Plan
- Unit/Integration tests: `tests/phase19.test.js`
  - Insert mock 30-day historical data (orders, offers, inventory updates) for 3 test pharmacies.
    - Pharmacy A: Meets 20-order threshold, excellent stats, 0% cancellations $\rightarrow$ high score.
    - Pharmacy B: Meets threshold, excellent stats, 50% cancellations $\rightarrow$ score cut in half.
    - Pharmacy C: Fails 20-order threshold $\rightarrow$ neutral baseline (50).
  - Trigger worker `pharmacy-score-calculator.js`.
  - Assert the resulting rows in `pharmacy_scores` table accurately reflect the metric math.
  - Verify routing services remain untouched.
