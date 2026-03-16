'use strict';

/**
 * Order SLA Sweep — Phase 7
 *
 * Polls for pending orders that have exceeded the pharmacy
 * confirmation timeout and auto-cancels them.
 *
 * Spec: Order Lifecycle Spec v2 §7
 *
 * Configuration:
 *   PHARMACY_CONFIRM_TIMEOUT_SEC  — timeout in seconds (default: 900 = 15 min)
 *   ORDER_SLA_POLL_INTERVAL_SEC   — poll interval in seconds (default: 60)
 *
 * Uses FOR UPDATE SKIP LOCKED to ensure concurrency safety.
 * Does NOT hold long-running transactions — each order is processed individually.
 */

const { pool } = require('../config/db');
const settingsCache = require('../config/settingsCache');

const ORDER_SLA_POLL_INTERVAL_SEC = parseInt(
    process.env.ORDER_SLA_POLL_INTERVAL_SEC || '60', 10
);

/**
 * Run a single sweep: find and auto-cancel timed-out pending orders.
 *
 * @returns {Promise<{processed: number, cancelled: string[]}>}
 */
async function runSweep() {
    // ── Phase 11: Option A Snapshot ──
    const confirmTimeoutSec = settingsCache.getSettingNumber('pharmacy_confirm_timeout_sec', 900);

    const client = await pool.connect();
    const cancelled = [];

    try {
        // Find all pending orders that have exceeded the timeout
        // FOR UPDATE SKIP LOCKED ensures concurrent sweeps don't conflict
        const staleOrders = await client.query(
            `SELECT id FROM orders
             WHERE status = 'pending'
               AND created_at < now() - interval '${confirmTimeoutSec} seconds'
             FOR UPDATE SKIP LOCKED`,
        );

        for (const row of staleOrders.rows) {
            try {
                await client.query('BEGIN');

                // Re-lock and re-verify (defensive)
                const recheck = await client.query(
                    'SELECT id, status FROM orders WHERE id = $1 FOR UPDATE',
                    [row.id]
                );

                if (recheck.rows.length === 0 || recheck.rows[0].status !== 'pending') {
                    await client.query('ROLLBACK');
                    continue;
                }

                // Auto-cancel: transition to cancelled_by_pharmacy with system reason
                await client.query(
                    `UPDATE orders SET
                        status = 'cancelled_by_pharmacy',
                        commission_status = 'voided',
                        cancelled_at = now(),
                        cancellation_reason = 'confirmation_timeout',
                        cancelled_by = 'system',
                        updated_at = now()
                     WHERE id = $1 AND status = 'pending'`,
                    [row.id]
                );

                await client.query('COMMIT');
                cancelled.push(row.id);

                console.log(JSON.stringify({
                    level: 'info',
                    component: 'order-sla-sweep',
                    event: 'order_auto_cancelled',
                    order_id: row.id,
                    reason: 'confirmation_timeout',
                    timeout_sec: confirmTimeoutSec,
                    timestamp: new Date().toISOString(),
                }));
            } catch (err) {
                await client.query('ROLLBACK').catch(() => { });
                console.error(JSON.stringify({
                    level: 'error',
                    component: 'order-sla-sweep',
                    event: 'sweep_order_error',
                    order_id: row.id,
                    error: err.message,
                    timestamp: new Date().toISOString(),
                }));
            }
        }

        return { processed: staleOrders.rows.length, cancelled };
    } finally {
        client.release();
    }
}

/**
 * Start the SLA sweep loop.
 * Runs at configurable interval until stopped.
 *
 * @returns {{ stop: () => void }}
 */
function startSweepLoop() {
    let running = true;
    let timeoutId = null;

    async function tick() {
        if (!running) return;

        try {
            const result = await runSweep();
            if (result.cancelled.length > 0) {
                console.log(JSON.stringify({
                    level: 'info',
                    component: 'order-sla-sweep',
                    event: 'sweep_complete',
                    processed: result.processed,
                    cancelled_count: result.cancelled.length,
                    timestamp: new Date().toISOString(),
                }));
            }
        } catch (err) {
            console.error(JSON.stringify({
                level: 'error',
                component: 'order-sla-sweep',
                event: 'sweep_error',
                error: err.message,
                timestamp: new Date().toISOString(),
            }));
        }

        if (running) {
            timeoutId = setTimeout(tick, ORDER_SLA_POLL_INTERVAL_SEC * 1000);
        }
    }

    // Start first tick
    timeoutId = setTimeout(tick, ORDER_SLA_POLL_INTERVAL_SEC * 1000);

    return {
        stop: () => {
            running = false;
            if (timeoutId) clearTimeout(timeoutId);
        },
    };
}

module.exports = {
    runSweep,
    startSweepLoop,
    ORDER_SLA_POLL_INTERVAL_SEC,
};
