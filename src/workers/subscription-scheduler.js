'use strict';
require('dotenv').config({ path: process.env.NODE_ENV === 'production' ? '.env.prod' : '.env.dev' });
const { query, pool } = require('../config/db');
const settingsCache = require('../config/settingsCache');
const SubscriptionOrderService = require('../services/subscriptionOrderService');

const BATCH_SIZE = 25;
const BATCH_DELAY_MS = 500;
const INTERVAL_MS = parseInt(process.env.SUBSCRIPTION_SCHEDULER_INTERVAL_MS, 10) || 60 * 60 * 1000; // 1 hour default

/**
 * Fetch a batch of due subscriptions using FOR UPDATE SKIP LOCKED.
 */
async function fetchBatch() {
    const res = await query(`
        SELECT * FROM subscriptions
        WHERE type = 'medicine'
          AND is_active = true
          AND next_run_at <= NOW()
        ORDER BY next_run_at ASC
        LIMIT $1
        FOR UPDATE SKIP LOCKED
    `, [BATCH_SIZE]);
    return res.rows;
}

/**
 * Process all due subscriptions in batches.
 */
async function runScheduler() {
    // Feature flag gate
    const enabled = settingsCache.getFlag('medicine_subscriptions_enabled', 'global');
    if (!enabled) {
        console.log('[SUBSCRIPTION SCHEDULER] Feature flag disabled. Skipping.');
        return { processed: 0, skipped: 0, paused: 0 };
    }

    console.log('[SUBSCRIPTION SCHEDULER] Starting subscription processing...');

    let totalProcessed = 0;
    let totalSkipped = 0;
    let totalPaused = 0;

    let batch;
    do {
        batch = await fetchBatch();

        for (const sub of batch) {
            try {
                const result = await SubscriptionOrderService.processSubscription(sub);

                if (result.status === 'generated') {
                    totalProcessed++;
                    console.log(`[SUBSCRIPTION SCHEDULER] Order ${result.order_id} generated for subscription ${sub.id}`);
                } else if (result.status === 'paused') {
                    totalPaused++;
                    console.log(`[SUBSCRIPTION SCHEDULER] Subscription ${sub.id} paused: ${result.reason}`);
                    
                    // Phase 20 Strategy: Emit demand signal if paused due to inventory / failure
                    try {
                        const DemandSignalService = require('../services/demandSignalService');
                        const itemsRes = await query(`SELECT medicine_id FROM subscription_items WHERE subscription_id = $1`, [sub.id]);
                        for (const item of itemsRes.rows) {
                            DemandSignalService.emit(
                                'subscription_failure', 
                                'subscription_scheduler', 
                                item.medicine_id, 
                                sub.area_id, 
                                sub.user_id, 
                                { subscription_id: sub.id }
                            );
                        }
                    } catch (emitErr) {
                        console.error(`[SUBSCRIPTION SCHEDULER] Signal drop error for ${sub.id}:`, emitErr.message);
                    }
                } else if (result.status === 'skipped') {
                    totalSkipped++;
                }
            } catch (err) {
                console.error(`[SUBSCRIPTION SCHEDULER] Error processing subscription ${sub.id}:`, err.message);
            }
        }

        if (batch.length === BATCH_SIZE) {
            await new Promise(resolve => setTimeout(resolve, BATCH_DELAY_MS));
        }
    } while (batch.length === BATCH_SIZE);

    console.log(`[SUBSCRIPTION SCHEDULER] Complete. Generated: ${totalProcessed}, Paused: ${totalPaused}, Skipped: ${totalSkipped}`);
    return { processed: totalProcessed, skipped: totalSkipped, paused: totalPaused };
}

// If run directly (PM2 / cron), execute on interval
if (require.main === module) {
    (async () => {
        await settingsCache.init();
        await runScheduler();

        setInterval(async () => {
            try {
                await runScheduler();
            } catch (err) {
                console.error('[SUBSCRIPTION SCHEDULER] Fatal error:', err);
            }
        }, INTERVAL_MS);
    })();
}

module.exports = { runScheduler, fetchBatch };
