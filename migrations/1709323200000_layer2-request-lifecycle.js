/**
 * Layer 2 — Request Lifecycle Model
 *
 * Creates:
 *   1. users          — minimal identity layer (phone, full_name)
 *   2. requests       — core request object for standard/rare routing
 *   3. request_items  — individual items within a request
 *   4. offers         — pharmacy responses to a request
 *
 * Architectural decisions:
 *   - Identity: supports both anonymous (user_id IS NULL) and identified users.
 *   - Request state: ENUM (draft -> broadcasted -> ... -> cancelled/expired).
 *   - Request type: ENUM (standard vs rare).
 *   - Offers: UNIQUE(request_id, pharmacy_id), meaning 1 offer per pharmacy per request.
 *     -> Invariant: Offer revisions update the same row (no versioning in MVP).
 *   - Identity Invariant: If user_id IS NOT NULL, contact_phone must match users.phone 
 *     (enforced at application level).
 *   - Routing Invariant: Standard requests restrict offers to pharmacies within 
 *     request.zone_id. Rare requests allow cross-zone offers.
 *   - No orders, no commissions, no routing logs yet.
 */

/** @type {import('node-pg-migrate').MigrationBuilder} */
exports.up = (pgm) => {
    // ═══════════════════════════════════════════════════════════════════════
    // 1. USERS (Minimal Identity Layer)
    // ═══════════════════════════════════════════════════════════════════════
    pgm.createTable('users', {
        id: {
            type: 'uuid',
            primaryKey: true,
            default: pgm.func('gen_random_uuid()'),
        },
        phone: {
            type: 'varchar(20)',
            notNull: true,
            unique: true,
            comment: 'Primary identifier for Medyova users',
        },
        full_name: {
            type: 'varchar(255)',
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
    // 2. ENUMS
    // ═══════════════════════════════════════════════════════════════════════
    pgm.createType('request_state_enum', [
        'draft',             // Pre-broadcast execution
        'broadcasted',       // Active routing
        'partially_offered', // Some items offered, waiting for others
        'fully_offered',     // All items have at least one offer available
        'accepted',          // User accepted an offer
        'expired',           // TTL reached without acceptance
        'cancelled',         // Cancelled by user or system
    ]);

    pgm.createType('request_type_enum', ['standard', 'rare']);

    pgm.createType('offer_status_enum', [
        'pending',   // Offer submitted, waiting for user response
        'accepted',  // User selected this offer
        'rejected',  // User selected a different offer
        'expired',   // Request expired or cancelled
    ]);

    // ═══════════════════════════════════════════════════════════════════════
    // 3. REQUESTS
    // ═══════════════════════════════════════════════════════════════════════
    pgm.createTable('requests', {
        id: {
            type: 'uuid',
            primaryKey: true,
            default: pgm.func('gen_random_uuid()'),
        },

        // ── Identity & Contact ───────────────────────────────────────────
        user_id: {
            type: 'uuid',
            references: 'users(id)',
            onDelete: 'SET NULL',
            comment: 'NULL if anonymous request',
        },
        contact_phone: {
            type: 'varchar(20)',
            notNull: true,
            comment: 'Must match users.phone if user_id is NOT NULL',
        },

        // ── State & Type ─────────────────────────────────────────────────
        state: {
            type: 'request_state_enum',
            notNull: true,
            default: 'draft',
        },
        type: {
            type: 'request_type_enum',
            notNull: true,
            default: 'standard',
        },

        // ── Zone Context ──────────────────────────────────────────────────
        zone_id: {
            type: 'uuid',
            notNull: true,
            references: 'zones(id)',
            onDelete: 'RESTRICT',
            comment: 'The delivery/search zone for this request',
        },

        // ── Timeouts & SLA ────────────────────────────────────────────────
        broadcasted_at: {
            type: 'timestamptz',
            comment: 'When the request transitioned to broadcasted state',
        },
        expires_at: {
            type: 'timestamptz',
            comment: 'TTL deadline, after which the request becomes expired',
        },

        // ── Metadata & Images ─────────────────────────────────────────────
        prescription_url: {
            type: 'text',
            comment: 'URL to the uploaded prescription image, if provided',
        },
        notes: {
            type: 'text',
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

    // Indexes
    pgm.createIndex('requests', 'user_id');
    pgm.createIndex('requests', 'zone_id');
    pgm.createIndex('requests', 'state');
    pgm.createIndex('requests', ['zone_id', 'state'], {
        name: 'idx_requests_zone_state',
    });
    pgm.createIndex('requests', 'type');
    pgm.createIndex('requests', 'created_at');

    // ═══════════════════════════════════════════════════════════════════════
    // 4. REQUEST_ITEMS
    // ═══════════════════════════════════════════════════════════════════════
    pgm.createTable('request_items', {
        id: {
            type: 'uuid',
            primaryKey: true,
            default: pgm.func('gen_random_uuid()'),
        },
        request_id: {
            type: 'uuid',
            notNull: true,
            references: 'requests(id)',
            onDelete: 'CASCADE',
        },

        // ── Item Details ──────────────────────────────────────────────────
        product_name: {
            type: 'varchar(255)',
            notNull: true,
        },
        quantity: {
            type: 'integer',
            notNull: true,
            check: 'quantity > 0',
            default: 1,
        },
        is_substitution_allowed: {
            type: 'boolean',
            notNull: true,
            default: true,
            comment: 'If false, pharmacy MUST provide exact match',
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

    pgm.createIndex('request_items', 'request_id');

    // ═══════════════════════════════════════════════════════════════════════
    // 5. OFFERS
    // ═══════════════════════════════════════════════════════════════════════
    pgm.createTable('offers', {
        id: {
            type: 'uuid',
            primaryKey: true,
            default: pgm.func('gen_random_uuid()'),
        },
        request_id: {
            type: 'uuid',
            notNull: true,
            references: 'requests(id)',
            onDelete: 'CASCADE',
        },
        pharmacy_id: {
            type: 'uuid',
            notNull: true,
            references: 'pharmacies(id)',
            onDelete: 'RESTRICT',
        },

        // ── Offer State ───────────────────────────────────────────────────
        status: {
            type: 'offer_status_enum',
            notNull: true,
            default: 'pending',
        },

        // ── Pricing & Logistics ───────────────────────────────────────────
        total_price: {
            type: 'numeric(10,2)',
            notNull: true,
            check: 'total_price >= 0',
            comment: 'Total cost of the offered items',
        },
        delivery_fee: {
            type: 'numeric(10,2)',
            notNull: true,
            default: 0,
            check: 'delivery_fee >= 0',
            comment: 'Cost to deliver to the user',
        },
        prep_time_minutes: {
            type: 'integer',
            comment: 'Estimated preparation time before dispatch',
        },
        notes: {
            type: 'text',
            comment: 'Pharmacy notes to the user (e.g. substitution details)',
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

    // Unique constraint: A pharmacy can only submit ONE offer per request
    pgm.addConstraint('offers', 'uq_offers_request_pharmacy', {
        unique: ['request_id', 'pharmacy_id'],
    });

    pgm.createIndex('offers', 'request_id');
    pgm.createIndex('offers', 'pharmacy_id');
    pgm.createIndex('offers', 'status');
};

/** @type {import('node-pg-migrate').MigrationBuilder} */
exports.down = (pgm) => {
    pgm.dropTable('offers');
    pgm.dropTable('request_items');
    pgm.dropTable('requests');
    pgm.dropTable('users');

    pgm.dropType('offer_status_enum');
    pgm.dropType('request_type_enum');
    pgm.dropType('request_state_enum');
};
