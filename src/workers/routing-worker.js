'use strict';

/**
 * Routing Worker — Phase 4A Skeleton
 *
 * Separate Node.js process responsible for claiming pending routing jobs.
 * This skeleton implements:
 *   - Environment and DB initialization (shared config)
 *   - Structured JSON logging
 *   - Poll loop with configurable interval
 *   - Job claiming via SELECT ... FOR UPDATE SKIP LOCKED
 *   - Graceful SIGTERM / SIGINT shutdown
 *
 * NOT implemented yet (Phase 4B+):
 *   - Wave execution
 *   - Tier escalation
 *   - Offer insertion
 *   - Stale job recovery
 *
 * Start: node src/workers/routing-worker.js
 * Spec:  specs/routing-worker/spec.md (v2, approved)
 */

// ─── Bootstrap ───────────────────────────────────────────────────────────────
// Reuse the same env loader as the API server (loads .env.dev / .env.prod)
require('../config/env');
const { pool, query, testConnection } = require('../config/db');

// ─── Configuration ───────────────────────────────────────────────────────────
const WORKER_POLL_INTERVAL_MS = parseInt(process.env.WORKER_POLL_INTERVAL_MS || '3000', 10);
const WORKER_MAX_CONSECUTIVE_ERRORS = parseInt(process.env.WORKER_MAX_CONSECUTIVE_ERRORS || '5', 10);

// ─── State ───────────────────────────────────────────────────────────────────
let isShuttingDown = false;
let consecutiveErrors = 0;
let pollTimer = null;

// ─── Structured Logger ──────────────────────────────────────────────────────
function log(level, event, data = {}) {
    const entry = {
        level,
        component: 'routing-worker',
        event,
        ...data,
        timestamp: new Date().toISOString(),
    };
    if (level === 'error') {
        console.error(JSON.stringify(entry));
    } else if (level === 'warn') {
        console.warn(JSON.stringify(entry));
    } else {
        console.log(JSON.stringify(entry));
    }
}

// ─── Job Claiming ───────────────────────────────────────────────────────────
/**
 * Attempt to claim the next pending routing job using FOR UPDATE SKIP LOCKED.
 * Returns the claimed job row, or null if no jobs are available.
 */
async function claimNextJob() {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        // Claim the oldest pending job, skipping any locked by other workers
        const { rows } = await client.query(`
            SELECT rj.id, rj.request_id, rj.status, rj.current_wave,
                   r.type AS request_type, r.zone_id, r.expires_at
            FROM routing_jobs rj
            JOIN requests r ON r.id = rj.request_id
            WHERE rj.status = 'pending'
            ORDER BY rj.created_at ASC
            LIMIT 1
            FOR UPDATE OF rj SKIP LOCKED
        `);

        if (rows.length === 0) {
            await client.query('COMMIT');
            return null;
        }

        const job = rows[0];

        // Transition: pending → active
        await client.query(`
            UPDATE routing_jobs
            SET status = 'active',
                started_at = now(),
                updated_at = now()
            WHERE id = $1 AND status = 'pending'
        `, [job.id]);

        await client.query('COMMIT');

        log('info', 'job_claimed', {
            job_id: job.id,
            request_id: job.request_id,
            request_type: job.request_type,
            zone_id: job.zone_id,
        });

        return job;
    } catch (err) {
        await client.query('ROLLBACK').catch(() => { });
        throw err;
    } finally {
        client.release();
    }
}

// ─── Job Processing (Stub) ──────────────────────────────────────────────────
/**
 * Process a claimed routing job.
 * Phase 4A: logs the claim and marks the job as completed (placeholder).
 * Phase 4B will implement wave execution and tier escalation here.
 */
async function processJob(job) {
    // TODO (Phase 4B): Implement wave execution + tier escalation
    log('info', 'job_processing_stub', {
        job_id: job.id,
        request_id: job.request_id,
        message: 'Wave execution not yet implemented. Job claimed successfully.',
    });
}

// ─── Poll Loop ──────────────────────────────────────────────────────────────
async function poll() {
    if (isShuttingDown) return;

    try {
        const job = await claimNextJob();

        if (job) {
            consecutiveErrors = 0;
            await processJob(job);
        }

        consecutiveErrors = 0;
    } catch (err) {
        consecutiveErrors++;
        log('error', 'poll_error', {
            error_message: err.message,
            consecutive_errors: consecutiveErrors,
            stack: err.stack,
        });

        if (consecutiveErrors >= WORKER_MAX_CONSECUTIVE_ERRORS) {
            log('error', 'worker_exiting', {
                reason: 'max_consecutive_errors_reached',
                consecutive_errors: consecutiveErrors,
            });
            await shutdown(1);
            return;
        }
    }

    // Schedule next poll
    if (!isShuttingDown) {
        pollTimer = setTimeout(poll, WORKER_POLL_INTERVAL_MS);
    }
}

// ─── Graceful Shutdown ──────────────────────────────────────────────────────
async function shutdown(exitCode = 0) {
    if (isShuttingDown) return;
    isShuttingDown = true;

    log('info', 'worker_stopped', {
        reason: exitCode === 0 ? 'signal' : 'error',
    });

    if (pollTimer) {
        clearTimeout(pollTimer);
        pollTimer = null;
    }

    if (pool) {
        try {
            await pool.end();
        } catch (err) {
            // Swallow pool close errors during shutdown
        }
    }

    process.exit(exitCode);
}

process.on('SIGTERM', () => shutdown(0));
process.on('SIGINT', () => shutdown(0));

// ─── Startup ────────────────────────────────────────────────────────────────
async function start() {
    log('info', 'worker_started', {
        poll_interval_ms: WORKER_POLL_INTERVAL_MS,
        max_consecutive_errors: WORKER_MAX_CONSECUTIVE_ERRORS,
        node_env: process.env.NODE_ENV || 'development',
    });

    // Verify DB connectivity before entering poll loop
    const dbStatus = await testConnection();
    if (!dbStatus.connected) {
        log('error', 'worker_exiting', {
            reason: 'database_unreachable',
            error: dbStatus.error,
        });
        process.exit(1);
    }

    log('info', 'db_connected', {});

    // Enter poll loop
    poll();
}

start();
