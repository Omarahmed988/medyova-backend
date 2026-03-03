'use strict';

/**
 * Migration: Layer 5 — Insurance Layer
 *
 * Creates:
 *   1. insurance_companies           — insurance company registry
 *   2. user_insurance_profiles       — user-to-company insurance profiles
 *   3. pharmacy_insurance_contracts  — pharmacy-to-company contract mappings
 *
 * Modifies:
 *   4. requests  — adds insurance_profile_id (nullable FK)
 *   5. subscriptions — adds FK constraint on insurance_profile_id
 *
 * Spec: specs/insurance-layer/spec.md v1
 * Plan: implementation_plan.md §2
 */

exports.shorthands = undefined;

/** @param pgm {import('node-pg-migrate').MigrationBuilder} */
exports.up = (pgm) => {
    // ═══════════════════════════════════════════════════════════════════════
    // 1. INSURANCE COMPANIES
    // ═══════════════════════════════════════════════════════════════════════
    pgm.createTable('insurance_companies', {
        id: {
            type: 'uuid',
            primaryKey: true,
            default: pgm.func('gen_random_uuid()'),
        },
        name: {
            type: 'varchar(255)',
            notNull: true,
            unique: true,
            comment: 'Company display name',
        },
        code: {
            type: 'varchar(50)',
            notNull: true,
            unique: true,
            comment: "Short code for API use (e.g., 'BUPA_SA')",
        },
        is_active: {
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

    // ═══════════════════════════════════════════════════════════════════════
    // 2. USER INSURANCE PROFILES
    // ═══════════════════════════════════════════════════════════════════════
    pgm.createTable('user_insurance_profiles', {
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
            comment: 'Profile owner',
        },
        insurance_company_id: {
            type: 'uuid',
            notNull: true,
            references: '"insurance_companies"',
            onDelete: 'RESTRICT',
        },
        member_id: {
            type: 'varchar(100)',
            notNull: true,
            comment: 'Insurance member/policy number',
        },
        id_document_url: {
            type: 'text',
            comment: 'URL to uploaded national ID scan',
        },
        card_document_url: {
            type: 'text',
            comment: 'URL to uploaded insurance card scan',
        },
        is_verified: {
            type: 'boolean',
            notNull: true,
            default: false,
            comment: 'Future: admin verification flag',
        },
        is_active: {
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

    pgm.createIndex('user_insurance_profiles', 'user_id');
    pgm.addConstraint('user_insurance_profiles', 'uq_user_insurance_company', {
        unique: ['user_id', 'insurance_company_id'],
    });

    // ═══════════════════════════════════════════════════════════════════════
    // 3. PHARMACY INSURANCE CONTRACTS
    // ═══════════════════════════════════════════════════════════════════════
    pgm.createTable('pharmacy_insurance_contracts', {
        id: {
            type: 'uuid',
            primaryKey: true,
            default: pgm.func('gen_random_uuid()'),
        },
        pharmacy_id: {
            type: 'uuid',
            notNull: true,
            references: '"pharmacies"',
            onDelete: 'RESTRICT',
        },
        insurance_company_id: {
            type: 'uuid',
            notNull: true,
            references: '"insurance_companies"',
            onDelete: 'RESTRICT',
        },
        is_active: {
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

    pgm.createIndex('pharmacy_insurance_contracts', 'pharmacy_id');
    pgm.createIndex('pharmacy_insurance_contracts', 'insurance_company_id');
    pgm.addConstraint('pharmacy_insurance_contracts', 'uq_pharmacy_insurance_company', {
        unique: ['pharmacy_id', 'insurance_company_id'],
    });
    pgm.createIndex('pharmacy_insurance_contracts', ['insurance_company_id', 'is_active'], {
        name: 'idx_pic_company_active',
    });

    // ═══════════════════════════════════════════════════════════════════════
    // 4. ADD insurance_profile_id TO REQUESTS
    // ═══════════════════════════════════════════════════════════════════════
    pgm.addColumn('requests', {
        insurance_profile_id: {
            type: 'uuid',
            references: '"user_insurance_profiles"',
            onDelete: 'SET NULL',
            comment: 'If set, triggers insurance-filtered routing',
        },
    });

    pgm.createIndex('requests', 'insurance_profile_id', {
        name: 'idx_requests_insurance_profile',
    });

    // ═══════════════════════════════════════════════════════════════════════
    // 5. ADD FK ON subscriptions.insurance_profile_id
    //    Column already exists from Phase 8 migration (nullable UUID).
    //    Now that user_insurance_profiles table exists, add the FK.
    // ═══════════════════════════════════════════════════════════════════════
    pgm.addConstraint('subscriptions', 'fk_subscriptions_insurance_profile', {
        foreignKeys: {
            columns: 'insurance_profile_id',
            references: '"user_insurance_profiles"(id)',
            onDelete: 'SET NULL',
        },
    });
};

/** @param pgm {import('node-pg-migrate').MigrationBuilder} */
exports.down = (pgm) => {
    // Remove FK on subscriptions
    pgm.dropConstraint('subscriptions', 'fk_subscriptions_insurance_profile');

    // Remove column from requests
    pgm.dropColumn('requests', 'insurance_profile_id');

    // Drop tables in reverse dependency order
    pgm.dropTable('pharmacy_insurance_contracts');
    pgm.dropTable('user_insurance_profiles');
    pgm.dropTable('insurance_companies');
};
