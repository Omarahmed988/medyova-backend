'use strict';

/**
 * Migration: Layer 20b — medicine_demand_heatmap
 *
 * Aggregated demand intelligence table.
 * Stores rolling 30-day counts per (medicine_id, area_id) pair.
 * Written only by demand-signal-aggregator.js — never by request paths.
 */
exports.up = async (db) => {
    await db.query(`
        CREATE TABLE IF NOT EXISTS medicine_demand_heatmap (
            id                         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            medicine_id                UUID NOT NULL REFERENCES medicines(id) ON DELETE CASCADE,
            area_id                    UUID NOT NULL REFERENCES areas(id)     ON DELETE CASCADE,
            search_miss_count          INTEGER NOT NULL DEFAULT 0,
            order_failure_count        INTEGER NOT NULL DEFAULT 0,
            routing_failure_count      INTEGER NOT NULL DEFAULT 0,
            subscription_failure_count INTEGER NOT NULL DEFAULT 0,
            demand_score               NUMERIC(10,2) NOT NULL DEFAULT 0,
            last_aggregated_at         TIMESTAMPTZ,
            created_at                 TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at                 TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            UNIQUE (medicine_id, area_id)
        );
    `);

    // Pharmacy dashboard: top demanded medicines within a delivery area
    await db.query(`
        CREATE INDEX IF NOT EXISTS idx_heatmap_area_score
            ON medicine_demand_heatmap (area_id, demand_score DESC);
    `);

    // Founder dashboard: supply gaps across areas for a medicine
    await db.query(`
        CREATE INDEX IF NOT EXISTS idx_heatmap_medicine_score
            ON medicine_demand_heatmap (medicine_id, demand_score DESC);
    `);
};

exports.down = async (db) => {
    await db.query(`DROP TABLE IF EXISTS medicine_demand_heatmap CASCADE;`);
};
