'use strict';

/**
 * Migration: Layer 20a — medicine_demand_signals
 *
 * Append-only table capturing unfulfilled medicine demand events.
 * Four signal types: search_miss, order_failure, routing_failure, subscription_failure.
 * This table is never updated or deleted during normal operation (90-day sweep only).
 */
exports.up = async (db) => {
    await db.query(`
        CREATE TABLE IF NOT EXISTS medicine_demand_signals (
            id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            signal_type VARCHAR(40) NOT NULL
                            CHECK (signal_type IN (
                                'search_miss',
                                'order_failure',
                                'routing_failure',
                                'subscription_failure'
                            )),
            source_flow VARCHAR(40) NOT NULL,
            medicine_id UUID NOT NULL REFERENCES medicines(id) ON DELETE CASCADE,
            area_id     UUID NOT NULL REFERENCES areas(id)     ON DELETE CASCADE,
            user_id     UUID REFERENCES users(id)              ON DELETE SET NULL,
            metadata    JSONB,
            created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
    `);

    // Aggregator range query: (medicine, area) in time window
    await db.query(`
        CREATE INDEX IF NOT EXISTS idx_demand_signals_med_area_time
            ON medicine_demand_signals (medicine_id, area_id, created_at DESC);
    `);

    // Retention sweep: delete rows older than 90 days
    await db.query(`
        CREATE INDEX IF NOT EXISTS idx_demand_signals_created
            ON medicine_demand_signals (created_at);
    `);
};

exports.down = async (db) => {
    await db.query(`DROP TABLE IF EXISTS medicine_demand_signals CASCADE;`);
};
