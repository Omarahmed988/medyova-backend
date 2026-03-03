'use strict';

/**
 * Subscription Sweep Worker — Phase 8
 *
 * Two sweep functions:
 *   1. Pre-check sweep: checks pharmacy availability before scheduled run
 *   2. Request generation sweep: creates requests from due subscriptions
 *
 * Both use FOR UPDATE SKIP LOCKED for concurrency safety.
 *
 * Spec: specs/subscription-engine/spec.md v2
 */

const { pool } = require('../config/db');
const {
    generateRequest,
    runPrecheck,
    notifyPrecheckFailed,
} = require('../services/subscriptionService');

const SUBSCRIPTION_POLL_INTERVAL_SEC = parseInt(
    process.env.SUBSCRIPTION_POLL_INTERVAL_SEC || '120', 10
);

/**
 * Pre-check sweep: find subscriptions due for pre-check and run them.
 *
 * @returns {Promise<{processed: number, passed: number, failed: number}>}
 */
async function runPrecheckSweep() {
    const client = await pool.connect();
    let processed = 0, passed = 0, failed = 0;

    try {
        // Find subscriptions where pre-check is due
        const result = await client.query(
            `SELECT id, user_id, zone_id, insurance_profile_id, precheck_offset_days
             FROM subscriptions
             WHERE is_active = true
               AND precheck_status = 'none'
               AND next_run_at - (precheck_offset_days || ' days')::interval <= now()
               AND next_run_at > now()
             FOR UPDATE SKIP LOCKED`
        );

        for (const sub of result.rows) {
            try {
                const status = await runPrecheck(client, sub);
                processed++;

                await client.query(
                    `UPDATE subscriptions SET
                        precheck_status = $2,
                        precheck_ran_at = now(),
                        updated_at = now()
                     WHERE id = $1`,
                    [sub.id, status]
                );

                if (status === 'passed') {
                    passed++;
                } else {
                    failed++;
                    notifyPrecheckFailed(sub.id, sub.user_id, 'No active pharmacies in zone');
                }
            } catch (err) {
                console.error(JSON.stringify({
                    level: 'error',
                    component: 'subscription-sweep',
                    event: 'precheck_error',
                    subscription_id: sub.id,
                    error: err.message,
                    timestamp: new Date().toISOString(),
                }));
            }
        }

        return { processed, passed, failed };
    } finally {
        client.release();
    }
}

/**
 * Request generation sweep: find due subscriptions and generate requests.
 *
 * @returns {Promise<{processed: number, generated: string[], skipped: number}>}
 */
async function runGenerationSweep() {
    const client = await pool.connect();
    const generated = [];
    let processed = 0, skipped = 0;

    try {
        // Find subscriptions due for request generation
        const result = await client.query(
            `SELECT id FROM subscriptions
             WHERE is_active = true
               AND next_run_at <= now()
             FOR UPDATE SKIP LOCKED`
        );

        // Release client — each generateRequest uses its own connection
        client.release();

        for (const sub of result.rows) {
            processed++;
            try {
                const genResult = await generateRequest(sub.id);

                if (genResult.success && genResult.request_id) {
                    generated.push(genResult.request_id);
                    console.log(JSON.stringify({
                        level: 'info',
                        component: 'subscription-sweep',
                        event: 'request_generated',
                        subscription_id: sub.id,
                        request_id: genResult.request_id,
                        timestamp: new Date().toISOString(),
                    }));
                } else if (genResult.skipped) {
                    skipped++;
                }
            } catch (err) {
                console.error(JSON.stringify({
                    level: 'error',
                    component: 'subscription-sweep',
                    event: 'generation_error',
                    subscription_id: sub.id,
                    error: err.message,
                    timestamp: new Date().toISOString(),
                }));
            }
        }

        return { processed, generated, skipped };
    } catch (err) {
        client.release();
        throw err;
    }
}

/**
 * Start the subscription sweep loop.
 *
 * @returns {{ stop: () => void }}
 */
function startSweepLoop() {
    let running = true;
    let timeoutId = null;

    async function tick() {
        if (!running) return;

        try {
            await runPrecheckSweep();
            await runGenerationSweep();
        } catch (err) {
            console.error(JSON.stringify({
                level: 'error',
                component: 'subscription-sweep',
                event: 'sweep_error',
                error: err.message,
                timestamp: new Date().toISOString(),
            }));
        }

        if (running) {
            timeoutId = setTimeout(tick, SUBSCRIPTION_POLL_INTERVAL_SEC * 1000);
        }
    }

    timeoutId = setTimeout(tick, SUBSCRIPTION_POLL_INTERVAL_SEC * 1000);

    return {
        stop: () => {
            running = false;
            if (timeoutId) clearTimeout(timeoutId);
        },
    };
}

module.exports = {
    runPrecheckSweep,
    runGenerationSweep,
    startSweepLoop,
    SUBSCRIPTION_POLL_INTERVAL_SEC,
};
