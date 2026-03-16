'use strict';

/**
 * reviewService.js — Phase 13: Order Rating System
 *
 * Service layer for:
 *   - Review submission (eligibility + insert + aggregate)
 *   - Review retrieval
 *   - Admin review deletion with aggregate recalculation
 *
 * Constraints:
 *   - pharmacy_id is ALWAYS derived from the orders row, never from client payload.
 *   - Review INSERT and aggregate UPDATE are decoupled:
 *       1. INSERT into order_reviews (autocommit)
 *       2. UPDATE pharmacies aggregate (separate statement)
 *     If the aggregate UPDATE fails, the error is logged but does NOT
 *     roll back the review insert. The review row is the source of truth;
 *     the aggregate is only a cache.
 *   - AVG(rating) is explicitly cast to NUMERIC(3,2) to prevent floating precision drift.
 */

const { query } = require('../config/db');

// ── Aggregate Recalculation ────────────────────────────────────────────────

/**
 * Recalculate rating_avg and rating_count for a pharmacy.
 * Runs as a standalone autocommit query — NOT inside any transaction.
 *
 * @param {string} pharmacyId
 */
async function recalculateAggregate(pharmacyId) {
    await query(`
        UPDATE pharmacies
        SET
            rating_count = (SELECT COUNT(*) FROM order_reviews WHERE pharmacy_id = $1),
            rating_avg   = COALESCE(
                             (SELECT AVG(rating)::NUMERIC(3,2) FROM order_reviews WHERE pharmacy_id = $1),
                             0.00
                           )
        WHERE id = $1
    `, [pharmacyId]);
}

// ── Review Submission ──────────────────────────────────────────────────────

/**
 * Submit a review for a completed order.
 *
 * Flow:
 *   1. Fetch order (status, user_id, pharmacy_id) — single read
 *   2. Validate status === 'completed'
 *   3. Validate ownership (authenticatedUserId === order.user_id)
 *   4. INSERT review — pharmacy_id sourced from orders row
 *   5. Recalculate aggregate (decoupled, failure-tolerant)
 *
 * @param {string} authenticatedUserId
 * @param {string} orderId
 * @param {number} rating  — integer 1–5
 * @param {string|null} comment — optional, max 500 chars
 * @returns {Promise<object>} the inserted review row
 */
async function submitReview(authenticatedUserId, orderId, rating, comment) {
    // Step 1: Eligibility check — single query
    const orderResult = await query(
        'SELECT status, user_id, pharmacy_id FROM orders WHERE id = $1',
        [orderId]
    );

    if (!orderResult.rows.length) {
        const err = new Error('Order not found');
        err.statusCode = 404;
        throw err;
    }

    const order = orderResult.rows[0];

    // Step 2: Status gate
    if (order.status !== 'completed') {
        const err = new Error('Reviews are only allowed for completed orders');
        err.statusCode = 422;
        throw err;
    }

    // Step 3: Ownership gate
    if (order.user_id !== authenticatedUserId) {
        const err = new Error('You can only review your own orders');
        err.statusCode = 403;
        throw err;
    }

    // Step 4: INSERT review — pharmacy_id derived from the order, not client input
    let review;
    try {
        const insertResult = await query(
            `INSERT INTO order_reviews (order_id, pharmacy_id, user_id, rating, comment)
             VALUES ($1, $2, $3, $4, $5)
             RETURNING id, order_id, pharmacy_id, user_id, rating, comment, created_at`,
            [orderId, order.pharmacy_id, authenticatedUserId, rating, comment || null]
        );
        review = insertResult.rows[0];
    } catch (err) {
        // UNIQUE(order_id) violation → 409
        if (err.code === '23505') {
            const conflict = new Error('A review already exists for this order');
            conflict.statusCode = 409;
            throw conflict;
        }
        throw err;
    }

    // Step 5: Aggregate recalculation — decoupled from insert
    // Failure here is logged but NEVER rolls back the review.
    try {
        await recalculateAggregate(order.pharmacy_id);
    } catch (err) {
        console.error('[review] Aggregate recalculation failed:', err.message);
    }

    return review;
}

// ── Review Retrieval ───────────────────────────────────────────────────────

/**
 * Get a review by order ID.
 * @param {string} orderId
 * @returns {Promise<object|null>}
 */
async function getReview(orderId) {
    const result = await query(
        'SELECT id, order_id, pharmacy_id, user_id, rating, comment, created_at FROM order_reviews WHERE order_id = $1',
        [orderId]
    );
    return result.rows[0] || null;
}

// ── Admin Deletion ─────────────────────────────────────────────────────────

/**
 * Delete a review by ID (admin moderation).
 * Triggers aggregate recalculation after deletion.
 *
 * @param {string} reviewId
 * @returns {Promise<void>}
 */
async function deleteReview(reviewId) {
    // 1. Fetch pharmacy_id before deletion
    const reviewResult = await query(
        'SELECT pharmacy_id FROM order_reviews WHERE id = $1',
        [reviewId]
    );
    if (!reviewResult.rows.length) {
        const err = new Error('Review not found');
        err.statusCode = 404;
        throw err;
    }

    const { pharmacy_id } = reviewResult.rows[0];

    // 2. Delete the review
    await query('DELETE FROM order_reviews WHERE id = $1', [reviewId]);

    // 3. Recalculate aggregate — decoupled, failure-tolerant
    try {
        await recalculateAggregate(pharmacy_id);
    } catch (err) {
        console.error('[review] Aggregate recalculation after deletion failed:', err.message);
    }
}

module.exports = {
    submitReview,
    getReview,
    deleteReview,
    recalculateAggregate,
};
