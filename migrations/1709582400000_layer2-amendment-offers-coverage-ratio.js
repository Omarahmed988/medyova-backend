/**
 * Layer 2 Amendment — Add coverage_ratio to offers
 *
 * Required by: Routing Engine Spec v4 (§2.5 Layer 2 Amendment)
 *
 * coverage_ratio represents the percentage of request items covered
 * by a pharmacy's offer. Full coverage is strictly 100.00.
 *
 * NUMERIC(5,2): allows values from 0.00 to 999.99, constrained by
 * CHECK to 0.00–100.00. Exact decimal math avoids floating-point issues.
 */

/** @type {import('node-pg-migrate').MigrationBuilder} */
exports.up = (pgm) => {
    pgm.addColumn('offers', {
        coverage_ratio: {
            type: 'numeric(5,2)',
            notNull: true,
            default: 100.00,
            check: 'coverage_ratio >= 0 AND coverage_ratio <= 100',
            comment: 'Percentage of request items covered. Full coverage = 100.00',
        },
    });
};

/** @type {import('node-pg-migrate').MigrationBuilder} */
exports.down = (pgm) => {
    pgm.dropColumn('offers', 'coverage_ratio');
};
