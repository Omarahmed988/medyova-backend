'use strict';

/**
 * src/routes/userInsuranceProfiles.js
 * Phase 18 — User Insurance Profiles API
 *
 * CRUD for managing insurance profiles under the authenticated user.
 */

const express = require('express');
const router = express.Router();
const { query } = require('../config/db');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ═══════════════════════════════════════════════════════════════════════════
// GET /user/insurance-profiles — List user's insurance profiles
// ═══════════════════════════════════════════════════════════════════════════
router.get('/insurance-profiles', async (req, res, next) => {
    try {
        if (!req.user) return res.status(401).json({ error: 'Unauthorized' });

        const result = await query(`
            SELECT uip.*, ic.name AS insurance_company_name
            FROM user_insurance_profiles uip
            JOIN insurance_companies ic ON ic.id = uip.insurance_company_id
            WHERE uip.user_id = $1 AND uip.is_active = true
            ORDER BY uip.created_at ASC
        `, [req.user.id]);

        return res.status(200).json({ data: result.rows });
    } catch (err) {
        next(err);
    }
});

// ═══════════════════════════════════════════════════════════════════════════
// POST /user/insurance-profiles — Create a new insurance profile
// ═══════════════════════════════════════════════════════════════════════════
router.post('/insurance-profiles', async (req, res, next) => {
    try {
        if (!req.user) return res.status(401).json({ error: 'Unauthorized' });

        const { insurance_company_id, member_id, card_document_url, id_document_url } = req.body;

        if (!insurance_company_id || !UUID_RE.test(insurance_company_id)) {
            return res.status(400).json({ error: 'insurance_company_id must be a valid UUID' });
        }
        if (!member_id || member_id.trim().length === 0) {
            return res.status(400).json({ error: 'member_id is required' });
        }

        // Verify insurance company exists
        const icCheck = await query(`SELECT id FROM insurance_companies WHERE id = $1`, [insurance_company_id]);
        if (icCheck.rowCount === 0) {
            return res.status(404).json({ error: 'Insurance company not found' });
        }

        const result = await query(`
            INSERT INTO user_insurance_profiles (user_id, insurance_company_id, member_id, card_document_url, id_document_url)
            VALUES ($1, $2, $3, $4, $5)
            RETURNING *
        `, [req.user.id, insurance_company_id, member_id.trim(), card_document_url || null, id_document_url || null]);

        return res.status(201).json({ data: result.rows[0] });
    } catch (err) {
        // Unique constraint violation
        if (err.code === '23505') {
            return res.status(409).json({ error: 'Insurance profile already exists for this company' });
        }
        next(err);
    }
});

// ═══════════════════════════════════════════════════════════════════════════
// PATCH /user/insurance-profiles/:id — Update insurance profile
// ═══════════════════════════════════════════════════════════════════════════
router.patch('/insurance-profiles/:id', async (req, res, next) => {
    try {
        if (!req.user) return res.status(401).json({ error: 'Unauthorized' });
        if (!UUID_RE.test(req.params.id)) return res.status(400).json({ error: 'Invalid profile ID' });

        // Ownership check
        const existing = await query(
            `SELECT id FROM user_insurance_profiles WHERE id = $1 AND user_id = $2 AND is_active = true`,
            [req.params.id, req.user.id]
        );
        if (existing.rowCount === 0) return res.status(404).json({ error: 'Insurance profile not found' });

        const updates = [];
        const values = [];
        let idx = 1;

        const allowedFields = ['member_id', 'card_document_url', 'id_document_url'];
        for (const field of allowedFields) {
            if (req.body[field] !== undefined) {
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
            `UPDATE user_insurance_profiles SET ${updates.join(', ')} WHERE id = $${idx} RETURNING *`,
            values
        );

        return res.status(200).json({ data: result.rows[0] });
    } catch (err) {
        next(err);
    }
});

// ═══════════════════════════════════════════════════════════════════════════
// DELETE /user/insurance-profiles/:id — Remove insurance profile
// ═══════════════════════════════════════════════════════════════════════════
router.delete('/insurance-profiles/:id', async (req, res, next) => {
    try {
        if (!req.user) return res.status(401).json({ error: 'Unauthorized' });
        if (!UUID_RE.test(req.params.id)) return res.status(400).json({ error: 'Invalid profile ID' });

        // Ownership check
        const existing = await query(
            `SELECT id FROM user_insurance_profiles WHERE id = $1 AND user_id = $2 AND is_active = true`,
            [req.params.id, req.user.id]
        );
        if (existing.rowCount === 0) return res.status(404).json({ error: 'Insurance profile not found' });

        // Soft delete
        await query(`UPDATE user_insurance_profiles SET is_active = false, updated_at = NOW() WHERE id = $1`, [req.params.id]);

        return res.status(200).json({ status: 'deleted' });
    } catch (err) {
        next(err);
    }
});

module.exports = router;
