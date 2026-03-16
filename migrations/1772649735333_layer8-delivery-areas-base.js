/* eslint-disable camelcase */

exports.shorthands = undefined;

exports.up = (pgm) => {
    // ── 1. Create areas table ──
    pgm.createTable('areas', {
        id: {
            type: 'uuid',
            primaryKey: true,
            default: pgm.func('gen_random_uuid()')
        },
        zone_id: {
            type: 'uuid',
            notNull: true,
            references: '"zones"',
            onDelete: 'CASCADE'
        },
        name: {
            type: 'varchar(255)',
            notNull: true
        },
        is_active: {
            type: 'boolean',
            notNull: true,
            default: true
        },
        is_legacy: {
            type: 'boolean',
            notNull: true,
            default: false
        },
        created_at: {
            type: 'timestamp with time zone',
            notNull: true,
            default: pgm.func('CURRENT_TIMESTAMP')
        },
        updated_at: {
            type: 'timestamp with time zone',
            notNull: true,
            default: pgm.func('CURRENT_TIMESTAMP')
        }
    });

    // ── 2. Create pharmacy_delivery_areas pivot table ──
    pgm.createTable('pharmacy_delivery_areas', {
        pharmacy_id: {
            type: 'uuid',
            notNull: true,
            references: '"pharmacies"',
            onDelete: 'CASCADE'
        },
        area_id: {
            type: 'uuid',
            notNull: true,
            references: '"areas"',
            onDelete: 'CASCADE'
        },
        created_at: {
            type: 'timestamp with time zone',
            notNull: true,
            default: pgm.func('CURRENT_TIMESTAMP')
        }
    });

    // Enforce unique Area + Pharmacy combination as the Primary Key
    pgm.addConstraint('pharmacy_delivery_areas', 'pharmacy_delivery_areas_pkey', {
        primaryKey: ['pharmacy_id', 'area_id']
    });

    // ── 3. Composite Index for Routing worker ──
    // The query eligibility filter checks both area_id + pharmacy_id mapping
    // This perfectly covers the JOIN pattern:
    // JOIN ... ON pda.pharmacy_id = p.id WHERE pda.area_id = $2
    pgm.createIndex('pharmacy_delivery_areas', ['area_id', 'pharmacy_id'], {
        name: 'idx_pharmacy_delivery_areas_area_pharmacy'
    });
};

exports.down = (pgm) => {
    pgm.dropIndex('pharmacy_delivery_areas', [], { name: 'idx_pharmacy_delivery_areas_area_pharmacy' });
    pgm.dropTable('pharmacy_delivery_areas');
    pgm.dropTable('areas');
};
