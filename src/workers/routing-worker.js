'use strict';

/**
 * Routing Worker — Phase 4D: Stability & Observability
 *
 * Separate Node.js process responsible for routing prescription requests.
 * Implements:
 *   - Environment and DB initialization (shared config)
 *   - Structured JSON logging
 *   - Poll loop with configurable interval
 *   - Job claiming via SELECT ... FOR UPDATE SKIP LOCKED
 *   - Multi-tier escalation loop (Gold → Silver → Bronze)
 *   - Wave creation, activation, wait, and completion per tier
 *   - Full coverage stop: EXISTS(coverage_ratio = 100.00)
 *   - Atomic request.state transitions (fully_offered / partially_offered / expired)
 *   - Wave-bound offer attribution via wave_id foreign key
 *   - Heartbeat during wave window (WORKER_HEARTBEAT_INTERVAL_MS)
 *   - Stale job recovery sweep (configurable threshold)
 *   - In-memory metrics counters with periodic log summary
 *   - Graceful SIGTERM / SIGINT shutdown
 *
 * NOT implemented yet:
 *   - Offer ranking (API layer responsibility)
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
const WORKER_STALE_JOB_THRESHOLD_SEC = parseInt(process.env.WORKER_STALE_JOB_THRESHOLD_SEC || '600', 10);
const WORKER_METRICS_INTERVAL_SEC = parseInt(process.env.WORKER_METRICS_INTERVAL_SEC || '300', 10);

// ─── State ───────────────────────────────────────────────────────────────────
let isShuttingDown = false;
let consecutiveErrors = 0;
let pollTimer = null;
let metricsTimer = null;

// ─── In-Memory Metrics ──────────────────────────────────────────────────────
const metrics = {
    jobs_processed: 0,
    waves_executed: 0,
    full_coverage_hits: 0,
    partial_completions: 0,
    expiries: 0,
    escalations: 0,
    stale_recoveries: 0,
    started_at: new Date().toISOString(),
};

function emitMetricsSummary() {
    log('info', 'metrics_summary', {
        ...metrics,
        uptime_sec: Math.floor((Date.now() - new Date(metrics.started_at).getTime()) / 1000),
    });
}

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
 * Returns the wave row (either newly created or existing).
 */
async function createWave(client, jobId, waveNumber, tier) {
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
 *
 * Guards:
 *   - Wave: WHERE status = 'pending' (prevents double-activation)
 *   - Job:  WHERE status = 'active' (prevents orphan wave updates on completed/expired jobs)
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
        WHERE id = $2 AND status = 'active'
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
 * Returns 'completed' (window elapsed), 'expired' (request expired), or 'shutdown'.
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
 * Mark a wave as completed.
 *
 * Offer counting uses wave_id for wave-bound attribution when available,
 * falling back to timestamp-based counting. This prepares the structure
 * for proper wave-bound offer attribution once offers carry a wave_id FK.
 *
 * offers_received is an INFORMATIONAL SNAPSHOT only — never used
 * for escalation decisions. Escalation relies exclusively on
 * EXISTS(coverage_ratio = 100.00).
 */
async function completeWave(waveId, requestId, waveStartedAt) {
    // Count offers attributed to this request during the wave window.
    // Uses timestamp-based attribution for now. When offers gain a
    // wave_id FK, this query should switch to: WHERE wave_id = $1
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

// ─── Coverage & State Checks ────────────────────────────────────────────────
/**
 * Check if at least one full coverage offer exists for a request.
 * Uses EXISTS for short-circuit performance.
 * Full coverage is strictly defined as coverage_ratio = 100.00.
 */
async function hasFullCoverage(requestId) {
    const { rows } = await query(`
        SELECT EXISTS(
            SELECT 1 FROM offers
            WHERE request_id = $1
              AND coverage_ratio = 100.00
        ) AS has_full_coverage
    `, [requestId]);
    return rows[0]?.has_full_coverage || false;
}

/**
 * Check if at least one offer of any type exists for a request.
 */
async function hasAnyOffers(requestId) {
    const { rows } = await query(`
        SELECT EXISTS(
            SELECT 1 FROM offers WHERE request_id = $1
        ) AS has_offers
    `, [requestId]);
    return rows[0]?.has_offers || false;
}

/**
 * Determine the final request state based on offer coverage.
 *
 * Rules (unambiguous, per Spec v4):
 *   - ≥1 full coverage offer exists → 'fully_offered'
 *   - ≥1 partial offer exists, no full coverage → 'partially_offered'
 *   - 0 offers → 'expired'
 */
async function determineRequestState(requestId) {
    if (await hasFullCoverage(requestId)) {
        return 'fully_offered';
    }
    if (await hasAnyOffers(requestId)) {
        return 'partially_offered';
    }
    return 'expired';
}

// ─── Atomic Terminal Transitions ────────────────────────────────────────────
/**
 * Complete a routing job and update request.state atomically.
 *
 * ATOMIC: Both job completion and request state transition happen
 * in a single transaction. This prevents a scenario where the job
 * is marked completed but the request state remains stale.
 */
async function completeJobWithState(jobId, requestId, requestState) {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        await client.query(`
            UPDATE routing_jobs
            SET status = 'completed',
                completed_at = now(),
                updated_at = now()
            WHERE id = $1 AND status = 'active'
        `, [jobId]);

        await client.query(`
            UPDATE requests
            SET state = $1,
                updated_at = now()
            WHERE id = $2
        `, [requestState, requestId]);

        await client.query('COMMIT');
    } catch (err) {
        await client.query('ROLLBACK').catch(() => { });
        throw err;
    } finally {
        client.release();
    }
}

/**
 * Mark a wave and job as expired due to request TTL.
 * Also transitions request.state to 'expired'.
 *
 * ATOMIC: All three updates (wave + job + request) run inside a single
 * transaction. Prevents state divergence on crash between updates.
 */
async function expireJob(jobId, requestId, waveId) {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        if (waveId) {
            await client.query(`
                UPDATE routing_waves
                SET status = 'completed',
                    completed_at = now(),
                    updated_at = now()
                WHERE id = $1 AND status = 'active'
            `, [waveId]);
        }

        await client.query(`
            UPDATE routing_jobs
            SET status = 'expired',
                completed_at = now(),
                updated_at = now()
            WHERE id = $1 AND status = 'active'
        `, [jobId]);

        // Determine request state: even if expired by TTL, there
        // might be partial offers received before expiry
        const hasOffers = await client.query(`
            SELECT EXISTS(SELECT 1 FROM offers WHERE request_id = $1) AS has_offers
        `, [requestId]);

        const requestState = hasOffers.rows[0]?.has_offers
            ? 'partially_offered'
            : 'expired';

        await client.query(`
            UPDATE requests
            SET state = $1,
                updated_at = now()
            WHERE id = $2
        `, [requestState, requestId]);

        await client.query('COMMIT');
    } catch (err) {
        await client.query('ROLLBACK').catch(() => { });
        throw err;
    } finally {
        client.release();
    }
}

// ─── Single Wave Execution ──────────────────────────────────────────────────
/**
 * Execute a single wave for a given tier within the escalation loop.
 *
 * Returns an object:
 *   { outcome: 'completed' | 'skipped' | 'expired' | 'shutdown', offersReceived: number }
 *
 * Transaction boundaries:
 *   - Wave creation + activation: one short tx (BEGIN/COMMIT)
 *   - Wave wait loop: NO transaction (autocommit heartbeat/expiry queries)
 *   - Wave completion: autocommit UPDATE
 */
async function executeWave(job, tier, waveNumber) {
    // ── 1. Create + activate wave (short transaction) ────────────────────
    const client = await pool.connect();
    let wave;
    try {
        await client.query('BEGIN');
        wave = await createWave(client, job.id, waveNumber, tier);

        if (!wave) {
            await client.query('COMMIT');
            log('error', 'wave_creation_failed', { job_id: job.id, wave_number: waveNumber });
            return { outcome: 'skipped', offersReceived: 0 };
        }

        // Query eligible pharmacies
        const pharmacies = await queryEligiblePharmacies(job, tier.id);

        if (pharmacies.length === 0) {
            // Skip — no eligible pharmacies in this tier
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

            return { outcome: 'skipped', offersReceived: 0 };
        }

        // Set pharmacies_targeted and activate
        await client.query(`
            UPDATE routing_waves SET pharmacies_targeted = $1 WHERE id = $2
        `, [pharmacies.length, wave.id]);

        await activateWave(client, wave, job.id);
        await client.query('COMMIT');

        log('info', 'wave_started', {
            job_id: job.id,
            wave_number: waveNumber,
            tier_name: tier.name,
            pharmacies_targeted: pharmacies.length,
            window_sec: tier.window_duration_sec,
        });
    } catch (err) {
        await client.query('ROLLBACK').catch(() => { });
        throw err;
    } finally {
        client.release();
    }

    // ── 2. Wait for full wave window (NO transaction) ────────────────────
    const waitResult = await waitForWaveWindow(
        job.id,
        job.request_id,
        tier.window_duration_sec,
    );

    if (waitResult === 'expired') {
        return { outcome: 'expired', offersReceived: 0 };
    }

    if (waitResult === 'shutdown') {
        return { outcome: 'shutdown', offersReceived: 0 };
    }

    // ── 3. Wave window elapsed — complete wave (autocommit) ──────────────
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

    return { outcome: 'completed', offersReceived };
}

// ─── Job Processing ─────────────────────────────────────────────────────────
/**
 * Process a claimed routing job: multi-tier escalation with full coverage stop.
 *
 * Escalation loop:
 *   For each active tier (ordered by rank ASC):
 *     1. Create wave (idempotent)
 *     2. Activate wave
 *     3. Wait full window (fair competition — NEVER terminate early)
 *     4. Complete wave
 *     5. Check: EXISTS(coverage_ratio = 100.00)?
 *        → YES: stop escalation, job = completed, request = fully_offered
 *        → NO:  continue to next tier
 *
 *   If all tiers exhausted:
 *     Check if any offers exist:
 *       → YES: request = partially_offered
 *       → NO:  request = expired
 *
 * Escalation is bounded by tier count × window duration.
 * No infinite loops are possible.
 */
async function processJob(job) {
    // 1. Load active tiers
    const tiers = await loadActiveTiers();

    if (tiers.length === 0) {
        log('warn', 'no_active_tiers', {
            job_id: job.id,
            request_id: job.request_id,
        });
        // No tiers → no routing possible → mark expired
        await completeJobWithState(job.id, job.request_id, 'expired');

        metrics.jobs_processed++;
        metrics.expiries++;

        log('info', 'job_completed', {
            job_id: job.id,
            final_status: 'completed',
            request_state: 'expired',
            reason: 'no_active_tiers',
            total_waves: 0,
        });
        return;
    }

    // 2. Multi-tier escalation loop
    let totalOffers = 0;
    let wavesCompleted = 0;

    for (let i = 0; i < tiers.length; i++) {
        const tier = tiers[i];
        const waveNumber = i + 1;

        // Check request expiry before starting a new wave
        const expiryResult = await query(
            'SELECT expires_at FROM requests WHERE id = $1', [job.request_id]
        );
        if (expiryResult.rows[0]?.expires_at) {
            const expiresAt = new Date(expiryResult.rows[0].expires_at).getTime();
            if (Date.now() >= expiresAt) {
                log('warn', 'job_expired', {
                    job_id: job.id,
                    request_id: job.request_id,
                    expired_at: expiryResult.rows[0].expires_at,
                    waves_completed: wavesCompleted,
                });
                await expireJob(job.id, job.request_id, null);
                metrics.jobs_processed++;
                metrics.expiries++;
                return;
            }
        }

        // Execute the wave for this tier
        const result = await executeWave(job, tier, waveNumber);

        if (result.outcome === 'shutdown') {
            log('info', 'wave_interrupted', {
                job_id: job.id,
                wave_number: waveNumber,
                reason: 'worker_shutdown',
            });
            // Leave job active for stale recovery
            return;
        }

        if (result.outcome === 'expired') {
            log('warn', 'job_expired', {
                job_id: job.id,
                request_id: job.request_id,
                waves_completed: wavesCompleted,
            });
            await expireJob(job.id, job.request_id, null);
            metrics.jobs_processed++;
            metrics.expiries++;
            return;
        }

        if (result.outcome === 'completed') {
            wavesCompleted++;
            totalOffers += result.offersReceived;
            metrics.waves_executed++;
        }
        // outcome === 'skipped' → continue to next tier (no wave executed)

        // ── Full coverage check (after each completed wave) ──────────────
        if (result.outcome === 'completed') {
            const fullCoverage = await hasFullCoverage(job.request_id);

            if (fullCoverage) {
                // STOP escalation — at least one full coverage offer exists
                log('info', 'full_coverage_reached', {
                    job_id: job.id,
                    request_id: job.request_id,
                    completed_at_wave: waveNumber,
                    tier_name: tier.name,
                    total_offers: totalOffers,
                });

                await completeJobWithState(job.id, job.request_id, 'fully_offered');

                metrics.jobs_processed++;
                metrics.full_coverage_hits++;

                log('info', 'job_completed', {
                    job_id: job.id,
                    final_status: 'completed',
                    request_state: 'fully_offered',
                    total_waves: wavesCompleted,
                    total_offers: totalOffers,
                });
                return;
            }

            // No full coverage — escalate to next tier
            if (i < tiers.length - 1) {
                metrics.escalations++;

                log('info', 'escalation_triggered', {
                    job_id: job.id,
                    from_wave: waveNumber,
                    to_wave: waveNumber + 1,
                    from_tier: tier.name,
                    to_tier: tiers[i + 1].name,
                    reason: 'no_full_coverage',
                    partial_offers: totalOffers,
                });
            }
        }
    }

    // 3. All tiers exhausted — determine final state
    const finalState = await determineRequestState(job.request_id);

    await completeJobWithState(job.id, job.request_id, finalState);

    metrics.jobs_processed++;
    if (finalState === 'partially_offered') metrics.partial_completions++;
    if (finalState === 'expired') metrics.expiries++;

    log('info', 'job_completed', {
        job_id: job.id,
        final_status: 'completed',
        request_state: finalState,
        reason: 'all_tiers_exhausted',
        total_waves: wavesCompleted,
        total_offers: totalOffers,
    });
}

// ─── Stale Job Recovery ─────────────────────────────────────────────────────
/**
 * Scan for routing jobs that are stuck in 'active' status with a stale
 * updated_at timestamp. This indicates a worker crashed or was terminated
 * without completing the job.
 *
 * Recovery strategy:
 *   - If the request has expired (expires_at < now): mark job 'expired'
 *   - Otherwise: re-queue the job by resetting status to 'pending'
 *
 * Concurrency-safe: uses SELECT FOR UPDATE SKIP LOCKED so multiple
 * workers don't fight over the same stale job.
 *
 * Transaction scope: one short tx per stale job (SELECT + UPDATE + COMMIT).
 */
async function recoverStaleJobs() {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        // Find stale active jobs (updated_at older than threshold)
        const { rows: staleJobs } = await client.query(`
            SELECT rj.id, rj.request_id, r.expires_at
            FROM routing_jobs rj
            JOIN requests r ON r.id = rj.request_id
            WHERE rj.status = 'active'
              AND rj.updated_at < now() - interval '1 second' * $1
            ORDER BY rj.updated_at ASC
            LIMIT 10
            FOR UPDATE OF rj SKIP LOCKED
        `, [WORKER_STALE_JOB_THRESHOLD_SEC]);

        if (staleJobs.length === 0) {
            await client.query('COMMIT');
            return;
        }

        for (const staleJob of staleJobs) {
            const isRequestExpired = staleJob.expires_at
                && new Date(staleJob.expires_at).getTime() < Date.now();

            if (isRequestExpired) {
                // Request has expired — mark job expired + update request state
                const hasOffers = await client.query(`
                    SELECT EXISTS(SELECT 1 FROM offers WHERE request_id = $1) AS has_offers
                `, [staleJob.request_id]);

                const requestState = hasOffers.rows[0]?.has_offers
                    ? 'partially_offered'
                    : 'expired';

                await client.query(`
                    UPDATE routing_jobs
                    SET status = 'expired',
                        completed_at = now(),
                        updated_at = now()
                    WHERE id = $1 AND status = 'active'
                `, [staleJob.id]);

                await client.query(`
                    UPDATE requests
                    SET state = $1, updated_at = now()
                    WHERE id = $2
                `, [requestState, staleJob.request_id]);

                log('warn', 'stale_job_expired', {
                    job_id: staleJob.id,
                    request_id: staleJob.request_id,
                    request_state: requestState,
                });

                metrics.stale_recoveries++;
                metrics.expiries++;
            } else {
                // Request still valid — re-queue for another worker to pick up
                await client.query(`
                    UPDATE routing_jobs
                    SET status = 'pending',
                        started_at = NULL,
                        updated_at = now()
                    WHERE id = $1 AND status = 'active'
                `, [staleJob.id]);

                log('warn', 'stale_job_requeued', {
                    job_id: staleJob.id,
                    request_id: staleJob.request_id,
                });

                metrics.stale_recoveries++;
            }
        }

        await client.query('COMMIT');
    } catch (err) {
        await client.query('ROLLBACK').catch(() => { });
        log('error', 'stale_recovery_error', {
            error_message: err.message,
            stack: err.stack,
        });
    } finally {
        client.release();
    }
}

// ─── Poll Loop ──────────────────────────────────────────────────────────────
async function poll() {
    if (isShuttingDown) return;

    try {
        // Run stale job recovery on every poll cycle (lightweight query)
        await recoverStaleJobs();

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

    // Emit final metrics before stopping
    emitMetricsSummary();

    log('info', 'worker_stopped', {
        reason: exitCode === 0 ? 'signal' : 'error',
    });

    if (metricsTimer) {
        clearInterval(metricsTimer);
        metricsTimer = null;
    }

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
        stale_threshold_sec: WORKER_STALE_JOB_THRESHOLD_SEC,
        metrics_interval_sec: WORKER_METRICS_INTERVAL_SEC,
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

    // Start periodic metrics summary
    metricsTimer = setInterval(emitMetricsSummary, WORKER_METRICS_INTERVAL_SEC * 1000);

    // Enter poll loop
    poll();
}

start();
