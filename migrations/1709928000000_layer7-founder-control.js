/**
 * Migration: 1709928000000_layer7-founder-control.js
 * Phase 11 — Founder Control Layer v3
 *
 * Creates:
 *   - system_settings table (named scalar config values)
 *   - feature_flags table (boolean runtime toggles)
 *   - Seeds all initial settings and flags
 *
 * LISTEN/NOTIFY: NOT configured here — handled in settingsCache.js (Step 2).
 * This migration is pure schema + seed only.
 */

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.up = (pgm) => {

    // ─────────────────────────────────────────────────────
    // 1. system_settings
    // ─────────────────────────────────────────────────────
    pgm.createTable('system_settings', {
        id: {
            type: 'uuid',
            primaryKey: true,
            default: pgm.func('gen_random_uuid()'),
        },
        key: {
            type: 'varchar(100)',
            notNull: true,
            unique: true,
        },
        value: {
            type: 'text',
            notNull: true,
        },
        type: {
            type: 'varchar(20)',
            notNull: true,
            check: "type IN ('decimal', 'integer', 'boolean', 'string')",
        },
        min_val: {
            type: 'text',
            notNull: false,
        },
        max_val: {
            type: 'text',
            notNull: false,
        },
        description: {
            type: 'text',
            notNull: true,
        },
        is_locked: {
            type: 'boolean',
            notNull: true,
            default: false,
        },
        updated_by: {
            type: 'uuid',
            notNull: false,
        },
        updated_at: {
            type: 'timestamptz',
            notNull: true,
            default: pgm.func('now()'),
        },
        created_at: {
            type: 'timestamptz',
            notNull: true,
            default: pgm.func('now()'),
        },
    });

    // ─────────────────────────────────────────────────────
    // 2. feature_flags
    // ─────────────────────────────────────────────────────
    pgm.createTable('feature_flags', {
        id: {
            type: 'uuid',
            primaryKey: true,
            default: pgm.func('gen_random_uuid()'),
        },
        key: {
            type: 'varchar(100)',
            notNull: true,
        },
        scope: {
            type: 'varchar(20)',
            notNull: true,
            check: "scope IN ('global', 'zone')",
        },
        scope_id: {
            type: 'uuid',
            notNull: false,
        },
        is_enabled: {
            type: 'boolean',
            notNull: true,
            default: true,
        },
        description: {
            type: 'text',
            notNull: true,
        },
        updated_by: {
            type: 'uuid',
            notNull: false,
        },
        updated_at: {
            type: 'timestamptz',
            notNull: true,
            default: pgm.func('now()'),
        },
        created_at: {
            type: 'timestamptz',
            notNull: true,
            default: pgm.func('now()'),
        },
    });

    // UNIQUE: (key, scope, scope_id)
    // Handles NULL scope_id correctly — global flags have scope_id IS NULL
    pgm.addConstraint('feature_flags', 'uq_feature_flags_key_scope',
        'UNIQUE (key, scope, COALESCE(scope_id, \'00000000-0000-0000-0000-000000000000\'::uuid))'
    );

    // ─────────────────────────────────────────────────────
    // 3. Indexes
    // ─────────────────────────────────────────────────────
    pgm.createIndex('system_settings', 'key');
    pgm.createIndex('feature_flags', ['key', 'scope']);
    pgm.createIndex('feature_flags', ['key', 'scope', 'scope_id']);

    // ─────────────────────────────────────────────────────
    // 4. Seed: system_settings
    //
    //  commission_rate_percent: NO min_val (0% allowed for rare medicine use case)
    //  All others have defined bounds.
    // ─────────────────────────────────────────────────────
    pgm.sql(`
        INSERT INTO system_settings (key, value, type, min_val, max_val, description) VALUES
        (
            'commission_rate_percent',
            '10.00',
            'decimal',
            NULL,
            '30.00',
            'Platform commission percentage applied to order total_price at acceptance. 0% is explicitly permitted for rare medicine use cases. Max cap: 30%.'
        ),
        (
            'pharmacy_confirm_timeout_sec',
            '900',
            'integer',
            '60',
            '7200',
            'Seconds after order creation before SLA sweep auto-cancels a pending order awaiting pharmacy confirmation.'
        ),
        (
            'subscription_precheck_offset_days',
            '2',
            'integer',
            '1',
            '14',
            'Days before next_run_at to run availability pre-check for subscription. Notification stub is triggered on failure.'
        ),
        (
            'routing_stale_job_threshold_sec',
            '600',
            'integer',
            '120',
            '3600',
            'Seconds after last heartbeat before a routing job is considered stale and eligible for reclaim.'
        ),
        (
            'max_active_requests_per_user',
            '5',
            'integer',
            '1',
            '20',
            'Maximum number of non-terminal requests a single user may have concurrently. Enforced at request creation.'
        ),
        (
            'max_active_subscriptions_per_user',
            '10',
            'integer',
            '1',
            '50',
            'Maximum number of active subscriptions a single user may have. Enforced at subscription creation.'
        );
    `);

    // ─────────────────────────────────────────────────────
    // 5. Seed: feature_flags
    //
    //  All global scope. scope_id IS NULL for all v1 seeds.
    //  pharmacy_registration_open defaults to false (closed at launch).
    // ─────────────────────────────────────────────────────
    pgm.sql(`
        INSERT INTO feature_flags (key, scope, scope_id, is_enabled, description) VALUES
        (
            'insurance_routing_enabled',
            'global',
            NULL,
            true,
            'When enabled, insured requests apply a JOIN-based eligibility filter through pharmacy_insurance_contracts. Disabling falls back to standard routing (pharmacy remains responsible for insurance eligibility). Requires confirm:true.'
        ),
        (
            'subscription_engine_enabled',
            'global',
            NULL,
            true,
            'When enabled, subscription-sweep generates requests on next_run_at. When disabled, sweep advances next_run_at without creating requests (Hard Stop — cycles are permanently skipped). Requires confirm:true.'
        ),
        (
            'rare_medicine_routing_enabled',
            'global',
            NULL,
            true,
            'When enabled, requests of type=rare use the cross-zone routing path with supports_rare=true filter. When disabled, rare requests receive no offers (fail-closed). Requires confirm:true.'
        ),
        (
            'offer_visibility_enabled',
            'global',
            NULL,
            true,
            'Safety kill-switch for offer display to users. Disabling hides all offers from offer selection responses. Does not affect routing or acceptance logic.'
        ),
        (
            'pharmacy_registration_open',
            'global',
            NULL,
            false,
            'When enabled, allows pharmacies to self-register. Closed at Zone-1 launch — pharmacies are onboarded manually via admin API.'
        );
    `);
};

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.down = (pgm) => {
    pgm.dropTable('feature_flags');
    pgm.dropTable('system_settings');
};
