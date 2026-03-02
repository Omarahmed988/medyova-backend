'use strict';

/**
 * Offer Acceptance Service — Phase 6 + Phase 7
 *
 * Implements the 8-step atomic acceptance transaction:
 *   Steps 1-7: Acceptance Spec v2 §2.3
 *   Step 8:    Order creation (Order Lifecycle Spec v2 §2.2)
 *
 * Lock order: requests → offers (deadlock prevention rule §2.3).
 * No compensating transactions — uses in-transaction re-verification.
 *
 * This service is responsible for:
 *   - Locking the request row FIRST
 *   - Re-verifying request state under lock
 *   - Locking the target offer
 *   - Accepting the target offer
 *   - Rejecting all other pending offers
 *   - Transitioning request.state to 'accepted'
 *   - Creating the order row (Step 8)
 *
 * It does NOT handle auth or ownership — that is the route's job.
 */

const { pool } = require('../config/db');

/**
 * Commission rate as a percentage. Configurable via environment variable.
 * Default: 10.00 (10%)
 */
const COMMISSION_RATE_PERCENT = parseFloat(
    process.env.COMMISSION_RATE_PERCENT || '10.00'
);

/**
 * Error codes for acceptance failures (Spec v2 §2.4).
 */
const ERROR_CODES = {
    REQUEST_NOT_FOUND: 'request_not_found',
    OFFER_NOT_FOUND: 'offer_not_found',
    REQUEST_NOT_ACCEPTING: 'request_not_accepting',
    OFFER_ALREADY_ACCEPTED: 'offer_already_accepted',
    OFFER_ALREADY_REJECTED: 'offer_already_rejected',
    OFFER_EXPIRED: 'offer_expired',
};

/**
 * Attempt to accept an offer for a request.
 *
 * @param {string} requestId - UUID of the request
 * @param {string} offerId - UUID of the offer to accept
 * @returns {Promise<{success: boolean, idempotent?: boolean, order_id?: string, error_code?: string, message?: string}>}
 */
async function acceptOffer(requestId, offerId) {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        // ── Step 1: Lock the REQUEST row FIRST (deadlock-prevention rule) ──
        const requestLock = await client.query(
            'SELECT state FROM requests WHERE id = $1 FOR UPDATE',
            [requestId]
        );

        if (requestLock.rows.length === 0) {
            await client.query('ROLLBACK');
            return { success: false, error_code: ERROR_CODES.REQUEST_NOT_FOUND, message: 'Request not found.' };
        }

        // ── Step 2: Re-verify request state under lock ───────────────────
        const requestState = requestLock.rows[0].state;
        const acceptableStates = ['fully_offered', 'partially_offered'];

        if (!acceptableStates.includes(requestState)) {
            await client.query('ROLLBACK');

            // If already accepted, check if THIS offer was the one accepted (idempotent)
            if (requestState === 'accepted') {
                const acceptedCheck = await client.query(
                    'SELECT status FROM offers WHERE id = $1 AND request_id = $2',
                    [offerId, requestId]
                );
                if (acceptedCheck.rows[0]?.status === 'accepted') {
                    return { success: true, idempotent: true };
                }
                return { success: false, error_code: ERROR_CODES.OFFER_ALREADY_REJECTED, message: 'Another offer has already been accepted for this request.' };
            }

            return { success: false, error_code: ERROR_CODES.REQUEST_NOT_ACCEPTING, message: `Request is in state '${requestState}' and cannot accept offers.` };
        }

        // ── Step 3: Lock the target offer ─────────────────────────────────
        const offerLock = await client.query(
            'SELECT id, status FROM offers WHERE id = $1 AND request_id = $2 FOR UPDATE',
            [offerId, requestId]
        );

        if (offerLock.rows.length === 0) {
            await client.query('ROLLBACK');
            return { success: false, error_code: ERROR_CODES.OFFER_NOT_FOUND, message: 'Offer not found or does not belong to this request.' };
        }

        // ── Step 4: Re-verify offer status under lock ────────────────────
        const offerStatus = offerLock.rows[0].status;

        if (offerStatus === 'accepted') {
            // Idempotent re-acceptance of the same offer
            await client.query('ROLLBACK');
            return { success: true, idempotent: true };
        }

        if (offerStatus !== 'pending') {
            await client.query('ROLLBACK');
            if (offerStatus === 'rejected') {
                return { success: false, error_code: ERROR_CODES.OFFER_ALREADY_REJECTED, message: 'This offer has already been rejected because another offer was accepted.' };
            }
            if (offerStatus === 'expired') {
                return { success: false, error_code: ERROR_CODES.OFFER_EXPIRED, message: 'This offer has expired.' };
            }
            return { success: false, error_code: ERROR_CODES.OFFER_ALREADY_REJECTED, message: `Offer is in state '${offerStatus}' and cannot be accepted.` };
        }

        // ── Step 5: Accept the target offer ──────────────────────────────
        await client.query(
            `UPDATE offers SET status = 'accepted', updated_at = now()
             WHERE id = $1 AND status = 'pending'`,
            [offerId]
        );

        // ── Step 6: Reject all other pending offers ──────────────────────
        await client.query(
            `UPDATE offers SET status = 'rejected', updated_at = now()
             WHERE request_id = $1 AND id != $2 AND status = 'pending'`,
            [requestId, offerId]
        );

        // ── Step 7: Transition request state ─────────────────────────────
        await client.query(
            `UPDATE requests SET state = 'accepted', updated_at = now()
             WHERE id = $1 AND state IN ('fully_offered', 'partially_offered')`,
            [requestId]
        );

        // ── Step 8: Create order from accepted offer (Order Spec v2 §2.2) ─
        const orderResult = await client.query(
            `INSERT INTO orders (
                id, request_id, offer_id, pharmacy_id, user_id,
                total_price, delivery_fee,
                commission_rate, commission_amount, commission_status,
                status, created_at, updated_at
            )
            SELECT
                gen_random_uuid(),
                o.request_id,
                o.id,
                o.pharmacy_id,
                r.user_id,
                o.total_price,
                o.delivery_fee,
                $2,
                ROUND(o.total_price * $2 / 100, 2),
                'pending',
                'pending',
                now(),
                now()
            FROM offers o
            JOIN requests r ON r.id = o.request_id
            WHERE o.id = $1
            RETURNING id`,
            [offerId, COMMISSION_RATE_PERCENT]
        );

        const orderId = orderResult.rows[0]?.id;

        await client.query('COMMIT');

        return { success: true, idempotent: false, order_id: orderId };
    } catch (err) {
        await client.query('ROLLBACK').catch(() => { });
        throw err;
    } finally {
        client.release();
    }
}

module.exports = {
    acceptOffer,
    ERROR_CODES,
    COMMISSION_RATE_PERCENT,
};
