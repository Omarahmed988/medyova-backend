'use strict';

/**
 * Offer Selection Service — Phase 5B
 *
 * Implements the Marketplace Ranking Policy (Governance Spec v2 §4):
 *   - Two-Level Ranking: coverage classification → composite score
 *   - Default visible offers: 2, maximum: 3
 *   - Price is NOT a ranking factor (§4.3 — permanently excluded)
 *
 * This service is PURE ranking/filtering logic.
 * It does NOT enforce visibility gates — that is the route handler's job (§6.2).
 * It does NOT modify any state.
 */

const { query } = require('../config/db');

/**
 * Get the top-ranked offers for a request using the Two-Level Ranking Model.
 *
 * Level 1 — Coverage Classification:
 *   If any full coverage offer exists (coverage_ratio = 100.00),
 *   only full coverage offers are considered.
 *   Otherwise, all offers are considered.
 *
 * Level 2 — Composite Score (within coverage level):
 *   1. trust_score DESC        (primary — trust incentivizes quality)
 *   2. acceptance_rate DESC    (secondary — reliability / commitment)
 *   3. response_rate DESC      (tertiary — responsiveness / consistency)
 *   4. created_at ASC          (tiebreaker — earliest response wins)
 *
 * Price is visible to the client but NEVER influences ranking.
 *
 * @param {string} requestId - UUID of the request
 * @param {number} [limit=2] - Number of offers to return (max 3)
 * @returns {Promise<Array>} Top-ranked offers with pharmacy details
 */
async function getTopOffersForRequest(requestId, limit = 2) {
    // Enforce max 3 visible offers (Marketplace Exposure Policy)
    const safeLimit = Math.min(Math.max(1, parseInt(limit, 10) || 2), 3);

    // Single query with two-level ranking:
    // 1. CTE determines if any full coverage offers exist
    // 2. Main query filters by coverage level and sorts by composite score
    const { rows } = await query(`
        WITH coverage_check AS (
            SELECT EXISTS(
                SELECT 1 FROM offers
                WHERE request_id = $1
                  AND coverage_ratio = 100.00
            ) AS has_full_coverage
        )
        SELECT
            o.id AS offer_id,
            o.request_id,
            o.pharmacy_id,
            o.status AS offer_status,
            o.coverage_ratio,
            o.total_price,
            o.delivery_fee,
            o.prep_time_minutes,
            o.notes,
            o.created_at AS offer_created_at,
            p.name AS pharmacy_name,
            p.trust_score,
            p.acceptance_rate,
            p.response_rate,
            p.zone_id AS pharmacy_zone_id,
            p.tier_id AS pharmacy_tier_id
        FROM offers o
        JOIN pharmacies p ON p.id = o.pharmacy_id
        CROSS JOIN coverage_check cc
        WHERE o.request_id = $1
          -- Level 1: Coverage classification filter
          AND (
              (cc.has_full_coverage = true AND o.coverage_ratio = 100.00)
              OR
              (cc.has_full_coverage = false)
          )
        -- Level 2: Composite score ordering (Governance Spec v2 §4.1)
        ORDER BY
            p.trust_score DESC,
            p.acceptance_rate DESC,
            p.response_rate DESC,
            o.created_at ASC
        LIMIT $2
    `, [requestId, safeLimit]);

    return rows;
}

module.exports = {
    getTopOffersForRequest,
};
