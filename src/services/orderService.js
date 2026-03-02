'use strict';

/**
 * Order Service — Phase 7
 *
 * Implements strict state transition guards for orders.
 *
 * State machine (Spec v2 §4):
 *   pending → confirmed_by_pharmacy → preparing → out_for_delivery → delivered → completed
 *   pending/confirmed/preparing → cancelled_by_user / cancelled_by_pharmacy
 *
 * Commission status transitions (Spec v2 §6.4):
 *   pending → earned  (on order completion)
 *   pending → voided  (on any cancellation)
 *
 * Does NOT handle auth or ownership — that is the route's job.
 */

const { pool } = require('../config/db');

/**
 * Allowed state transitions (from → [to]).
 * Spec v2 §4.2
 */
const ALLOWED_TRANSITIONS = {
    pending: ['confirmed_by_pharmacy', 'cancelled_by_user', 'cancelled_by_pharmacy'],
    confirmed_by_pharmacy: ['preparing', 'cancelled_by_user', 'cancelled_by_pharmacy'],
    preparing: ['out_for_delivery', 'cancelled_by_pharmacy'],
    out_for_delivery: ['delivered'],
    delivered: ['completed'],
};

/**
 * Terminal states — no transitions allowed out.
 */
const TERMINAL_STATES = ['completed', 'cancelled_by_user', 'cancelled_by_pharmacy'];

/**
 * States that allow user cancellation (Spec v2 §5.1).
 */
const USER_CANCELLABLE_STATES = ['pending', 'confirmed_by_pharmacy'];

/**
 * States that allow pharmacy cancellation (Spec v2 §5.2).
 */
const PHARMACY_CANCELLABLE_STATES = ['pending', 'confirmed_by_pharmacy', 'preparing'];

/**
 * Transition an order to a new status.
 *
 * @param {string} orderId
 * @param {string} newStatus
 * @param {object} [extras] - Additional fields to set
 * @param {string} [extras.cancellation_reason]
 * @param {string} [extras.cancelled_by] - 'user', 'pharmacy', or 'system'
 * @param {number} [extras.estimated_prep_minutes]
 * @returns {Promise<{success: boolean, order?: object, error?: string}>}
 */
async function transitionOrder(orderId, newStatus, extras = {}) {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        // Lock order row
        const lockResult = await client.query(
            'SELECT id, status, commission_status FROM orders WHERE id = $1 FOR UPDATE',
            [orderId]
        );

        if (lockResult.rows.length === 0) {
            await client.query('ROLLBACK');
            return { success: false, error: 'Order not found.' };
        }

        const order = lockResult.rows[0];
        const currentStatus = order.status;

        // Check terminal state
        if (TERMINAL_STATES.includes(currentStatus)) {
            await client.query('ROLLBACK');
            return { success: false, error: `Order is in terminal state '${currentStatus}'. No transitions allowed.` };
        }

        // Check allowed transition
        const allowed = ALLOWED_TRANSITIONS[currentStatus] || [];
        if (!allowed.includes(newStatus)) {
            await client.query('ROLLBACK');
            return { success: false, error: `Transition '${currentStatus}' → '${newStatus}' is not allowed.` };
        }

        // Build UPDATE query dynamically
        const setClauses = ['status = $2', 'updated_at = now()'];
        const params = [orderId, newStatus];
        let paramIdx = 3;

        // Timestamp fields based on target status
        if (newStatus === 'confirmed_by_pharmacy') {
            setClauses.push(`pharmacy_confirmed_at = now()`);
            if (extras.estimated_prep_minutes != null) {
                setClauses.push(`estimated_prep_minutes = $${paramIdx}`);
                params.push(extras.estimated_prep_minutes);
                paramIdx++;
            }
        }

        if (newStatus === 'delivered') {
            setClauses.push(`delivered_at = now()`);
        }

        if (newStatus === 'completed') {
            setClauses.push(`completed_at = now()`);
            setClauses.push(`commission_status = 'earned'`);
        }

        if (newStatus === 'cancelled_by_user' || newStatus === 'cancelled_by_pharmacy') {
            setClauses.push(`cancelled_at = now()`);
            setClauses.push(`commission_status = 'voided'`);

            if (extras.cancellation_reason) {
                setClauses.push(`cancellation_reason = $${paramIdx}`);
                params.push(extras.cancellation_reason);
                paramIdx++;
            }
            if (extras.cancelled_by) {
                setClauses.push(`cancelled_by = $${paramIdx}`);
                params.push(extras.cancelled_by);
                paramIdx++;
            }
        }

        const updateSql = `UPDATE orders SET ${setClauses.join(', ')} WHERE id = $1 AND status = $${paramIdx}`;
        params.push(currentStatus); // Guard: only transition from current status

        await client.query(updateSql, params);
        await client.query('COMMIT');

        return { success: true, order: { id: orderId, status: newStatus } };
    } catch (err) {
        await client.query('ROLLBACK').catch(() => { });
        throw err;
    } finally {
        client.release();
    }
}

/**
 * Cancel an order by user.
 *
 * @param {string} orderId
 * @param {string} [reason]
 * @returns {Promise<{success: boolean, order?: object, error?: string}>}
 */
async function cancelByUser(orderId, reason) {
    // Pre-check cancellable state (advisory, actual guard is in transitionOrder)
    return transitionOrder(orderId, 'cancelled_by_user', {
        cancellation_reason: reason || 'User requested cancellation',
        cancelled_by: 'user',
    });
}

/**
 * Cancel an order by pharmacy.
 *
 * @param {string} orderId
 * @param {string} [reason]
 * @returns {Promise<{success: boolean, order?: object, error?: string}>}
 */
async function cancelByPharmacy(orderId, reason) {
    return transitionOrder(orderId, 'cancelled_by_pharmacy', {
        cancellation_reason: reason || 'Pharmacy cancelled order',
        cancelled_by: 'pharmacy',
    });
}

/**
 * Cancel an order by system (e.g., SLA timeout).
 *
 * @param {string} orderId
 * @param {string} reason
 * @returns {Promise<{success: boolean, order?: object, error?: string}>}
 */
async function cancelBySystem(orderId, reason) {
    return transitionOrder(orderId, 'cancelled_by_pharmacy', {
        cancellation_reason: reason,
        cancelled_by: 'system',
    });
}

/**
 * Get order by ID.
 *
 * @param {string} orderId
 * @returns {Promise<object|null>}
 */
async function getOrderById(orderId) {
    const { query } = require('../config/db');
    const result = await query('SELECT * FROM orders WHERE id = $1', [orderId]);
    return result.rows[0] || null;
}

module.exports = {
    transitionOrder,
    cancelByUser,
    cancelByPharmacy,
    cancelBySystem,
    getOrderById,
    ALLOWED_TRANSITIONS,
    TERMINAL_STATES,
    USER_CANCELLABLE_STATES,
    PHARMACY_CANCELLABLE_STATES,
};
