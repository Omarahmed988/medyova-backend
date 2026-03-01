/**
 * Layer 1 — Core Structural Entities
 *
 * Creates:
 *   1. zones        — flat geographic zones (name + city)
 *   2. tiers        — pharmacy tier definitions (gold, silver, bronze)
 *   3. pharmacies   — pharmacy profiles with trust score components
 *
 * Architectural decisions:
 *   - Pharmacy ↔ Zone: 1:N (single zone, NOT NULL FK)
 *   - Tier governance: hybrid (computed + manual override)
 *   - Trust score: persisted snapshot (0–100), not computed at query time
 *   - Zone model: flat (no hierarchy, no polygons)
 */

/** @type {import('node-pg-migrate').MigrationBuilder} */
exports.up = (pgm) => {
    // ═══════════════════════════════════════════════════════════════════════
    // 1. ZONES
    // ═══════════════════════════════════════════════════════════════════════
    pgm.createTable('zones', {
        id: {
            type: 'uuid',
            primaryKey: true,
            default: pgm.func('gen_random_uuid()'),
        },
        name: {
            type: 'varchar(100)',
            notNull: true,
        },
        city: {
            type: 'varchar(100)',
            notNull: true,
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

    pgm.addConstraint('zones', 'uq_zones_name_city', {
        unique: ['name', 'city'],
    });
    pgm.createIndex('zones', 'city');
    pgm.createIndex('zones', 'is_active');

    // ═══════════════════════════════════════════════════════════════════════
    // 2. TIERS
    // ═══════════════════════════════════════════════════════════════════════
    pgm.createTable('tiers', {
        id: {
            type: 'uuid',
            primaryKey: true,
            default: pgm.func('gen_random_uuid()'),
        },
        name: {
            type: 'varchar(50)',
            notNull: true,
            unique: true,
        },
        rank: {
            type: 'smallint',
            notNull: true,
            unique: true,
            check: 'rank > 0',
            comment: 'Routing priority order: 1 = highest priority (gold), 2 = silver, 3 = bronze',
        },
        description: {
            type: 'text',
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

    pgm.createIndex('tiers', 'rank');

    // ═══════════════════════════════════════════════════════════════════════
    // 3. TIER_SOURCE ENUM
    // ═══════════════════════════════════════════════════════════════════════
    pgm.createType('tier_source_enum', ['computed', 'manual_override']);

    // ═══════════════════════════════════════════════════════════════════════
    // 4. PHARMACIES
    // ═══════════════════════════════════════════════════════════════════════
    pgm.createTable('pharmacies', {
        id: {
            type: 'uuid',
            primaryKey: true,
            default: pgm.func('gen_random_uuid()'),
        },
        name: {
            type: 'varchar(255)',
            notNull: true,
        },

        // ── Zone relationship (1:N, NOT NULL) ──────────────────────────────
        zone_id: {
            type: 'uuid',
            notNull: true,
            references: 'zones(id)',
            onDelete: 'RESTRICT',
        },

        // ── Tier governance (hybrid) ──────────────────────────────────────
        tier_id: {
            type: 'uuid',
            notNull: true,
            references: 'tiers(id)',
            onDelete: 'RESTRICT',
        },
        tier_source: {
            type: 'tier_source_enum',
            notNull: true,
            default: 'computed',
        },

        // ── Trust score components (persisted, 0–100) ─────────────────────
        trust_score: {
            type: 'numeric(5,2)',
            notNull: true,
            default: 0,
            check: 'trust_score >= 0 AND trust_score <= 100',
            comment: 'Composite trust score (0–100), persisted by Trust Engine',
        },
        response_rate: {
            type: 'numeric(5,2)',
            notNull: true,
            default: 0,
            check: 'response_rate >= 0 AND response_rate <= 100',
            comment: 'Response rate percentage (0–100)',
        },
        sla_compliance: {
            type: 'numeric(5,2)',
            notNull: true,
            default: 0,
            check: 'sla_compliance >= 0 AND sla_compliance <= 100',
            comment: 'SLA compliance percentage (0–100)',
        },
        cancellation_rate: {
            type: 'numeric(5,2)',
            notNull: true,
            default: 0,
            check: 'cancellation_rate >= 0 AND cancellation_rate <= 100',
            comment: 'Cancellation rate percentage (0–100), lower is better',
        },
        acceptance_rate: {
            type: 'numeric(5,2)',
            notNull: true,
            default: 0,
            check: 'acceptance_rate >= 0 AND acceptance_rate <= 100',
            comment: 'Acceptance rate percentage (0–100)',
        },

        // ── Operational flags ─────────────────────────────────────────────
        supports_rare: {
            type: 'boolean',
            notNull: true,
            default: false,
            comment: 'Whether pharmacy handles rare/scarce medications',
        },
        is_active: {
            type: 'boolean',
            notNull: true,
            default: true,
        },

        // ── Contact ───────────────────────────────────────────────────────
        contact_email: {
            type: 'varchar(255)',
        },
        contact_phone: {
            type: 'varchar(20)',
        },

        // ── Audit ─────────────────────────────────────────────────────────
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

    // ── Constraints ──────────────────────────────────────────────────────
    pgm.addConstraint('pharmacies', 'uq_pharmacies_name_zone', {
        unique: ['name', 'zone_id'],
    });

    // ── Indexes ──────────────────────────────────────────────────────────
    pgm.createIndex('pharmacies', 'zone_id');
    pgm.createIndex('pharmacies', 'tier_id');
    pgm.createIndex('pharmacies', 'is_active');
    pgm.createIndex('pharmacies', 'supports_rare');
    pgm.createIndex('pharmacies', ['zone_id', 'is_active'], {
        name: 'idx_pharmacies_zone_active',
    });
    pgm.sql('CREATE INDEX idx_pharmacies_trust_score_desc ON pharmacies (trust_score DESC)');
};

/** @type {import('node-pg-migrate').MigrationBuilder} */
exports.down = (pgm) => {
    pgm.dropTable('pharmacies');
    pgm.dropType('tier_source_enum');
    pgm.dropTable('tiers');
    pgm.dropTable('zones');
};
