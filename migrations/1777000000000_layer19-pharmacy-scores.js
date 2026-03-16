exports.up = (pgm) => {
    // ─── 1. pharmacy_scores ──────────────────────────────────────
    pgm.createTable('pharmacy_scores', {
        id: {
            type: 'uuid',
            default: pgm.func('gen_random_uuid()'),
            primaryKey: true
        },
        pharmacy_id: {
            type: 'uuid',
            notNull: true,
            unique: true,
            references: '"pharmacies"',
            onDelete: 'CASCADE'
        },
        total_score: {
            type: 'numeric(5,2)',
            default: 50.00,
            notNull: true
        },
        response_time_score: {
            type: 'numeric(5,2)',
            default: 0.00
        },
        availability_score: {
            type: 'numeric(5,2)',
            default: 0.00
        },
        rating_score: {
            type: 'numeric(5,2)',
            default: 0.00
        },
        freshness_score: {
            type: 'numeric(5,2)',
            default: 0.00
        },
        cancellation_rate: {
            type: 'numeric(5,4)', // up to 1.0000
            default: 0.0000
        },
        tier: {
            type: 'varchar(20)',
            default: 'bronze',
            notNull: true
        },
        last_calculated_at: {
            type: 'timestamp with time zone',
            default: pgm.func('NOW()')
        },
        created_at: {
            type: 'timestamp with time zone',
            notNull: true,
            default: pgm.func('NOW()')
        },
        updated_at: {
            type: 'timestamp with time zone',
            notNull: true,
            default: pgm.func('NOW()')
        }
    }, {
        ifNotExists: true
    });

    // Add CHECK constraint for tier values
    pgm.addConstraint('pharmacy_scores', 'pharmacy_scores_tier_check', {
        check: "tier IN ('platinum', 'gold', 'silver', 'bronze')"
    });

    // Add timestamp trigger
    pgm.createTrigger('pharmacy_scores', 'update_pharmacy_scores_updated_at', {
        when: 'BEFORE',
        operation: 'UPDATE',
        function: 'update_timestamp',
        level: 'ROW'
    });
};

exports.down = (pgm) => {
    pgm.dropTable('pharmacy_scores', { cascade: true });
};
