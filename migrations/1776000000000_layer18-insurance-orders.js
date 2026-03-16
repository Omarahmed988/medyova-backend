'use strict';

exports.shorthands = undefined;

exports.up = (pgm) => {
    // ─── 1. user_insurance_profiles (must come before patient_profiles FK) ───
    pgm.createTable('user_insurance_profiles', {
        id: {
            type: 'uuid',
            primaryKey: true,
            default: pgm.func('gen_random_uuid()')
        },
        user_id: {
            type: 'uuid',
            notNull: true,
            references: '"users"',
            onDelete: 'CASCADE'
        },
        insurance_company_id: {
            type: 'uuid',
            notNull: true,
            references: '"insurance_companies"',
            onDelete: 'CASCADE'
        },
        insurance_card_number: {
            type: 'varchar(100)',
            notNull: true
        },
        insurance_card_image_url: { type: 'text' },
        national_id_image_url: { type: 'text' },
        created_at: {
            type: 'timestamptz',
            notNull: true,
            default: pgm.func('current_timestamp')
        },
        updated_at: {
            type: 'timestamptz',
            notNull: true,
            default: pgm.func('current_timestamp')
        }
    });

    pgm.addConstraint('user_insurance_profiles', 'uniq_user_insurance_company', {
        unique: ['user_id', 'insurance_company_id']
    });

    pgm.createIndex('user_insurance_profiles', ['user_id'], {
        name: 'idx_user_insurance_profiles_user'
    });

    // ─── 2. patient_profiles ─────────────────────────────────────────────
    pgm.createTable('patient_profiles', {
        id: {
            type: 'uuid',
            primaryKey: true,
            default: pgm.func('gen_random_uuid()')
        },
        user_id: {
            type: 'uuid',
            notNull: true,
            references: '"users"',
            onDelete: 'CASCADE'
        },
        name: {
            type: 'varchar(100)',
            notNull: true
        },
        date_of_birth: { type: 'date' },
        phone: { type: 'varchar(20)' },
        national_id: { type: 'varchar(50)' },
        insurance_profile_id: {
            type: 'uuid',
            references: '"user_insurance_profiles"',
            onDelete: 'SET NULL'
        },
        default_address_id: { type: 'uuid' },
        is_active: {
            type: 'boolean',
            notNull: true,
            default: true
        },
        created_at: {
            type: 'timestamptz',
            notNull: true,
            default: pgm.func('current_timestamp')
        },
        updated_at: {
            type: 'timestamptz',
            notNull: true,
            default: pgm.func('current_timestamp')
        }
    });

    pgm.createIndex('patient_profiles', ['user_id'], {
        name: 'idx_patient_profiles_user'
    });

    // ─── 3. orders table extensions ──────────────────────────────────────
    pgm.addColumns('orders', {
        insurance_profile_id: {
            type: 'uuid',
            references: '"user_insurance_profiles"',
            onDelete: 'SET NULL'
        },
        patient_profile_id: {
            type: 'uuid',
            references: '"patient_profiles"',
            onDelete: 'SET NULL'
        }
    });

    // Update check constraints to allow 'insurance' type
    pgm.dropConstraint('orders', 'orders_type_check');
    pgm.addConstraint('orders', 'orders_type_check', {
        check: "type IN ('prescription', 'direct', 'insurance')"
    });

    pgm.dropConstraint('orders', 'orders_prescription_integrity');
    pgm.addConstraint('orders', 'orders_prescription_integrity', {
        check: "type IN ('direct', 'insurance') OR (request_id IS NOT NULL AND offer_id IS NOT NULL)"
    });

    // ─── 4. insurance_documents ──────────────────────────────────────────
    pgm.createTable('insurance_documents', {
        id: {
            type: 'uuid',
            primaryKey: true,
            default: pgm.func('gen_random_uuid()')
        },
        order_id: {
            type: 'uuid',
            notNull: true,
            references: '"orders"',
            onDelete: 'CASCADE'
        },
        prescription_image_url: { type: 'text' },
        insurance_approval_image_url: { type: 'text' },
        created_at: {
            type: 'timestamptz',
            notNull: true,
            default: pgm.func('current_timestamp')
        }
    });

    pgm.createIndex('insurance_documents', ['order_id'], {
        name: 'idx_insurance_documents_order'
    });

    // ─── 5. subscriptions table extensions ───────────────────────────────
    pgm.addColumns('subscriptions', {
        insurance_company_id: {
            type: 'uuid',
            references: '"insurance_companies"',
            onDelete: 'SET NULL'
        },
        insurance_profile_id: {
            type: 'uuid',
            references: '"user_insurance_profiles"',
            onDelete: 'SET NULL'
        },
        patient_profile_id: {
            type: 'uuid',
            references: '"patient_profiles"',
            onDelete: 'SET NULL'
        }
    });
};

exports.down = (pgm) => {
    pgm.dropColumns('subscriptions', ['insurance_company_id', 'insurance_profile_id', 'patient_profile_id']);
    pgm.dropTable('insurance_documents');

    // Revert check constraints
    pgm.dropConstraint('orders', 'orders_type_check');
    pgm.addConstraint('orders', 'orders_type_check', {
        check: "type IN ('prescription', 'direct')"
    });

    pgm.dropConstraint('orders', 'orders_prescription_integrity');
    pgm.addConstraint('orders', 'orders_prescription_integrity', {
        check: "type = 'direct' OR (request_id IS NOT NULL AND offer_id IS NOT NULL)"
    });

    pgm.dropColumns('orders', ['insurance_profile_id', 'patient_profile_id']);
    pgm.dropTable('patient_profiles');
    pgm.dropTable('user_insurance_profiles');
};
