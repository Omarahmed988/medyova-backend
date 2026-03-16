'use strict';

exports.shorthands = undefined;

exports.up = (pgm) => {
    // 1. insurance_companies
    pgm.createTable('insurance_companies', {
        id: {
            type: 'uuid',
            primaryKey: true,
            default: pgm.func('uuid_generate_v4()')
        },
        name: {
            type: 'varchar(100)',
            notNull: true,
            unique: true
        },
        created_at: {
            type: 'timestamptz',
            notNull: true,
            default: pgm.func('current_timestamp')
        }
    });

    // 2. pharmacy_insurance_contracts
    pgm.createTable('pharmacy_insurance_contracts', {
        pharmacy_id: {
            type: 'uuid',
            notNull: true,
            references: '"pharmacies"',
            onDelete: 'CASCADE'
        },
        insurance_company_id: {
            type: 'uuid',
            notNull: true,
            references: '"insurance_companies"',
            onDelete: 'CASCADE'
        },
        contract_active: {
            type: 'boolean',
            notNull: true,
            default: true
        },
        created_at: {
            type: 'timestamptz',
            notNull: true,
            default: pgm.func('current_timestamp')
        }
    });

    // Composite Uniqueness
    pgm.addConstraint('pharmacy_insurance_contracts', 'uniq_pharmacy_insurance', {
        unique: ['pharmacy_id', 'insurance_company_id']
    });

    // Index for search scaling
    pgm.createIndex('pharmacy_insurance_contracts', ['insurance_company_id', 'pharmacy_id'], {
        name: 'idx_pharmacy_insurance_company',
        where: 'contract_active = true'
    });

    // 3. Store insurance context in Flow B orders
    pgm.addColumns('orders', {
        insurance_company_id: {
            type: 'uuid',
            references: '"insurance_companies"',
            onDelete: 'SET NULL' // Keep order intact if insurance is deleted
        }
    });
};

exports.down = (pgm) => {
    pgm.dropColumns('orders', ['insurance_company_id']);
    pgm.dropTable('pharmacy_insurance_contracts');
    pgm.dropTable('insurance_companies');
};
