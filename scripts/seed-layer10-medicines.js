'use strict';
const { pool, query } = require('../src/config/db');
require('dotenv').config({ path: '../.env.dev' });

async function seed() {
    console.log('Seeding Layer 10: Medicine Catalog from Egypt Drug Authority (Subset)...');

    try {
        // 1. Insert core medicines
        const medicinesRes = await query(`
            INSERT INTO medicines (name, generic_name, brand_name, form, strength, is_shortage, max_order_qty)
            VALUES 
                ('Panadol Extra 500mg Tablets', 'Paracetamol / Caffeine', 'Panadol Extra', 'Tablet', '500mg / 65mg', false, 5),
                ('Panadol Advance 500mg', 'Paracetamol', 'Panadol Advance', 'Tablet', '500mg', false, 5),
                ('Panadol Cold & Flu Day', 'Paracetamol / Pseudoephedrine', 'Panadol Cold & Flu Day', 'Tablet', '500mg / 30mg', false, 3),
                ('Augmentin 1g Tablets', 'Amoxicillin / Clavulanate Potassium', 'Augmentin', 'Tablet', '875mg / 125mg', false, 2),
                ('Cataflam 50mg Tablets', 'Diclofenac Potassium', 'Cataflam', 'Tablet', '50mg', false, 5),
                ('Concor 5mg Tablets', 'Bisoprolol Fumarate', 'Concor', 'Tablet', '5mg', false, 3),
                ('Nexium 40mg Tablets', 'Esomeprazole', 'Nexium', 'Tablet', '40mg', false, 4),
                ('Ozempic 1mg Solution for Injection', 'Semaglutide', 'Ozempic', 'Injection', '1mg', true, 1),
                ('Brufen 400mg Tablets', 'Ibuprofen', 'Brufen', 'Tablet', '400mg', false, 5),
                ('Eltroxin 100mcg Tablets', 'Levothyroxine Sodium', 'Eltroxin', 'Tablet', '100mcg', true, 2)
            ON CONFLICT DO NOTHING
            RETURNING id, name;
        `);
        console.log(`✅ Medicines inserted: ${medicinesRes.rowCount}`);

        // We fetch the inserted IDs to create aliases (or fetch them if already seeded)
        const allMedicines = await query(`SELECT id, name FROM medicines;`);
        const medMap = {};
        allMedicines.rows.forEach(m => medMap[m.name] = m.id);

        // Define Aliases
        const aliasesToInsert = [];
        const addAlias = (medName, aliasList) => {
            const medId = medMap[medName];
            if (medId) {
                aliasList.forEach(alias => aliasesToInsert.push(`('${alias}', '${medId}')`));
            }
        };

        addAlias('Panadol Extra 500mg Tablets', ['بنادول اكسترا', 'panadol extra', 'بنادول احمر']);
        addAlias('Panadol Advance 500mg', ['بنادول ادفانس', 'panadol advance', 'بنادول ازرق', 'بنادول الطاير']);
        addAlias('Augmentin 1g Tablets', ['اوجمنتين 1 جرام', 'اوجمنتين', 'augmentin 1g']);
        addAlias('Cataflam 50mg Tablets', ['كاتافلام', 'cataflam 50']);
        addAlias('Concor 5mg Tablets', ['كونكور 5', 'كونكور', 'concor 5']);
        addAlias('Ozempic 1mg Solution for Injection', ['حقنة اوزيمبك', 'اوزيمبك 1', 'ozempic 1']);

        // 2. Insert aliases
        if (aliasesToInsert.length > 0) {
            const aliasQuery = `
                INSERT INTO medicine_aliases (alias, medicine_id)
                VALUES ${aliasesToInsert.join(', ')}
                ON CONFLICT (LOWER(alias)) DO NOTHING;
            `;
            const aliasRes = await query(aliasQuery);
            console.log(`✅ Aliases inserted: ${aliasRes.rowCount}`);
        } else {
            console.log(`⚠️ No aliases inserted (medicines not found).`);
        }

        console.log('\nLayer 10 Seed complete!');
    } catch (err) {
        console.error('Seed failed:', err);
    } finally {
        await pool.end();
    }
}

seed();
