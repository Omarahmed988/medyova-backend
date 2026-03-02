'use strict';

/**
 * Migration: Layer 4 — Order Management
 *
 * Creates:
 *   1. order_status_enum       — 8-state lifecycle
 *   2. commission_status_enum  — financial tracking
 *   3. orders table            — core order entity
 *
 * Spec: specs/order-lifecycle/spec.md v2
 */

/** @type {import('node-pg-migrate').ColumnDefinitions | undefined} */
exports.shorthands = undefined;

/** @param pgm {import('node-pg-migrate').MigrationBuilder} */
exports.up = (pgm) => {
    // ═══════════════════════════════════════════════════════════════════════
    // 1. ENUMS
    // ═══════════════════════════════════════════════════════════════════════
    pgm.createType('order_status_enum', [
        'pending',                 // Awaiting pharmacy confirmation
        'confirmed_by_pharmacy',   // Pharmacy acknowledged
        'preparing',               // Pharmacy actively preparing
        'out_for_delivery',        // Handed to delivery
        'delivered',               // Delivered to user
        'completed',               // User confirmed receipt
        'cancelled_by_user',       // User cancelled
        'cancelled_by_pharmacy',   // Pharmacy cancelled
    ]);

    pgm.createType('commission_status_enum', [
        'pending',   // Recorded at acceptance, not finalized
        'earned',    // Order completed — commission collected
        'voided',    // Order cancelled — commission not collected
    ]);

    // ═══════════════════════════════════════════════════════════════════════
    // 2. ORDERS TABLE
    // ═══════════════════════════════════════════════════════════════════════
    pgm.createTable('orders', {
        id: {
            type: 'uuid',
            primaryKey: true,
            default: pgm.func('gen_random_uuid()'),
        },
        request_id: {
            type: 'uuid',
            notNull: true,
            unique: true,     // O-1: exactly one order per request
            references: '"requests"',
            onDelete: 'RESTRICT',
            comment: 'Invariant O-1: one order per accepted request',
        },
        offer_id: {
            type: 'uuid',
            notNull: true,
            unique: true,     // O-2/O-3: one order per accepted offer
            references: '"offers"',
            onDelete: 'RESTRICT',
            comment: 'Invariant O-2/O-3: order must reference accepted offer',
        },
        pharmacy_id: {
            type: 'uuid',
            notNull: true,
            references: '"pharmacies"',
            onDelete: 'RESTRICT',
            comment: 'Denormalized for query performance',
        },
        user_id: {
            type: 'uuid',
            references: '"users"',
            onDelete: 'SET NULL',
            comment: 'Nullable — matches requests.user_id (anonymous allowed)',
        },
        total_price: {
            type: 'numeric(10,2)',
            notNull: true,
            comment: 'Copied from accepted offer at acceptance time',
        },
        delivery_fee: {
            type: 'numeric(10,2)',
            notNull: true,
            default: 0,
            comment: 'Copied from accepted offer',
        },
        commission_rate: {
            type: 'numeric(5,2)',
            notNull: true,
            comment: 'Platform commission percentage at acceptance time',
        },
        commission_amount: {
            type: 'numeric(10,2)',
            notNull: true,
            comment: 'total_price * commission_rate / 100 (excludes delivery_fee)',
        },
        commission_status: {
            type: 'commission_status_enum',
            notNull: true,
            default: 'pending',
            comment: 'pending → earned (on completion) or voided (on cancellation)',
        },
        status: {
            type: 'order_status_enum',
            notNull: true,
            default: 'pending',
        },
        pharmacy_confirmed_at: {
            type: 'timestamptz',
            comment: 'Set when pharmacy confirms',
        },
        estimated_prep_minutes: {
            type: 'integer',
            comment: 'Set by pharmacy on confirmation',
        },
        delivered_at: {
            type: 'timestamptz',
            comment: 'Set on delivery confirmation',
        },
        completed_at: {
            type: 'timestamptz',
            comment: 'Set on user confirmation or auto-complete',
        },
        cancelled_at: {
            type: 'timestamptz',
            comment: 'Set on cancellation',
        },
        cancellation_reason: {
            type: 'text',
            comment: 'Reason for cancellation',
        },
        cancelled_by: {
            type: 'varchar(20)',
            comment: "'user', 'pharmacy', or 'system'",
        },
        created_at: {
            type: 'timestamptz',
            notNull: true,
            default: pgm.func('now()'),
        },
        updated_at: {
            type: 'timestamptz',
            notNull: true,
            default: pgm.func('now()'),
        },
    });

    // ═══════════════════════════════════════════════════════════════════════
    // 3. INDEXES
    // ═══════════════════════════════════════════════════════════════════════
    pgm.createIndex('orders', 'pharmacy_id');
    pgm.createIndex('orders', 'user_id');
    pgm.createIndex('orders', 'status');
    pgm.createIndex('orders', 'created_at');
    // UNIQUE indexes on request_id and offer_id are created by the column constraints
};

/** @param pgm {import('node-pg-migrate').MigrationBuilder} */
exports.down = (pgm) => {
    pgm.dropTable('orders');
    pgm.dropType('commission_status_enum');
    pgm.dropType('order_status_enum');
};
