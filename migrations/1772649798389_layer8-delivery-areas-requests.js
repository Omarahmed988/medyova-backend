/* eslint-disable camelcase */

exports.shorthands = undefined;

exports.up = (pgm) => {
    // ── 1. Add area_id as Nullable (safe for zero-downtime deployment) ──
    pgm.addColumn('requests', {
        area_id: {
            type: 'uuid',
            references: '"areas"',
            onDelete: 'SET NULL'
        }
    });

    pgm.createIndex('requests', ['area_id'], { name: 'idx_requests_area_id' });

    // ── 2. Backfill: Legacy Areas ──
    // Create one Legacy Area per active Zone
    // We use raw SQL because node-pg-migrate abstractions don't natively support INSERT SELECT
    pgm.sql(`
        INSERT INTO areas (zone_id, name, is_legacy, is_active)
        SELECT id, 'Legacy Area', true, true
        FROM zones
        WHERE is_active = true;
    `);

    // Backfill existing requests to point to their zone's Legacy Area
    pgm.sql(`
        UPDATE requests r
        SET area_id = a.id
        FROM areas a
        WHERE a.zone_id = r.zone_id
          AND a.is_legacy = true
          AND r.area_id IS NULL;
    `);
};

exports.down = (pgm) => {
    // Reverse operations
    pgm.dropIndex('requests', [], { name: 'idx_requests_area_id' });
    pgm.dropColumn('requests', 'area_id');

    // Remove legacy areas created during this migration
    pgm.sql(`
        DELETE FROM areas WHERE is_legacy = true;
    `);
};
