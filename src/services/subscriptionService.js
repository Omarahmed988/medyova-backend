'use strict';

/**
 * Subscription Service — Phase 8
 *
 * Handles subscription CRUD, request generation, and pre-check logic.
 *
 * Spec: specs/subscription-engine/spec.md v2
 *
 * Key behaviors:
 *   - Requests generated directly as 'broadcasted' (no draft step)
 *   - Insurance guard: skip if profile is inactive
 *   - Idempotency via last_run_at guard
 *   - last_request_id set for traceability
 */

const { pool } = require('../config/db');

/**
 * Notification stub — called when pre-check fails.
 * No external integration yet. Logs structured event.
 *
 * @param {string} subscriptionId
 * @param {string} userId
 * @param {string} reason
 */
function notifyPrecheckFailed(subscriptionId, userId, reason) {
    console.log(JSON.stringify({
        level: 'info',
        component: 'subscription-service',
        event: 'precheck_notification',
        subscription_id: subscriptionId,
        user_id: userId,
        reason,
        timestamp: new Date().toISOString(),
    }));
}

/**
 * Run availability pre-check for a subscription.
 *
 * @param {object} client - PG client (for transactional use)
 * @param {object} subscription - Subscription row
 * @returns {Promise<string>} 'passed' or 'failed'
 */
async function runPrecheck(client, subscription) {
    // Check if at least 1 active pharmacy exists in the zone
    const pharmacyCheck = await client.query(
        `SELECT EXISTS(
            SELECT 1 FROM pharmacies
            WHERE zone_id = $1 AND is_active = true
        ) AS has_pharmacies`,
        [subscription.zone_id]
    );

    if (!pharmacyCheck.rows[0].has_pharmacies) {
        return 'failed';
    }

    // Future: If insurance_profile_id is set, check pharmacy contracts
    // (Phase 9 — tables don't exist yet)

    return 'passed';
}

/**
 * Compute the next run date for a subscription.
 *
 * @param {Date} fromDate - Date to compute from (typically now)
 * @param {number} preferredDay - Day of month (1-28)
 * @returns {Date}
 */
function computeNextRunAt(fromDate, preferredDay) {
    const d = new Date(fromDate);
    // Move to next month
    d.setUTCMonth(d.getUTCMonth() + 1);
    d.setUTCDate(preferredDay);
    d.setUTCHours(8, 0, 0, 0); // 08:00 UTC
    return d;
}

/**
 * Generate a request from a subscription.
 * Creates request + items in a single transaction.
 *
 * Enforces:
 *   - Idempotency via last_run_at guard
 *   - Insurance profile active guard
 *   - Direct 'broadcasted' state (no draft step)
 *   - last_request_id traceability
 *
 * @param {string} subscriptionId
 * @returns {Promise<{success: boolean, request_id?: string, skipped?: string, error?: string}>}
 */
async function generateRequest(subscriptionId) {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        // Lock subscription row
        const subResult = await client.query(
            `SELECT * FROM subscriptions
             WHERE id = $1 AND is_active = true
             FOR UPDATE`,
            [subscriptionId]
        );

        if (subResult.rows.length === 0) {
            await client.query('ROLLBACK');
            return { success: false, error: 'Subscription not found or inactive.' };
        }

        const sub = subResult.rows[0];

        // ── Idempotency guard ─────────────────────────────────────────────
        // Prevent duplicate generation: skip if last_run_at is recent
        if (sub.last_run_at) {
            const lastRun = new Date(sub.last_run_at);
            const nextRun = new Date(sub.next_run_at);
            // If last_run_at >= next_run_at - 1 day, already generated this cycle
            const guard = new Date(nextRun.getTime() - 24 * 60 * 60 * 1000);
            if (lastRun >= guard) {
                await client.query('ROLLBACK');
                return { success: true, skipped: 'already_generated_this_cycle' };
            }
        }

        // ── Insurance guard ───────────────────────────────────────────────
        if (sub.insurance_profile_id) {
            const profileCheck = await client.query(
                `SELECT is_active FROM user_insurance_profiles
                 WHERE id = $1`,
                [sub.insurance_profile_id]
            );

            if (profileCheck.rows.length === 0 || !profileCheck.rows[0].is_active) {
                await client.query('ROLLBACK');
                console.warn(JSON.stringify({
                    level: 'warn',
                    component: 'subscription-service',
                    event: 'insurance_guard_skip',
                    subscription_id: subscriptionId,
                    insurance_profile_id: sub.insurance_profile_id,
                    reason: 'Insurance profile inactive or not found',
                    timestamp: new Date().toISOString(),
                }));
                return { success: false, skipped: 'insurance_profile_inactive' };
            }
        }

        // ── Create request (directly as 'broadcasted') ────────────────────
        const requestResult = await client.query(
            `INSERT INTO requests (
                user_id, zone_id, contact_phone,
                state, broadcasted_at, type,
                prescription_url, notes,
                created_at, updated_at
            ) VALUES (
                $1, $2, $3,
                'broadcasted', now(), 'standard',
                $4, $5,
                now(), now()
            ) RETURNING id`,
            [
                sub.user_id,
                sub.zone_id,
                sub.contact_phone,
                sub.prescription_url,
                sub.notes,
            ]
        );

        const requestId = requestResult.rows[0].id;

        // ── Copy subscription_items → request_items ───────────────────────
        await client.query(
            `INSERT INTO request_items (request_id, product_name, quantity, is_substitution_allowed, created_at, updated_at)
             SELECT $1, product_name, quantity, is_substitution_allowed, now(), now()
             FROM subscription_items
             WHERE subscription_id = $2`,
            [requestId, subscriptionId]
        );

        // ── Update subscription ───────────────────────────────────────────
        const nextRunAt = computeNextRunAt(new Date(), sub.preferred_day_of_month);
        await client.query(
            `UPDATE subscriptions SET
                last_run_at = now(),
                last_request_id = $2,
                next_run_at = $3,
                precheck_status = 'none',
                updated_at = now()
             WHERE id = $1`,
            [subscriptionId, requestId, nextRunAt]
        );

        await client.query('COMMIT');

        return { success: true, request_id: requestId };
    } catch (err) {
        await client.query('ROLLBACK').catch(() => { });
        throw err;
    } finally {
        client.release();
    }
}

module.exports = {
    generateRequest,
    runPrecheck,
    computeNextRunAt,
    notifyPrecheckFailed,
};
