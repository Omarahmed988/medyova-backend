/* eslint-disable camelcase */

/**
 * Migration — Phase 13: Order Rating System
 *
 * Creates the order_reviews table with constrained ratings and comment lengths.
 * Enforces one-review-per-order via UNIQUE(order_id).
 * Adds denormalized rating_avg and rating_count columns to pharmacies.
 */

exports.shorthands = undefined;

exports.up = (pgm) => {
    // 1. Core reviews table
    pgm.sql(`
        CREATE TABLE order_reviews (
            id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            order_id    UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
            pharmacy_id UUID NOT NULL REFERENCES pharmacies(id) ON DELETE CASCADE,
            user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            rating      SMALLINT NOT NULL CHECK (rating >= 1 AND rating <= 5),
            comment     TEXT CHECK (char_length(comment) <= 500),
            created_at  TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
            CONSTRAINT order_reviews_order_id_key UNIQUE (order_id)
        );
    `);

    // 2. Indexes for audit and admin queries
    pgm.createIndex('order_reviews', 'pharmacy_id', { name: 'idx_order_reviews_pharmacy_id' });
    pgm.createIndex('order_reviews', 'user_id', { name: 'idx_order_reviews_user_id' });

    // 3. Pharmacy aggregate columns
    // NUMERIC(3,2) stores e.g. 4.85
    pgm.addColumn('pharmacies', {
        rating_avg: {
            type: 'numeric(3, 2)',
            notNull: true,
            default: 0.00,
        },
        rating_count: {
            type: 'integer',
            notNull: true,
            default: 0,
        },
    });
};

exports.down = (pgm) => {
    pgm.dropColumn('pharmacies', ['rating_avg', 'rating_count']);
    pgm.dropTable('order_reviews');
};
