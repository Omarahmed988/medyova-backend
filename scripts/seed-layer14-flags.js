'use strict';
const { pool, query } = require('../src/config/db');
require('dotenv').config({ path: '../.env.dev' });

async function seed() {
    console.log('Seeding Phase 14 Feature Flags...');

    try {
        const res = await query(`
            INSERT INTO feature_flags (key, scope, scope_id, is_enabled, description) VALUES
            (
                'medicine_search_enabled',
                'global',
                NULL,
                true,
                'Controls Flow B (Medicine Search and Direct Orders). Disabling throws 503 on checkout.'
            )
            ON CONFLICT (key, scope, COALESCE(scope_id, '00000000-0000-0000-0000-000000000000'::uuid)) DO NOTHING;
        `);
        console.log(`✅ Feature flags inserted: ${res.rowCount}`);

        console.log('\nSeed complete!');
    } catch (err) {
        console.error('Seed failed:', err);
    } finally {
        await pool.end();
    }
}

seed();
