/**
 * Layer 3 — Routing Infrastructure
 *
 * Creates:
 *   1. routing_job_status_enum  — lifecycle states for routing jobs
 *   2. wave_status_enum         — lifecycle states for routing waves
 *   3. routing_jobs             — one job per broadcasted request
 *   4. routing_waves            — tier-level execution windows within a job
 *
 * Spec reference: specs/routing-engine/spec.md (v2, approved)
 *
 * Architectural decisions:
 *   - No max_waves column. Escalation depth is derived dynamically from active tiers.
 *   - window_duration_sec is snapshotted from tier config at wave creation (no default).
 *   - UNIQUE(request_id) on routing_jobs: one job per request.
 *   - UNIQUE(job_id, wave_number) on routing_waves: one wave per tier per job.
 *   - Sufficient offer rule (MVP): escalation stops when offers_received >= 1.
 *   - Idempotency: all operations are safe to re-run (ON CONFLICT DO NOTHING pattern).
 *   - No business logic. Schema only.
 *
 * Application-level invariants (not enforced in schema):
 *   - started_at must be set when status transitions from 'pending' to 'active'.
 *   - completed_at must be set when a job/wave enters a terminal state.
 *   - current_wave must always match the highest active wave_number.
 *   - offers_received is a snapshot metric, not a live aggregate.
 */

/** @type {import('node-pg-migrate').MigrationBuilder} */
exports.up = (pgm) => {
    // ═══════════════════════════════════════════════════════════════════════
    // 1. ENUMS
    // ═══════════════════════════════════════════════════════════════════════
    pgm.createType('routing_job_status_enum', [
        'pending',    // Job created, not yet started
        'active',     // Currently routing (at least one wave in progress)
        'completed',  // Routing finished (offers received or all tiers exhausted)
        'expired',    // Parent request hit expires_at before completion
        'failed',     // Unrecoverable error during routing
        'cancelled',  // Parent request was cancelled
    ]);

    pgm.createType('wave_status_enum', [
        'pending',    // Wave created, not yet started
        'active',     // Wave window is currently open
        'completed',  // Wave window elapsed, escalation triggered or job completed
        'skipped',    // No eligible pharmacies for this tier, auto-escalated
    ]);

    // ═══════════════════════════════════════════════════════════════════════
    // 2. ROUTING_JOBS
    // ═══════════════════════════════════════════════════════════════════════
    pgm.createTable('routing_jobs', {
        id: {
            type: 'uuid',
            primaryKey: true,
            default: pgm.func('gen_random_uuid()'),
        },
        request_id: {
            type: 'uuid',
            notNull: true,
            unique: true,
            references: 'requests(id)',
            onDelete: 'CASCADE',
            comment: 'One routing job per request',
        },
        status: {
            type: 'routing_job_status_enum',
            notNull: true,
            default: 'pending',
        },
        current_wave: {
            type: 'smallint',
            notNull: true,
            default: 1,
            check: 'current_wave > 0',
            comment: 'Tracks which wave number is currently active',
        },

        // ── Timestamps ───────────────────────────────────────────────────
        started_at: {
            type: 'timestamptz',
            comment: 'When the job began executing',
        },
        completed_at: {
            type: 'timestamptz',
            comment: 'When the job reached a terminal state',
        },

        // ── Audit ────────────────────────────────────────────────────────
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

    // ── Indexes ──────────────────────────────────────────────────────────
    // request_id is already indexed via UNIQUE constraint
    pgm.createIndex('routing_jobs', 'status');
    pgm.createIndex('routing_jobs', ['status', 'created_at'], {
        name: 'idx_routing_jobs_status_created',
        comment: 'Worker polling: find pending/active jobs ordered by creation',
    });

    // ═══════════════════════════════════════════════════════════════════════
    // 3. ROUTING_WAVES
    // ═══════════════════════════════════════════════════════════════════════
    pgm.createTable('routing_waves', {
        id: {
            type: 'uuid',
            primaryKey: true,
            default: pgm.func('gen_random_uuid()'),
        },
        job_id: {
            type: 'uuid',
            notNull: true,
            references: 'routing_jobs(id)',
            onDelete: 'CASCADE',
        },
        wave_number: {
            type: 'smallint',
            notNull: true,
            check: 'wave_number > 0',
            comment: 'Sequential wave number within the job (1, 2, 3, ...)',
        },
        tier_id: {
            type: 'uuid',
            notNull: true,
            references: 'tiers(id)',
            onDelete: 'RESTRICT',
            comment: 'Which tier this wave targets',
        },
        status: {
            type: 'wave_status_enum',
            notNull: true,
            default: 'pending',
        },

        // ── Execution Metrics ────────────────────────────────────────────
        pharmacies_targeted: {
            type: 'integer',
            notNull: true,
            default: 0,
            check: 'pharmacies_targeted >= 0',
            comment: 'Count of pharmacies notified in this wave',
        },
        offers_received: {
            type: 'integer',
            notNull: true,
            default: 0,
            check: 'offers_received >= 0',
            comment: 'Count of offers received during this wave',
        },
        window_duration_sec: {
            type: 'integer',
            notNull: true,
            check: 'window_duration_sec > 0',
            comment: 'Snapshotted from tier config at wave creation time',
        },

        // ── Timestamps ───────────────────────────────────────────────────
        started_at: {
            type: 'timestamptz',
            comment: 'When the wave window opened',
        },
        expires_at: {
            type: 'timestamptz',
            comment: 'started_at + window_duration_sec',
        },
        completed_at: {
            type: 'timestamptz',
            comment: 'When the wave reached terminal state',
        },

        // ── Audit ────────────────────────────────────────────────────────
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
    pgm.addConstraint('routing_waves', 'uq_routing_waves_job_wave', {
        unique: ['job_id', 'wave_number'],
    });

    // ── Indexes ──────────────────────────────────────────────────────────
    pgm.createIndex('routing_waves', 'job_id');
    pgm.createIndex('routing_waves', 'tier_id');
    pgm.createIndex('routing_waves', 'status');
    pgm.createIndex('routing_waves', ['job_id', 'status'], {
        name: 'idx_routing_waves_job_status',
    });
};

/** @type {import('node-pg-migrate').MigrationBuilder} */
exports.down = (pgm) => {
    pgm.dropTable('routing_waves');
    pgm.dropTable('routing_jobs');
    pgm.dropType('wave_status_enum');
    pgm.dropType('routing_job_status_enum');
};
