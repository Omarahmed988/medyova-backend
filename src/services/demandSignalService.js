'use strict';

/**
 * DemandSignalService
 *
 * Captures unfulfilled medicine demand events from four source flows:
 *   - search_miss         (medicines route)
 *   - order_failure       (directOrders route)
 *   - routing_failure     (routing-worker)
 *   - subscription_failure (subscription-scheduler)
 *
 * All emissions are fire-and-forget via setImmediate.
 * Deduplication is handled by a process-local LRU cache (1-hour TTL, 10k entries).
 * The database table is append-only — no reads are performed during emission.
 */

const { query } = require('../config/db');

// ─── Minimal LRU Cache with TTL ──────────────────────────────────────────────
// Avoids adding an npm dependency by implementing a Map-based LRU with TTL.
// For multi-instance deployments, consider replacing with a Redis TTL key.

class LRUCache {
    /**
     * @param {number} maxSize   Maximum number of entries
     * @param {number} ttlMs     Time-to-live in milliseconds
     */
    constructor(maxSize, ttlMs) {
        this._maxSize = maxSize;
        this._ttlMs   = ttlMs;
        this._map     = new Map(); // key → { expiresAt }
    }

    has(key) {
        const entry = this._map.get(key);
        if (!entry) return false;
        if (Date.now() > entry.expiresAt) {
            this._map.delete(key);
            return false;
        }
        return true;
    }

    set(key) {
        // Evict oldest entry if at capacity
        if (this._map.size >= this._maxSize) {
            const firstKey = this._map.keys().next().value;
            this._map.delete(firstKey);
        }
        this._map.set(key, { expiresAt: Date.now() + this._ttlMs });
    }
}

const DEDUP_CACHE = new LRUCache(10_000, 60 * 60 * 1000); // 10k entries, 1 hour TTL

// ─── Service ─────────────────────────────────────────────────────────────────

class DemandSignalService {

    /**
     * Emit a demand signal. This method is always fire-and-forget.
     * Call sites must never await this; it must never block the response path.
     *
     * @param {string}      signalType  'search_miss' | 'order_failure' | 'routing_failure' | 'subscription_failure'
     * @param {string}      sourceFlow  Human-readable origin flow identifier
     * @param {string}      medicineId  UUID of the requested medicine
     * @param {string}      areaId      UUID of the patient's delivery area
     * @param {string|null} userId      UUID of the user (null for anonymous)
     * @param {object}      metadata    Optional additional context
     */
    static emit(signalType, sourceFlow, medicineId, areaId, userId = null, metadata = {}) {
        // Build dedup cache key
        const key = `${signalType}:${medicineId}:${areaId}:${userId ?? 'anon'}`;

        // Drop if already emitted within the TTL window
        if (DEDUP_CACHE.has(key)) return;
        DEDUP_CACHE.set(key);

        // Fire-and-forget — never awaited at the call site
        setImmediate(() => {
            DemandSignalService._insert(signalType, sourceFlow, medicineId, areaId, userId, metadata)
                .catch(err => console.warn(
                    `[DemandSignalService] Signal drop (${signalType}):`, err.message
                ));
        });
    }

    /**
     * Internal DB insert. Never called directly from outside this module.
     */
    static async _insert(signalType, sourceFlow, medicineId, areaId, userId, metadata) {
        await query(
            `INSERT INTO medicine_demand_signals
                (signal_type, source_flow, medicine_id, area_id, user_id, metadata)
             VALUES ($1, $2, $3, $4, $5, $6)`,
            [signalType, sourceFlow, medicineId, areaId, userId, JSON.stringify(metadata)]
        );
    }

    /**
     * Purge the in-memory dedup cache.
     * Primarily used in tests to isolate test cases.
     */
    static _clearCache() {
        DEDUP_CACHE._map.clear();
    }
}

module.exports = DemandSignalService;
