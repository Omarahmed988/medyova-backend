'use strict';

/**
 * Migration: layer15-launch-hardening-tables
 * Adds tracking tables for unmatched medicines, inventory uploads, and catalog duplicate reports.
 */

exports.up = (pgm) => {
    // 1. Unmatched Medicines Log (for Alias Dashboard)
    pgm.createTable('unmatched_medicines_log', {
        id: { type: 'uuid', default: pgm.func('gen_random_uuid()'), primaryKey: true },
        pharmacy_id: { type: 'uuid', notNull: true, references: '"pharmacies"', onDelete: 'CASCADE' },
        raw_name: { type: 'varchar(255)', notNull: true },
        frequency_count: { type: 'integer', notNull: true, default: 1 },
        created_at: { type: 'timestamp', notNull: true, default: pgm.func('NOW()') },
        updated_at: { type: 'timestamp', notNull: true, default: pgm.func('NOW()') }
    });

    // Unique constraint on pharmacy_id + raw_name allows UPSERT tracking
    pgm.addConstraint('unmatched_medicines_log', 'unmatched_medicines_log_uniq', {
        unique: ['pharmacy_id', 'raw_name']
    });

    // 2. Inventory Upload Logs (for Rate Limiting and Health Score)
    pgm.createTable('inventory_upload_logs', {
        id: { type: 'uuid', default: pgm.func('gen_random_uuid()'), primaryKey: true },
        pharmacy_id: { type: 'uuid', notNull: true, references: '"pharmacies"', onDelete: 'CASCADE' },
        status: { type: 'varchar(50)', notNull: true, check: "status IN ('success', 'failed')" },
        total_rows: { type: 'integer', notNull: true, default: 0 },
        matched_rows: { type: 'integer', notNull: true, default: 0 },
        created_at: { type: 'timestamp', notNull: true, default: pgm.func('NOW()') }
    });

    pgm.createIndex('inventory_upload_logs', ['pharmacy_id', 'created_at']);

    // 3. Catalog Duplicates Report (for the background scanner)
    pgm.createTable('catalog_duplicates_report', {
        id: { type: 'uuid', default: pgm.func('gen_random_uuid()'), primaryKey: true },
        medicine_a_id: { type: 'uuid', notNull: true, references: '"medicines"', onDelete: 'CASCADE' },
        medicine_b_id: { type: 'uuid', notNull: true, references: '"medicines"', onDelete: 'CASCADE' },
        similarity_score: { type: 'numeric(3, 2)', notNull: true },
        is_resolved: { type: 'boolean', notNull: true, default: false },
        created_at: { type: 'timestamp', notNull: true, default: pgm.func('NOW()') }
    });

    // Ensure we don't insert A->B and B->A as separate tasks
    pgm.addConstraint('catalog_duplicates_report', 'catalog_duplicates_unique_pair', {
        unique: ['medicine_a_id', 'medicine_b_id']
    });
};

exports.down = (pgm) => {
    pgm.dropTable('catalog_duplicates_report');
    pgm.dropTable('inventory_upload_logs');
    pgm.dropTable('unmatched_medicines_log');
};
