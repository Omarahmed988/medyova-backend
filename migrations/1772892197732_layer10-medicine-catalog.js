/* eslint-disable camelcase */

/**
 * Migration A — Phase 14: Medicine Search
 *
 * Creates:
 *   1. medicines          — catalog with scarcity controls and trigram search indexes
 *   2. medicine_aliases   — normalized name resolution (Arabic names, abbreviations)
 *   3. pharmacy_inventory — per-pharmacy stock with freshness tracking
 *
 * Search strategy:
 *   - Trigram GIN indexes on name, generic_name, brand_name
 *   - Search queries use the '%' similarity operator to leverage GIN indexes
 *     and avoid sequential scans on large catalogs
 *
 * Seed source: Egypt Drug Authority medicine registry
 */

exports.shorthands = undefined;

exports.up = (pgm) => {
    // Enable trigram extension for fuzzy search
    pgm.sql('CREATE EXTENSION IF NOT EXISTS pg_trgm;');

    // ── 1. Medicines Catalog ───────────────────────────────────────────────
    pgm.sql(`
        CREATE TABLE medicines (
            id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            name          VARCHAR(255) NOT NULL,
            generic_name  VARCHAR(255),
            brand_name    VARCHAR(255),
            form          VARCHAR(100),
            strength      VARCHAR(100),
            is_active     BOOLEAN NOT NULL DEFAULT true,
            is_shortage   BOOLEAN NOT NULL DEFAULT false,
            max_order_qty SMALLINT NOT NULL DEFAULT 5 CHECK (max_order_qty >= 1),
            created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
    `);

    // Trigram GIN indexes — support the '%' similarity operator in search queries
    pgm.sql('CREATE INDEX idx_medicines_name_trgm    ON medicines USING gin (name gin_trgm_ops);');
    pgm.sql('CREATE INDEX idx_medicines_generic_trgm ON medicines USING gin (generic_name gin_trgm_ops);');
    pgm.sql('CREATE INDEX idx_medicines_brand_trgm   ON medicines USING gin (brand_name gin_trgm_ops);');
    pgm.createIndex('medicines', 'is_active', { name: 'idx_medicines_is_active' });

    // ── 2. Medicine Aliases ────────────────────────────────────────────────
    // Used by the Excel normalization pipeline for name resolution.
    // UNIQUE on LOWER(alias) prevents duplicate aliases regardless of case.
    pgm.sql(`
        CREATE TABLE medicine_aliases (
            id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            alias       VARCHAR(255) NOT NULL,
            medicine_id UUID NOT NULL REFERENCES medicines(id) ON DELETE CASCADE,
            created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
    `);

    pgm.sql('CREATE UNIQUE INDEX idx_medicine_aliases_alias_lower ON medicine_aliases(LOWER(alias));');
    pgm.createIndex('medicine_aliases', 'medicine_id', { name: 'idx_medicine_aliases_medicine' });

    // ── 3. Pharmacy Inventory ──────────────────────────────────────────────
    // UNIQUE(pharmacy_id, medicine_id) — one price/stock entry per pharmacy per medicine.
    // updated_at is indexed to support freshness queries (48h staleness threshold).
    pgm.sql(`
        CREATE TABLE pharmacy_inventory (
            id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            pharmacy_id  UUID NOT NULL REFERENCES pharmacies(id) ON DELETE CASCADE,
            medicine_id  UUID NOT NULL REFERENCES medicines(id) ON DELETE CASCADE,
            price        NUMERIC(10,2) NOT NULL CHECK (price > 0),
            stock_status VARCHAR(20) NOT NULL DEFAULT 'available'
                         CHECK (stock_status IN ('available', 'low_stock', 'out_of_stock')),
            updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            CONSTRAINT pharmacy_inventory_unique UNIQUE (pharmacy_id, medicine_id)
        );
    `);

    pgm.createIndex('pharmacy_inventory', 'medicine_id', { name: 'idx_pharmacy_inventory_medicine' });
    pgm.createIndex('pharmacy_inventory', 'pharmacy_id', { name: 'idx_pharmacy_inventory_pharmacy' });
    pgm.createIndex('pharmacy_inventory', 'updated_at', { name: 'idx_pharmacy_inventory_updated' });
};

exports.down = (pgm) => {
    pgm.dropTable('pharmacy_inventory');
    pgm.dropTable('medicine_aliases');
    pgm.dropTable('medicines');
    // Note: pg_trgm extension is not dropped — may be used by other features.
};
