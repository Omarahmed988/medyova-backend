'use strict';

/**
 * Routing Worker — Phase 4B: Wave Execution
 *
 * Separate Node.js process responsible for routing prescription requests.
 * Implements:
 *   - Environment and DB initialization (shared config)
 *   - Structured JSON logging
 *   - Poll loop with configurable interval
 *   - Job claiming via SELECT ... FOR UPDATE SKIP LOCKED
 *   - Wave 1 creation (query tiers, snapshot window_duration_sec)
 *   - Wave wait loop (heartbeat + expiry checks)
 *   - Wave completion
 *   - Graceful SIGTERM / SIGINT shutdown
 *
 * NOT implemented yet (Phase 4C+):
 *   - Tier escalation (multi-wave)
 *   - Full coverage check
 *   - Request state update
 *   - Stale job recovery
 *
 * Start: node src/workers/routing-worker.js
 * Spec:  specs/routing-worker/spec.md (v4, approved)
 */

// ─── Bootstrap ───────────────────────────────────────────────────────────────
require('../config/env');
const { pool, query, testConnection } = require('../config/db');

// ─── Configuration ───────────────────────────────────────────────────────────
const WORKER_POLL_INTERVAL_MS = parseInt(process.env.WORKER_POLL_INTERVAL_MS || '3000', 10);
const WORKER_HEARTBEAT_INTERVAL_MS = parseInt(process.env.WORKER_HEARTBEAT_INTERVAL_MS || '500', 10);
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

// ─── Utility: sleep ─────────────────────────────────────────────────────────
function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
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

// ─── Tier Loading ───────────────────────────────────────────────────────────
/**
 * Load active tiers ordered by rank ASC.
 * Returns array of { id, name, rank, window_duration_sec }.
 */
async function loadActiveTiers() {
    const { rows } = await query(`
        SELECT id, name, rank, window_duration_sec
        FROM tiers
        WHERE is_active = true
        ORDER BY rank ASC
    `);
    return rows;
}

// ─── Wave Execution ─────────────────────────────────────────────────────────
/**
 * Create a wave for the given job and tier.
 * Uses ON CONFLICT DO NOTHING for idempotency.
 * Returns the wave row, or null if it already existed (conflict).
 */
async function createWave(client, jobId, waveNumber, tier) {
    // Insert wave (idempotent)
    const { rows } = await client.query(`
        INSERT INTO routing_waves (job_id, wave_number, tier_id, status, window_duration_sec)
        VALUES ($1, $2, $3, 'pending', $4)
        ON CONFLICT (job_id, wave_number) DO NOTHING
        RETURNING id, job_id, wave_number, tier_id, status, window_duration_sec
    `, [jobId, waveNumber, tier.id, tier.window_duration_sec]);

    if (rows.length === 0) {
        // Wave already existed (idempotent replay) — load it
        const existing = await client.query(`
            SELECT id, job_id, wave_number, tier_id, status, window_duration_sec
            FROM routing_waves
            WHERE job_id = $1 AND wave_number = $2
        `, [jobId, waveNumber]);
        return existing.rows[0] || null;
    }

    return rows[0];
}

/**
 * Activate a wave: set status to 'active', started_at, and expires_at.
 * Also updates routing_jobs.current_wave.
 */
async function activateWave(client, wave, jobId) {
    await client.query(`
        UPDATE routing_waves
        SET status = 'active',
            started_at = now(),
            expires_at = now() + interval '1 second' * $1,
            updated_at = now()
        WHERE id = $2 AND status = 'pending'
    `, [wave.window_duration_sec, wave.id]);

    await client.query(`
        UPDATE routing_jobs
        SET current_wave = $1, updated_at = now()
        WHERE id = $2
    `, [wave.wave_number, jobId]);
}

/**
 * Query eligible pharmacies for a wave.
 * Standard requests: zone-filtered.
 * Rare requests: cross-zone, supports_rare = true.
 */
async function queryEligiblePharmacies(job, tierId) {
    if (job.request_type === 'rare') {
        const { rows } = await query(`
            SELECT id FROM pharmacies
            WHERE tier_id = $1
              AND is_active = true
              AND supports_rare = true
            ORDER BY trust_score DESC
        `, [tierId]);
        return rows;
    }

    const { rows } = await query(`
        SELECT id FROM pharmacies
        WHERE zone_id = $1
          AND tier_id = $2
          AND is_active = true
        ORDER BY trust_score DESC
    `, [job.zone_id, tierId]);
    return rows;
}

/**
 * Wait for the full wave window duration.
 * During the wait:
 *   - Heartbeat: update routing_jobs.updated_at
 *   - Check: has request.expires_at passed?
 *   - Check: is the worker shutting down?
 * Returns 'completed' (window elapsed) or 'expired' (request expired).
 */
async function waitForWaveWindow(jobId, requestId, windowDurationSec) {
    const windowEndTime = Date.now() + (windowDurationSec * 1000);

    while (Date.now() < windowEndTime) {
        if (isShuttingDown) {
            return 'shutdown';
        }

        // Heartbeat: keep the job fresh so it's not mistaken as stale
        await query(`
            UPDATE routing_jobs SET updated_at = now()
            WHERE id = $1 AND status = 'active'
        `, [jobId]);

        // Check if request has expired
        const { rows } = await query(`
            SELECT expires_at FROM requests WHERE id = $1
        `, [requestId]);

        if (rows.length > 0 && rows[0].expires_at) {
            const expiresAt = new Date(rows[0].expires_at).getTime();
            if (Date.now() >= expiresAt) {
                return 'expired';
            }
        }

        // Sleep for heartbeat interval (but don't overshoot window end)
        const remaining = windowEndTime - Date.now();
        const sleepTime = Math.min(WORKER_HEARTBEAT_INTERVAL_MS, remaining);
        if (sleepTime > 0) {
            await sleep(sleepTime);
        }
    }

    return 'completed';
}

/**
 * Mark a wave as completed. Count offers received (informational snapshot).
 */
async function completeWave(waveId, requestId, waveStartedAt) {
    // Count offers received during this wave (informational only)
    const countResult = await query(`
        SELECT COUNT(*)::int AS cnt FROM offers
        WHERE request_id = $1
          AND created_at >= $2
    `, [requestId, waveStartedAt]);

    const offersReceived = countResult.rows[0]?.cnt || 0;

    await query(`
        UPDATE routing_waves
        SET status = 'completed',
            offers_received = $1,
            completed_at = now(),
            updated_at = now()
        WHERE id = $2 AND status = 'active'
    `, [offersReceived, waveId]);

    return offersReceived;
}

/**
 * Mark a wave and job as expired due to request TTL.
 */
async function expireJob(jobId, waveId) {
    if (waveId) {
        await query(`
            UPDATE routing_waves
            SET status = 'completed',
                completed_at = now(),
                updated_at = now()
            WHERE id = $1 AND status = 'active'
        `, [waveId]);
    }

    await query(`
        UPDATE routing_jobs
        SET status = 'expired',
            completed_at = now(),
            updated_at = now()
        WHERE id = $1 AND status = 'active'
    `, [jobId]);
}

// ─── Job Processing ─────────────────────────────────────────────────────────
/**
 * Process a claimed routing job: execute Wave 1 only (Phase 4B).
 * Phase 4C will add escalation and full coverage checks.
 */
async function processJob(job) {
    // 1. Load active tiers
    const tiers = await loadActiveTiers();

    if (tiers.length === 0) {
        log('warn', 'no_active_tiers', {
            job_id: job.id,
            request_id: job.request_id,
        });
        // Mark job completed with no waves
        await query(`
            UPDATE routing_jobs
            SET status = 'completed', completed_at = now(), updated_at = now()
            WHERE id = $1 AND status = 'active'
        `, [job.id]);
        return;
    }

    // 2. Execute Wave 1 only (Phase 4B — no escalation yet)
    const tier = tiers[0]; // Highest-priority tier (lowest rank)
    const waveNumber = 1;

    // Create wave (ON CONFLICT DO NOTHING)
    const client = await pool.connect();
    let wave;
    try {
        await client.query('BEGIN');
        wave = await createWave(client, job.id, waveNumber, tier);

        if (!wave) {
            await client.query('COMMIT');
            log('error', 'wave_creation_failed', { job_id: job.id, wave_number: waveNumber });
            return;
        }

        // Query eligible pharmacies
        const pharmacies = await queryEligiblePharmacies(job, tier.id);

        if (pharmacies.length === 0) {
            // Skip this wave — no eligible pharmacies
            await client.query(`
                UPDATE routing_waves
                SET status = 'skipped',
                    pharmacies_targeted = 0,
                    completed_at = now(),
                    updated_at = now()
                WHERE id = $1 AND status = 'pending'
            `, [wave.id]);
            await client.query('COMMIT');

            log('info', 'wave_skipped', {
                job_id: job.id,
                wave_number: waveNumber,
                tier_name: tier.name,
                reason: 'no_pharmacies',
            });

            // Phase 4B: mark job completed (no escalation yet)
            await query(`
                UPDATE routing_jobs
                SET status = 'completed', completed_at = now(), updated_at = now()
                WHERE id = $1 AND status = 'active'
            `, [job.id]);
            return;
        }

        // Update pharmacies_targeted and activate the wave
        await client.query(`
            UPDATE routing_waves
            SET pharmacies_targeted = $1
            WHERE id = $2
        `, [pharmacies.length, wave.id]);

        await activateWave(client, wave, job.id);
        await client.query('COMMIT');
    } catch (err) {
        await client.query('ROLLBACK').catch(() => { });
        throw err;
    } finally {
        client.release();
    }

    log('info', 'wave_started', {
        job_id: job.id,
        wave_number: waveNumber,
        tier_name: tier.name,
        pharmacies_targeted: (await query(
            'SELECT pharmacies_targeted FROM routing_waves WHERE id = $1', [wave.id]
        )).rows[0]?.pharmacies_targeted || 0,
        window_sec: tier.window_duration_sec,
    });

    // 3. Wait for the full wave window
    const waitResult = await waitForWaveWindow(
        job.id,
        job.request_id,
        tier.window_duration_sec,
    );

    // 4. Handle wait result
    if (waitResult === 'expired') {
        log('warn', 'job_expired', {
            job_id: job.id,
            request_id: job.request_id,
            waves_completed: 0,
        });
        await expireJob(job.id, wave.id);
        return;
    }

    if (waitResult === 'shutdown') {
        log('info', 'wave_interrupted', {
            job_id: job.id,
            wave_number: waveNumber,
            reason: 'worker_shutdown',
        });
        // Don't complete the wave — let another worker pick it up via stale recovery
        return;
    }

    // 5. Wave window elapsed — mark wave completed
    // Get the wave's started_at for offer counting
    const waveData = (await query(
        'SELECT started_at FROM routing_waves WHERE id = $1', [wave.id]
    )).rows[0];

    const offersReceived = await completeWave(
        wave.id,
        job.request_id,
        waveData?.started_at || new Date(),
    );

    log('info', 'wave_completed', {
        job_id: job.id,
        wave_number: waveNumber,
        tier_name: tier.name,
        offers_received: offersReceived,
        duration_sec: tier.window_duration_sec,
    });

    // 6. Phase 4B: mark job completed after Wave 1 (no escalation logic yet)
    // TODO (Phase 4C): Add full coverage check + tier escalation + request state update
    await query(`
        UPDATE routing_jobs
        SET status = 'completed', completed_at = now(), updated_at = now()
        WHERE id = $1 AND status = 'active'
    `, [job.id]);

    log('info', 'job_completed', {
        job_id: job.id,
        final_status: 'completed',
        total_waves: 1,
        total_offers: offersReceived,
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
        heartbeat_interval_ms: WORKER_HEARTBEAT_INTERVAL_MS,
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
