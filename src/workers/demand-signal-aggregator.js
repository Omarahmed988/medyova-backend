'use strict';

/**
 * demand-signal-aggregator.js
 *
 * Background worker that converts raw demand signals into the
 * medicine_demand_heatmap aggregated table.
 *
 * Strategy:
 *   - Watermark cursor: only processes signals newer than last run
 *     (persisted in system_settings.demand_aggregator_watermark)
 *   - Rolling 30-day window: heatmap counts are recomputed from the
 *     last 30 days of signals, not accumulated cumulatively
 *   - Max 5,000 signals per batch to bound memory usage
 *   - Runs hourly via node-cron when executed as a standalone process
 *
 * Demand Score Formula:
 *   score = (search_miss × 1) + (order_failure × 3)
 *         + (routing_failure × 3) + (subscription_failure × 4)
 *
 * Architectural invariant: this worker NEVER imports from or writes to
 * any order flow service (DirectOrderService, routing-worker, etc.).
 */

require('../config/env');
const { pool, query } = require('../config/db');

const BATCH_SIZE = 5000;
const SCORE_WEIGHTS = {
    search_miss:          1,
    order_failure:        3,
    routing_failure:      3,
    subscription_failure: 4,
};

// ─── Watermark Helpers ────────────────────────────────────────────────────────

async function getWatermark() {
    const res = await query(
        `SELECT value FROM system_settings WHERE key = 'demand_aggregator_watermark' LIMIT 1`
    );
    return res.rows[0] ? res.rows[0].value : '1970-01-01T00:00:00.000Z';
}

async function setWatermark(ts) {
    await query(`
        INSERT INTO system_settings (key, value, type, description)
        VALUES ('demand_aggregator_watermark', $1, 'string', 'Last processed timestamp for demand signal aggregation')
        ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()
    `, [ts]);
}

// ─── Core Aggregation ─────────────────────────────────────────────────────────

/**
 * Process one batch of signals, upsert affected heatmap rows.
 * Returns the number of signals processed and the new watermark value.
 */
async function processBatch() {
    const watermark = await getWatermark();

    // 1. Identify signal batch since watermark
    const batchRes = await query(`
        SELECT id, medicine_id, area_id, signal_type, created_at
        FROM medicine_demand_signals
        WHERE created_at > $1
        ORDER BY created_at ASC
        LIMIT $2
    `, [watermark, BATCH_SIZE]);

    const signals = batchRes.rows;
    if (signals.length === 0) return { processed: 0, watermark };

    // 2. Derive unique (medicine_id, area_id) pairs from this batch
    const affectedPairs = new Map();
    for (const s of signals) {
        const key = `${s.medicine_id}|${s.area_id}`;
        if (!affectedPairs.has(key)) {
            affectedPairs.set(key, { medicine_id: s.medicine_id, area_id: s.area_id });
        }
    }

    // 3. For each affected pair, recompute rolling 30-day counts and upsert
    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        for (const { medicine_id, area_id } of affectedPairs.values()) {
            const countsRes = await client.query(`
                SELECT signal_type, COUNT(*)::int AS cnt
                FROM medicine_demand_signals
                WHERE medicine_id = $1
                  AND area_id     = $2
                  AND created_at  >= NOW() - INTERVAL '30 days'
                GROUP BY signal_type
            `, [medicine_id, area_id]);

            // Build count map
            const counts = {
                search_miss:          0,
                order_failure:        0,
                routing_failure:      0,
                subscription_failure: 0,
            };
            for (const row of countsRes.rows) {
                if (counts.hasOwnProperty(row.signal_type)) {
                    counts[row.signal_type] = row.cnt;
                }
            }

            // Compute demand score
            const demandScore =
                (counts.search_miss          * SCORE_WEIGHTS.search_miss)          +
                (counts.order_failure        * SCORE_WEIGHTS.order_failure)        +
                (counts.routing_failure      * SCORE_WEIGHTS.routing_failure)      +
                (counts.subscription_failure * SCORE_WEIGHTS.subscription_failure);

            await client.query(`
                INSERT INTO medicine_demand_heatmap (
                    medicine_id, area_id,
                    search_miss_count, order_failure_count,
                    routing_failure_count, subscription_failure_count,
                    demand_score, last_aggregated_at, updated_at
                ) VALUES ($1, $2, $3, $4, $5, $6, $7, NOW(), NOW())
                ON CONFLICT (medicine_id, area_id) DO UPDATE SET
                    search_miss_count          = EXCLUDED.search_miss_count,
                    order_failure_count        = EXCLUDED.order_failure_count,
                    routing_failure_count      = EXCLUDED.routing_failure_count,
                    subscription_failure_count = EXCLUDED.subscription_failure_count,
                    demand_score               = EXCLUDED.demand_score,
                    last_aggregated_at         = EXCLUDED.last_aggregated_at,
                    updated_at                 = EXCLUDED.updated_at
            `, [
                medicine_id, area_id,
                counts.search_miss, counts.order_failure,
                counts.routing_failure, counts.subscription_failure,
                demandScore,
            ]);
        }

        await client.query('COMMIT');
    } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw err;
    } finally {
        client.release();
    }

    // 4. Advance watermark to the last signal's created_at in this batch
    const newWatermark = signals[signals.length - 1].created_at.toISOString();
    await setWatermark(newWatermark);

    return { processed: signals.length, watermark: newWatermark };
}

/**
 * Main entry point — processes all pending batches in a loop.
 */
async function runAggregator() {
    console.log('[DemandAggregator] Starting...');
    let totalProcessed = 0;
    let batches = 0;

    let result;
    do {
        result = await processBatch();
        totalProcessed += result.processed;
        batches++;
    } while (result.processed === BATCH_SIZE); // keep going if batch was full

    console.log(`[DemandAggregator] Complete. Batches: ${batches}, Signals processed: ${totalProcessed}`);
    return { totalProcessed };
}

// ─── Scheduled Execution ─────────────────────────────────────────────────────

if (require.main === module) {
    const cron = require('node-cron');
    const settingsCache = require('../config/settingsCache');

    (async () => {
        await settingsCache.init();

        // Run once immediately on startup
        await runAggregator().catch(err =>
            console.error('[DemandAggregator] Error on startup run:', err)
        );

        // Then every hour
        cron.schedule('0 * * * *', async () => {
            try {
                await runAggregator();
            } catch (err) {
                console.error('[DemandAggregator] Hourly run error:', err);
            }
        });

        console.log('[DemandAggregator] Scheduled: hourly (cron 0 * * * *)');
    })();
}

module.exports = { runAggregator, processBatch };
