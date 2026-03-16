'use strict';
/**
 * src/workers/catalog-duplicate-scanner.js
 * PM2 Nightly worker that scans the medicine catalog for highly similar
 * entries and produces an action report for Founders.
 */

const { pool, query } = require('../config/db');

// In production, this might be triggered by node-cron.
// For PM2 ecosystem scaling, running it via a setInterval or an overarching task scheduler works.
const RUN_INTERVAL_MS = process.env.DUPLICATE_SCANNER_INTERVAL_MS
    || 24 * 60 * 60 * 1000; // 24 hours default

async function scanCatalog() {
    console.log(`[DUPLICATE SCANNER] Starting trigram similarity scan...`);

    try {
        // Optimized O(n) similarity pairing using cross id restriction
        const result = await query(`
            SELECT 
                m1.id AS medicine_a_id, 
                m2.id AS medicine_b_id, 
                similarity(m1.name, m2.name) AS similarity_score
            FROM medicines m1
            JOIN medicines m2 ON m1.id < m2.id
            WHERE m1.is_active = true 
              AND m2.is_active = true
              AND similarity(m1.name, m2.name) > 0.85
        `);

        if (result.rowCount === 0) {
            console.log(`[DUPLICATE SCANNER] No duplicates detected. Zero items crossed the 0.85 threshold.`);
            return;
        }

        console.log(`[DUPLICATE SCANNER] Found ${result.rowCount} potential duplicate pairs. Inserting into report...`);

        let inserted = 0;
        for (const pair of result.rows) {
            const res = await query(`
                INSERT INTO catalog_duplicates_report (medicine_a_id, medicine_b_id, similarity_score, created_at)
                VALUES ($1, $2, $3, NOW())
                ON CONFLICT ON CONSTRAINT catalog_duplicates_unique_pair DO NOTHING
                RETURNING id
            `, [pair.medicine_a_id, pair.medicine_b_id, pair.similarity_score]);

            if (res.rowCount > 0) inserted++;
        }

        console.log(`[DUPLICATE SCANNER] Scan complete. ${inserted} new unresolved duplicate pairs logged.`);

    } catch (err) {
        console.error(`[DUPLICATE SCANNER] Error during scan:`, err);
    }
}

// Start sequence
async function startWorker() {
    console.log('[DUPLICATE SCANNER] Worker process mounted.');

    // Initial run immediately when mounted (helpful for admin debugging)
    await scanCatalog();

    setInterval(async () => {
        await scanCatalog();
    }, RUN_INTERVAL_MS);
}

// Ensure cleanup on termination
process.on('SIGTERM', () => {
    console.log('[DUPLICATE SCANNER] SIGTERM received. Closing pool...');
    pool.end().then(() => {
        console.log('[DUPLICATE SCANNER] Exited cleanly.');
        process.exit(0);
    });
});

// Avoid running if merely imported in a test
if (require.main === module) {
    startWorker().catch(err => {
        console.error('[DUPLICATE SCANNER] Fatal execution error:', err);
    });
}

module.exports = { scanCatalog };
