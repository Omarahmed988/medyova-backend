'use strict';

/**
 * reviews.js — Phase 13: Order Rating System Routes
 *
 * Routes:
 *   POST /orders/:id/review   — Submit a review for a completed order
 *   GET  /orders/:id/review   — Retrieve a review for an order
 *
 * Validation:
 *   - rating: integer, required, 1–5
 *   - comment: string, optional, max 500 chars
 */

const router = require('express').Router();
const { submitReview, getReview } = require('../services/reviewService');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ── POST /orders/:id/review ────────────────────────────────────────────────

router.post('/:id/review', async (req, res, next) => {
    try {
        // Auth gate
        if (!req.user || !req.user.id) {
            return res.status(401).json({ error: 'Unauthorized' });
        }

        const { id } = req.params;
        if (!UUID_RE.test(id)) {
            return res.status(400).json({ error: 'Order ID must be a valid UUID' });
        }

        const { rating, comment } = req.body;

        // Rating validation: required, integer, 1–5
        if (rating === undefined || rating === null) {
            return res.status(400).json({ error: 'rating is required' });
        }
        if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
            return res.status(400).json({ error: 'rating must be an integer between 1 and 5' });
        }

        // Comment validation: optional, max 500 chars
        if (comment !== undefined && comment !== null) {
            if (typeof comment !== 'string') {
                return res.status(400).json({ error: 'comment must be a string' });
            }
            if (comment.length > 500) {
                return res.status(400).json({ error: 'comment must not exceed 500 characters' });
            }
        }

        const review = await submitReview(req.user.id, id, rating, comment);
        return res.status(201).json(review);
    } catch (err) {
        if (err.statusCode) {
            return res.status(err.statusCode).json({ error: err.message });
        }
        next(err);
    }
});

// ── GET /orders/:id/review ─────────────────────────────────────────────────

router.get('/:id/review', async (req, res, next) => {
    try {
        const { id } = req.params;
        if (!UUID_RE.test(id)) {
            return res.status(400).json({ error: 'Order ID must be a valid UUID' });
        }

        const review = await getReview(id);
        if (!review) {
            return res.status(404).json({ error: 'No review found for this order' });
        }
        return res.json(review);
    } catch (err) {
        next(err);
    }
});

module.exports = router;
