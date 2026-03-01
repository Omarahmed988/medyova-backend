'use strict';
const { pool, query } = require('../src/config/db');
require('dotenv').config({ path: '../.env.dev' });

async function seed() {
    console.log('Seeding Layer 1 core structural entities...');

    try {
        // 1. Insert initial zones
        const zoneRes = await query(`
      INSERT INTO zones (name, city)
      VALUES 
        ('6 October', 'Giza')
      ON CONFLICT (name, city) DO NOTHING
      RETURNING id, name;
    `);
        console.log(`✅ Zones inserted: ${zoneRes.rowCount}`);

        // 2. Insert initial tiers
        const tierRes = await query(`
      INSERT INTO tiers (name, rank, description)
      VALUES 
        ('Gold', 1, 'Highest priority routing'),
        ('Silver', 2, 'Medium priority routing'),
        ('Bronze', 3, 'Base priority routing')
      ON CONFLICT (name) DO NOTHING
      RETURNING id, name;
    `);
        console.log(`✅ Tiers inserted: ${tierRes.rowCount}`);

        console.log('\nSeed complete!');
    } catch (err) {
        console.error('Seed failed:', err);
    } finally {
        await pool.end();
    }
}

seed();
