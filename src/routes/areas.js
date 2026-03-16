'use strict';

/**
 * areas.js — Phase 12 Delivery Areas Routes
 *
 * Routes:
 *   GET    /areas                         — List all areas (optionally ?zone_id=)
 *   POST   /areas                         — Create a new area (super-admin)
 *   DELETE /areas/:id                     — Delete a non-legacy area (super-admin)
 *   GET    /pharmacies/:id/areas          — List pharmacy delivery areas
 *   PUT    /pharmacies/:id/areas          — Set pharmacy delivery areas (replace)
 *
 * Constraints:
 *   - Legacy areas are immutable (is_legacy = true)
 *   - DA-5: area must belong to the same zone as the request
 */

const router = require('express').Router();
const {
    listAreas,
    createArea,
    deleteArea,
    getPharmacyDeliveryAreas,
    setPharmacyDeliveryAreas,
} = require('../services/areaService');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ── GET /areas ─────────────────────────────────────────────────────────────

router.get('/areas', async (req, res, next) => {
    try {
        const { zone_id } = req.query;

        if (zone_id && !UUID_RE.test(zone_id)) {
            return res.status(400).json({ error: 'zone_id must be a valid UUID' });
        }

        const areas = await listAreas(zone_id || undefined);
        return res.json({ areas });
    } catch (err) {
        next(err);
    }
});

// ── POST /areas ────────────────────────────────────────────────────────────

router.post('/areas', async (req, res, next) => {
    try {
        if (!req.user || req.user.role !== 'super_admin') {
            return res.status(403).json({ error: 'Forbidden' });
        }

        const { zone_id, name } = req.body;

        if (!zone_id || !UUID_RE.test(zone_id)) {
            return res.status(400).json({ error: 'zone_id must be a valid UUID' });
        }
        if (!name || typeof name !== 'string' || !name.trim()) {
            return res.status(400).json({ error: 'name is required' });
        }

        const area = await createArea(zone_id, name.trim());
        return res.status(201).json({ area });
    } catch (err) {
        if (err.statusCode) {
            return res.status(err.statusCode).json({ error: err.message });
        }
        next(err);
    }
});

// ── DELETE /areas/:id ──────────────────────────────────────────────────────

router.delete('/areas/:id', async (req, res, next) => {
    try {
        if (!req.user || req.user.role !== 'super_admin') {
            return res.status(403).json({ error: 'Forbidden' });
        }

        const { id } = req.params;
        if (!UUID_RE.test(id)) {
            return res.status(400).json({ error: 'id must be a valid UUID' });
        }

        await deleteArea(id);
        return res.json({ status: 'deleted' });
    } catch (err) {
        if (err.statusCode) {
            return res.status(err.statusCode).json({ error: err.message });
        }
        next(err);
    }
});

// ── GET /pharmacies/:id/areas ──────────────────────────────────────────────

router.get('/pharmacies/:id/areas', async (req, res, next) => {
    try {
        const { id } = req.params;
        if (!UUID_RE.test(id)) {
            return res.status(400).json({ error: 'id must be a valid UUID' });
        }
        const areas = await getPharmacyDeliveryAreas(id);
        return res.json({ pharmacy_id: id, areas });
    } catch (err) {
        next(err);
    }
});

// ── PUT /pharmacies/:id/areas ──────────────────────────────────────────────

router.put('/pharmacies/:id/areas', async (req, res, next) => {
    try {
        if (!req.user || req.user.role !== 'super_admin') {
            return res.status(403).json({ error: 'Forbidden' });
        }

        const { id } = req.params;
        if (!UUID_RE.test(id)) {
            return res.status(400).json({ error: 'id must be a valid UUID' });
        }

        const { area_ids } = req.body;
        if (!Array.isArray(area_ids)) {
            return res.status(400).json({ error: 'area_ids must be an array' });
        }
        for (const areaId of area_ids) {
            if (!UUID_RE.test(areaId)) {
                return res.status(400).json({ error: `Invalid area_id: ${areaId}` });
            }
        }

        await setPharmacyDeliveryAreas(id, area_ids);
        return res.json({ status: 'updated', pharmacy_id: id, area_count: area_ids.length });
    } catch (err) {
        if (err.statusCode) {
            return res.status(err.statusCode).json({ error: err.message });
        }
        next(err);
    }
});

module.exports = router;
