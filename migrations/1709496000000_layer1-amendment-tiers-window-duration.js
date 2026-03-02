/**
 * Layer 1 Amendment — Add window_duration_sec to tiers
 *
 * Required by: Routing Worker Spec v4 (§5 Escalation Logic → Tier Configuration Source)
 *
 * This column defines how long each tier's wave window lasts (in seconds).
 * The worker snapshots this value into routing_waves.window_duration_sec
 * at wave creation time.
 *
 * This is an intentional routing policy coupling — wave timing is a
 * tier-level governance decision, not a worker configuration detail.
 */

/** @type {import('node-pg-migrate').MigrationBuilder} */
exports.up = (pgm) => {
    pgm.addColumn('tiers', {
        window_duration_sec: {
            type: 'integer',
            notNull: true,
            default: 300,
            check: 'window_duration_sec > 0',
            comment: 'Wave window duration in seconds. Snapshotted into routing_waves at wave creation.',
        },
    });
};

/** @type {import('node-pg-migrate').MigrationBuilder} */
exports.down = (pgm) => {
    pgm.dropColumn('tiers', 'window_duration_sec');
};
