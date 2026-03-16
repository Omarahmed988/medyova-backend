/* eslint-disable camelcase */

/**
 * Migration B — Phase 14: Direct Orders
 *
 * Modifies:
 *   1. orders       — additive changes to support Flow B (direct) without breaking Flow A
 *   2. areas        — adds founder_override for area activation rule
 * Creates:
 *   3. order_items  — multi-medicine support for Flow B direct orders
 *
 * Flow A Invariants preserved by `orders_prescription_integrity` check.
 */

exports.shorthands = undefined;

exports.up = (pgm) => {
    // ── 1. Orders Extension ────────────────────────────────────────────────
    // Existing rows gracefully default to 'prescription'
    pgm.addColumn('orders', {
        type: {
            type: 'varchar(20)',
            notNull: true,
            default: 'prescription',
            check: "type IN ('prescription', 'direct')"
        }
    });

    // Relax request_id and offer_id to support direct orders
    pgm.alterColumn('orders', 'request_id', { notNull: false });
    pgm.alterColumn('orders', 'offer_id', { notNull: false });

    // Enforce Flow A invariants for prescription orders
    pgm.addConstraint('orders', 'orders_prescription_integrity', {
        check: "type = 'direct' OR (request_id IS NOT NULL AND offer_id IS NOT NULL)"
    });

    // ── 2. Area Activation Override ────────────────────────────────────────
    pgm.addColumn('areas', {
        founder_override: {
            type: 'boolean',
            notNull: true,
            default: false,
            comment: 'Super-admin manual activation override (ignores pharmacy count rule)'
        }
    });

    // ── 3. Order Items ─────────────────────────────────────────────────────
    pgm.createTable('order_items', {
        id: {
            type: 'uuid',
            primaryKey: true,
            default: pgm.func('gen_random_uuid()')
        },
        order_id: {
            type: 'uuid',
            notNull: true,
            references: 'orders(id)',
            onDelete: 'CASCADE'
        },
        medicine_id: {
            type: 'uuid',
            notNull: true,
            references: 'medicines(id)',
            onDelete: 'RESTRICT'
        },
        quantity: {
            type: 'smallint',
            notNull: true,
            default: 1,
            check: 'quantity > 0'
        },
        price_snapshot: {
            type: 'numeric(10,2)',
            notNull: true,
            check: 'price_snapshot > 0'
        },
        created_at: {
            type: 'timestamptz',
            notNull: true,
            default: pgm.func('now()')
        }
    });

    pgm.createIndex('order_items', 'order_id', { name: 'idx_order_items_order_id' });
    pgm.createIndex('order_items', 'medicine_id', { name: 'idx_order_items_medicine_id' });
};

exports.down = (pgm) => {
    pgm.dropTable('order_items');
    pgm.dropColumn('areas', 'founder_override');
    pgm.dropConstraint('orders', 'orders_prescription_integrity');

    // Restore original NOT NULL constraints
    // (Note: this will fail if any direct orders exist in the DB)
    pgm.alterColumn('orders', 'offer_id', { notNull: true });
    pgm.alterColumn('orders', 'request_id', { notNull: true });

    pgm.dropColumn('orders', 'type');
};
