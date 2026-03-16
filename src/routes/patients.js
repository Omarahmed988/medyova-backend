'use strict';

/**
 * src/routes/patients.js
 * Phase 18 — Patient Profiles (Family Accounts) API
 *
 * CRUD endpoints for managing patient profiles under the authenticated user.
 */

const express = require('express');
const router = express.Router();
const { query } = require('../config/db');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ═══════════════════════════════════════════════════════════════════════════
// GET /patients — List patient profiles for the authenticated user
// ═══════════════════════════════════════════════════════════════════════════
router.get('/', async (req, res, next) => {
    try {
        if (!req.user) return res.status(401).json({ error: 'Unauthorized' });

        const result = await query(`
            SELECT pp.*, uip.member_id, ic.name AS insurance_company_name
            FROM patient_profiles pp
            LEFT JOIN user_insurance_profiles uip ON uip.id = pp.insurance_profile_id
            LEFT JOIN insurance_companies ic ON ic.id = uip.insurance_company_id
            WHERE pp.user_id = $1 AND pp.is_active = true
            ORDER BY pp.created_at ASC
        `, [req.user.id]);

        return res.status(200).json({ data: result.rows });
    } catch (err) {
        next(err);
    }
});

// ═══════════════════════════════════════════════════════════════════════════
// POST /patients — Create a new patient profile
// ═══════════════════════════════════════════════════════════════════════════
router.post('/', async (req, res, next) => {
    try {
        if (!req.user) return res.status(401).json({ error: 'Unauthorized' });

        const { name, date_of_birth, phone, national_id, insurance_profile_id } = req.body;

        if (!name || name.trim().length === 0) {
            return res.status(400).json({ error: 'name is required' });
        }

        // Validate insurance_profile_id ownership if provided
        if (insurance_profile_id) {
            if (!UUID_RE.test(insurance_profile_id)) {
                return res.status(400).json({ error: 'insurance_profile_id must be a valid UUID' });
            }
            const ipCheck = await query(
                `SELECT id FROM user_insurance_profiles WHERE id = $1 AND user_id = $2`,
                [insurance_profile_id, req.user.id]
            );
            if (ipCheck.rowCount === 0) {
                return res.status(404).json({ error: 'Insurance profile not found or not owned' });
            }
        }

        const result = await query(`
            INSERT INTO patient_profiles (user_id, name, date_of_birth, phone, national_id, insurance_profile_id)
            VALUES ($1, $2, $3, $4, $5, $6)
            RETURNING *
        `, [req.user.id, name.trim(), date_of_birth || null, phone || null, national_id || null, insurance_profile_id || null]);

        return res.status(201).json({ data: result.rows[0] });
    } catch (err) {
        next(err);
    }
});

// ═══════════════════════════════════════════════════════════════════════════
// PATCH /patients/:id — Update a patient profile
// ═══════════════════════════════════════════════════════════════════════════
router.patch('/:id', async (req, res, next) => {
    try {
        if (!req.user) return res.status(401).json({ error: 'Unauthorized' });
        if (!UUID_RE.test(req.params.id)) return res.status(400).json({ error: 'Invalid profile ID' });

        // Ownership check
        const existing = await query(
            `SELECT id FROM patient_profiles WHERE id = $1 AND user_id = $2 AND is_active = true`,
            [req.params.id, req.user.id]
        );
        if (existing.rowCount === 0) return res.status(404).json({ error: 'Patient profile not found' });

        const updates = [];
        const values = [];
        let idx = 1;

        const allowedFields = ['name', 'date_of_birth', 'phone', 'national_id', 'insurance_profile_id'];
        for (const field of allowedFields) {
            if (req.body[field] !== undefined) {
                // Validate insurance_profile_id ownership
                if (field === 'insurance_profile_id' && req.body[field]) {
                    if (!UUID_RE.test(req.body[field])) {
                        return res.status(400).json({ error: 'insurance_profile_id must be a valid UUID' });
                    }
                    const ipCheck = await query(
                        `SELECT id FROM user_insurance_profiles WHERE id = $1 AND user_id = $2`,
                        [req.body[field], req.user.id]
                    );
                    if (ipCheck.rowCount === 0) {
                        return res.status(404).json({ error: 'Insurance profile not found or not owned' });
                    }
                }
                updates.push(`${field} = $${idx++}`);
                values.push(req.body[field]);
            }
        }

        if (updates.length === 0) {
            return res.status(400).json({ error: 'No valid fields to update' });
        }

        updates.push(`updated_at = NOW()`);
        values.push(req.params.id);

        const result = await query(
            `UPDATE patient_profiles SET ${updates.join(', ')} WHERE id = $${idx} RETURNING *`,
            values
        );

        return res.status(200).json({ data: result.rows[0] });
    } catch (err) {
        next(err);
    }
});

// ═══════════════════════════════════════════════════════════════════════════
// DELETE /patients/:id — Soft delete a patient profile
// ═══════════════════════════════════════════════════════════════════════════
router.delete('/:id', async (req, res, next) => {
    try {
        if (!req.user) return res.status(401).json({ error: 'Unauthorized' });
        if (!UUID_RE.test(req.params.id)) return res.status(400).json({ error: 'Invalid profile ID' });

        // Ownership check
        const existing = await query(
            `SELECT id FROM patient_profiles WHERE id = $1 AND user_id = $2 AND is_active = true`,
            [req.params.id, req.user.id]
        );
        if (existing.rowCount === 0) return res.status(404).json({ error: 'Patient profile not found' });

        // Soft delete
        await query(
            `UPDATE patient_profiles SET is_active = false, updated_at = NOW() WHERE id = $1`,
            [req.params.id]
        );

        return res.status(200).json({ status: 'deleted' });
    } catch (err) {
        next(err);
    }
});

module.exports = router;
