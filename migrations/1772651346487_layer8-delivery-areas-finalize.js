/* eslint-disable camelcase */

/**
 * Migration C (Final) — Phase 12: Delivery Areas
 *
 * Applies NOT NULL constraint to requests.area_id.
 *
 * PREREQUISITES — DO NOT RUN UNTIL ALL OF THESE ARE CONFIRMED:
 *   1. Migration A (areas + pharmacy_delivery_areas) applied.
 *   2. Migration B (nullable area_id + backfill) applied.
 *   3. Application deployed with area_id required in POST /requests.
 *   4. Verify zero NULLs:
 *        SELECT COUNT(*) FROM requests WHERE area_id IS NULL;
 *      Must return 0 before running this migration.
 */

exports.shorthands = undefined;

exports.up = (pgm) => {
    pgm.alterColumn('requests', 'area_id', {
        notNull: true,
    });
};

exports.down = (pgm) => {
    pgm.alterColumn('requests', 'area_id', {
        notNull: false,
    });
};
