'use strict';

/**
 * Offers Route — Phase 5B + Phase 6
 *
 * GET  /requests/:id/offers                          — Visibility-gated offer selection
 * POST /requests/:requestId/offers/:offerId/accept   — Offer acceptance
 *
 * Visibility Gate (Governance Spec v2 §2.2):
 *   selection_allowed = (
 *       request.state IN ('fully_offered', 'partially_offered')
 *       AND routing_jobs.status IN ('completed', 'expired')
 *   )
 *
 * Acceptance (Acceptance Spec v2 §2):
 *   Requires authentication + ownership.
 *   Uses 7-step atomic transaction with request→offer lock order.
 *   Returns structured error codes on 409.
 */

const express = require('express');
const router = express.Router();
const { query } = require('../config/db');
const { getTopOffersForRequest } = require('../services/offerSelection');
const { acceptOffer, ERROR_CODES } = require('../services/offerAcceptance');

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

/**
 * POST /requests/:requestId/offers/:offerId/accept
 *
 * Accepts an offer for a request (Acceptance Spec v2 §2).
 *
 * Requires:
 *   - Authentication (req.user must exist)
 *   - Ownership (request.user_id must match req.user.id)
 *
 * Response:
 *   200 — { accepted: true, offer_id, request_id, request_state: 'accepted' }
 *   401 — Unauthorized (no auth)
 *   403 — Forbidden (user doesn't own request)
 *   404 — Request or offer not found
 *   409 — Conflict with structured error_code
 */
router.post('/:requestId/offers/:offerId/accept', async (req, res, next) => {
    try {
        const { requestId, offerId } = req.params;

        // ── Authentication check ─────────────────────────────────────────
        if (!req.user || !req.user.id) {
            return res.status(401).json({
                error: 'Unauthorized',
                message: 'Authentication required to accept offers.',
                statusCode: 401,
            });
        }

        // ── Ownership check ──────────────────────────────────────────────
        const ownerCheck = await query(
            'SELECT user_id FROM requests WHERE id = $1',
            [requestId]
        );

        if (ownerCheck.rows.length === 0) {
            return res.status(404).json({
                error: 'Not Found',
                error_code: ERROR_CODES.REQUEST_NOT_FOUND,
                message: 'Request not found.',
                statusCode: 404,
            });
        }

        const requestOwnerId = ownerCheck.rows[0].user_id;
        if (requestOwnerId !== req.user.id) {
            return res.status(403).json({
                error: 'Forbidden',
                message: 'You do not own this request.',
                statusCode: 403,
            });
        }

        // ── Delegate to acceptance service ───────────────────────────────
        const result = await acceptOffer(requestId, offerId);

        if (result.success) {
            return res.status(200).json({
                accepted: true,
                offer_id: offerId,
                request_id: requestId,
                request_state: 'accepted',
            });
        }

        // Map error codes to HTTP status codes
        const statusMap = {
            [ERROR_CODES.REQUEST_NOT_FOUND]: 404,
            [ERROR_CODES.OFFER_NOT_FOUND]: 404,
            [ERROR_CODES.REQUEST_NOT_ACCEPTING]: 409,
            [ERROR_CODES.OFFER_ALREADY_ACCEPTED]: 409,
            [ERROR_CODES.OFFER_ALREADY_REJECTED]: 409,
            [ERROR_CODES.OFFER_EXPIRED]: 409,
        };

        const httpStatus = statusMap[result.error_code] || 409;

        return res.status(httpStatus).json({
            error: httpStatus === 404 ? 'Not Found' : 'Conflict',
            error_code: result.error_code,
            message: result.message,
            statusCode: httpStatus,
        });
    } catch (err) {
        next(err);
    }
});

module.exports = router;
