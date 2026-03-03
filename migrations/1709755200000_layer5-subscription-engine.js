'use strict';

/**
 * Migration: Layer 5 — Subscription Engine
 *
 * Creates:
 *   1. subscriptions         — recurring medication request schedules
 *   2. subscription_items    — items within each subscription
 *
 * Spec: specs/subscription-engine/spec.md v2
 */

exports.shorthands = undefined;

/** @param pgm {import('node-pg-migrate').MigrationBuilder} */
exports.up = (pgm) => {
    // ═══════════════════════════════════════════════════════════════════════
    // 1. SUBSCRIPTIONS
    // ═══════════════════════════════════════════════════════════════════════
    pgm.createTable('subscriptions', {
        id: {
            type: 'uuid',
            primaryKey: true,
            default: pgm.func('gen_random_uuid()'),
        },
        user_id: {
            type: 'uuid',
            notNull: true,
            references: '"users"',
            onDelete: 'CASCADE',
            comment: 'Owner of the subscription',
        },
        insurance_profile_id: {
            type: 'uuid',
            comment: 'Phase 9 integration point — nullable FK to user_insurance_profiles',
            // FK will be added in Phase 9 migration when table exists
        },
        zone_id: {
            type: 'uuid',
            notNull: true,
            references: '"zones"',
            onDelete: 'RESTRICT',
            comment: 'Delivery zone for generated requests',
        },
        contact_phone: {
            type: 'varchar(20)',
            notNull: true,
        },
        preferred_day_of_month: {
            type: 'integer',
            notNull: true,
            check: 'preferred_day_of_month >= 1 AND preferred_day_of_month <= 28',
            comment: 'Day of month (1-28) to generate request',
        },
        next_run_at: {
            type: 'timestamptz',
            notNull: true,
        },
        last_run_at: {
            type: 'timestamptz',
            comment: 'Last successful request generation',
        },
        last_request_id: {
            type: 'uuid',
            references: '"requests"',
            onDelete: 'SET NULL',
            comment: 'Last generated request for traceability',
        },
        precheck_offset_days: {
            type: 'integer',
            notNull: true,
            default: 2,
            comment: 'Days before next_run_at to run availability pre-check',
        },
        precheck_status: {
            type: 'varchar(20)',
            notNull: true,
            default: 'none',
            comment: "'none', 'passed', 'failed'",
        },
        precheck_ran_at: {
            type: 'timestamptz',
        },
        is_active: {
            type: 'boolean',
            notNull: true,
            default: true,
        },
        notes: {
            type: 'text',
        },
        prescription_url: {
            type: 'text',
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

    pgm.createIndex('subscriptions', 'user_id');
    pgm.createIndex('subscriptions', ['next_run_at', 'is_active'], {
        name: 'idx_subscriptions_next_run_active',
    });
    pgm.createIndex('subscriptions', 'is_active');

    // ═══════════════════════════════════════════════════════════════════════
    // 2. SUBSCRIPTION_ITEMS
    // ═══════════════════════════════════════════════════════════════════════
    pgm.createTable('subscription_items', {
        id: {
            type: 'uuid',
            primaryKey: true,
            default: pgm.func('gen_random_uuid()'),
        },
        subscription_id: {
            type: 'uuid',
            notNull: true,
            references: '"subscriptions"',
            onDelete: 'CASCADE',
        },
        product_name: {
            type: 'varchar(255)',
            notNull: true,
        },
        quantity: {
            type: 'integer',
            notNull: true,
            default: 1,
            check: 'quantity > 0',
        },
        is_substitution_allowed: {
            type: 'boolean',
            notNull: true,
            default: true,
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

    pgm.createIndex('subscription_items', 'subscription_id');
};

/** @param pgm {import('node-pg-migrate').MigrationBuilder} */
exports.down = (pgm) => {
    pgm.dropTable('subscription_items');
    pgm.dropTable('subscriptions');
};
