'use strict';

/**
 * Offers Route — GET /requests/:id/offers
 *
 * Returns top-ranked offers for a given request, subject to the
 * Visibility Gate (Governance Spec v2 §2.2).
 *
 * Gate Rule:
 *   selection_allowed = (
 *       request.state IN ('fully_offered', 'partially_offered')
 *       AND routing_jobs.status IN ('completed', 'expired')
 *   )
 *
 * If gate fails → HTTP 200 with [] (empty array).
 * If gate passes → delegates to offerSelection service for ranking.
 *
 * Defensive recovery:
 *   If request.state = 'expired' but full coverage offers exist,
 *   log invariant_violation_I1 and still serve the offers (§3.3).
 *
 * Separation of Concerns (§6.2):
 *   This route handler is the SOLE enforcer of the visibility gate.
 *   The service layer is pure ranking/filtering — no gate logic.
 */

const express = require('express');
const router = express.Router();
const { query } = require('../config/db');
const { getTopOffersForRequest } = require('../services/offerSelection');

/**
 * GET /requests/:id/offers
 *
 * Query params:
 *   - limit (optional): 1–3, default 2
 *
 * Response: { offers: [...] }
 */
router.get('/:id/offers', async (req, res, next) => {
    try {
        const requestId = req.params.id;
        const limit = req.query.limit ? parseInt(req.query.limit, 10) : 2;

        // ── Visibility Gate (Governance Spec v2 §2.2) ────────────────────

        // 1. Load request state
        const requestResult = await query(
            'SELECT state FROM requests WHERE id = $1',
            [requestId]
        );

        if (requestResult.rows.length === 0) {
            return res.status(404).json({
                error: 'Not Found',
                message: 'Request not found.',
                statusCode: 404,
            });
        }

        const requestState = requestResult.rows[0].state;

        // 2. Load routing job status
        const jobResult = await query(
            'SELECT status FROM routing_jobs WHERE request_id = $1',
            [requestId]
        );

        const jobStatus = jobResult.rows.length > 0
            ? jobResult.rows[0].status
            : null;

        // 3. Evaluate visibility gate
        const allowedRequestStates = ['fully_offered', 'partially_offered'];
        const allowedJobStatuses = ['completed', 'expired'];

        const gatePass = allowedRequestStates.includes(requestState)
            && jobStatus !== null
            && allowedJobStatuses.includes(jobStatus);

        // 4. Defensive recovery: expired + full coverage (§3.3)
        //    If request is expired but full coverage offers exist, still serve them
        let defensiveRecovery = false;
        if (!gatePass && requestState === 'expired') {
            const fullCoverageCheck = await query(
                `SELECT EXISTS(
                    SELECT 1 FROM offers
                    WHERE request_id = $1 AND coverage_ratio = 100.00
                ) AS has_full_coverage`,
                [requestId]
            );

            if (fullCoverageCheck.rows[0]?.has_full_coverage) {
                defensiveRecovery = true;
                console.warn(JSON.stringify({
                    level: 'warn',
                    component: 'offers-route',
                    event: 'invariant_violation_I1',
                    request_id: requestId,
                    request_state: requestState,
                    job_status: jobStatus,
                    message: 'request.state=expired but full coverage offers exist',
                    timestamp: new Date().toISOString(),
                }));
            }
        }

        // 5. Gate decision
        if (!gatePass && !defensiveRecovery) {
            return res.status(200).json({ offers: [] });
        }

        // ── Gate passed — delegate to selection service ───────────────────
        const offers = await getTopOffersForRequest(requestId, limit);

        return res.status(200).json({ offers });
    } catch (err) {
        next(err);
    }
});

module.exports = router;
