# Phase 19 — Two-Sided Loyalty System
## Pharmacy Performance Score Specification

### Goal
Implement a fair, transparent performance scoring system for pharmacies that prioritizes medicine availability and operational responsiveness, directly rewarding behaviors that improve the Medyova marketplace experience.

### Pharmacy Performance Score Weights
The total pharmacy performance score is calculated based on five key factors, weighted as follows:

| Factor | Weight |
| --- | --- |
| **Response Time** | 25% |
| **Medicine Availability** | 35% |
| **Customer Ratings** | 20% |
| **Order Cancellation Rate** | 10% |
| **Inventory Freshness / Upload Frequency** | 10% |

**Total:** 100%

### Factor Definitions

1. **Response Time (25%)**
   - Measures how quickly the pharmacy responds to requests (accepts/rejects) during Flow A (Prescription routing).
   - **Metric Calculation**: `offer_response_time = offer_response_at - offer_created_at`
   - Must use the **median** response time across the window (rather than average) to prevent extreme outliers from distorting the score.
   - **Boundary Cap**: The median response time is capped at a maximum of **15 minutes**. Values above the cap are treated as 15 minutes for normalization purposes.

2. **Medicine Availability (35%)**
   - Measures actual order fulfillment success rates rather than search hits.
   - **Metric Calculation**: `availability = successful_items / requested_items` where `requested_items` are all order tracking items requested in the rolling window, and `successful_items` are items fulfilled without cancellation or substitution.
   - Highest weighted metric to directly incentivize pharmacies to fulfill their accepted orders accurately.

3. **Customer Ratings (20%)**
   - The aggregated average rating provided by users upon completed orders.

4. **Order Cancellation Rate (10%)**
   - Acts as a **negative factor** that directly reduces the final score.
   - Measures the frequency at which a pharmacy cancels an accepted order before fulfillment.
   - **Penalty Math**: `effective_score = raw_score * (1 - cancellation_rate)` ensures cancellation behavior directly and significantly reduces the final performance score.

5. **Inventory Freshness / Upload Frequency (10%)**
   - Refers to how frequently the pharmacy dynamically updates its inventory data (e.g., via the automated Excel upload tool or manual portal edits).
   - Encourages continuous sync between physical shelves and digital marketplace availability.

### Measurement Window & Score Baseline

To ensure scores reflect recent behavior while preventing small-sample distortions, the following rules apply:

1. **Rolling 30-Day Window**
   - All dynamic metrics (response time, cancel rate, availability) are calculated exclusively over the preceding 30 days.
   - Example: A canceled order on day 31 rolling off the window will immediately improve the pharmacy's cancellation rate score upon the next recalculation.

2. **Minimum Order Threshold**
   - A pharmacy must have completed at least **20 orders** within the rolling 30-day window to trigger an active score calculation.
   - If a pharmacy falls below this threshold (e.g., a newly onboarded pharmacy or a dormant one), its score defaults to a **neutral baseline** (e.g., `50` or `null` display) so it is not artificially penalized or rewarded.

---

### Score Calculation Architecture (Background Worker)

Pharmacy scores **MUST NOT** be calculated synchronously during any critical order flow or REST request, as this would introduce severe database load spikes.

**Architecture:**
- **`pharmacy-score-calculator.js` (Worker)**
  - A standalone background worker process running on a schedule (e.g., hourly via `node-cron`).
  - **Incremental Recalculation**: The worker does not recompute all pharmacies globally every cycle. Instead, it computes scores only for pharmacies that had recorded activity (offers received, inventory updated, etc.) within the last **24 hours**. This ensures horizontal scalability as the marketplace grows.
  - Fetches the raw 30-day metrics, computes the 5-factor weighted algorithm, resolves the Tier, and updates a dedicated `pharmacy_scores` table.
- Read operations (e.g., Search or User Apps) simply select the aggregated score and tier from the `pharmacy_scores` table.

---

### Architectural Constraints & Boundaries
The pharmacy performance score must **NOT** modify routing fairness.

**It may influence:**
- Search visibility (ranking higher in Flow B / Medicine Search)
- Promotional badges (e.g., "Top Rated", "Fast Responder")
- Marketplace ranking indicators displayed to users

**It MUST NOT interfere with:**
- `queryEligiblePharmacies` (Geospatial and tier-based discovery)
- `routing-worker.js` (The core wave-based broadcast logic)
- `offerAcceptance.js` (The first-to-accept locking mechanism)

The integrity and invariants of Flow A and Flow B processes must be fully preserved.
