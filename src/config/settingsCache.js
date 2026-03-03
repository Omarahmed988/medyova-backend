'use strict';

/**
 * settingsCache.js â€” Phase 11 Founder Control Layer
 *
 * In-process singleton cache for system_settings and feature_flags.
 *
 * Design constraints:
 *  - LISTEN/NOTIFY uses ONE dedicated pg.Client â€” NOT the pool.
 *    A pg.Pool client cannot hold a LISTEN session because the pool
 *    recycles connections freely.
 *  - Auto-reconnect on connection drop â€” the LISTEN client is re-created
 *    with exponential backoff after an error or unexpected close.
 *  - No blocking listeners â€” all handlers are async with try/catch.
 *  - No memory leak on restart â€” removeAllListeners() is called before
 *    destroying the old client; process signal handlers are registered once.
 *  - TTL background refresh runs every SETTINGS_CACHE_TTL_MS as a safety
 *    net for missed notifications (e.g., network blip). It is NOT the
 *    primary invalidation path.
 *  - Graceful shutdown: call settingsCache.stop() on SIGTERM/SIGINT.
 */

const { Client } = require('pg');
const { DATABASE_URL, NODE_ENV } = require('./env');

// â”€â”€â”€ Tuning constants â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
const SETTINGS_CACHE_TTL_MS = 60_000;   // Background refresh interval
const RECONNECT_BASE_DELAY_MS = 500;       // Initial reconnect wait
const RECONNECT_MAX_DELAY_MS = 30_000;   // Cap for exponential backoff
const RECONNECT_MULTIPLIER = 2;

// â”€â”€â”€ Internal state â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
let _settings = new Map();   // key â†’ { value, type, min_val, max_val, id, is_locked }
let _flags = new Map();   // `${key}:${scope}:${scope_id ?? 'null'}` â†’ is_enabled

/** @type {Client|null} */
let _listenClient = null;
let _ttlTimer = null;
let _reconnectTimer = null;
let _reconnectDelay = RECONNECT_BASE_DELAY_MS;
let _stopped = false;   // Set true on stop() â€” prevents reconnect loop
let _initialized = false;

// â”€â”€â”€ DB connection helper â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

/**
 * Create a fresh pg.Client configured identically to the pool.
 * @returns {Client}
 */
function _createClient() {
    return new Client({
        connectionString: DATABASE_URL,
        connectionTimeoutMillis: 5000,
        ssl: NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
    });
}

// â”€â”€â”€ Load from DB â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

/**
 * Fetch all system_settings and feature_flags from the DB and refresh
 * the in-memory Maps atomically. This function is idempotent and safe
 * to call at any time.
 *
 * Uses the pool (via require) so it does not block the LISTEN client.
 *
 * @returns {Promise<void>}
 */
async function _loadFromDb() {
    // Lazy require to avoid circular dependency at module load time.
    const { query } = require('./db');

    const [settingsResult, flagsResult] = await Promise.all([
        query('SELECT id, key, value, type, min_val, max_val, is_locked FROM system_settings'),
        query('SELECT key, scope, scope_id, is_enabled FROM feature_flags'),
    ]);

    const newSettings = new Map();
    for (const row of settingsResult.rows) {
        newSettings.set(row.key, {
            id: row.id,
            value: row.value,
            type: row.type,
            min_val: row.min_val,
            max_val: row.max_val,
            is_locked: row.is_locked,
        });
    }

    const newFlags = new Map();
    for (const row of flagsResult.rows) {
        const mapKey = `${row.key}:${row.scope}:${row.scope_id ?? 'null'}`;
        newFlags.set(mapKey, row.is_enabled);
    }

    // Atomic swap â€” replace both maps together
    _settings = newSettings;
    _flags = newFlags;
}

// â”€â”€â”€ LISTEN / NOTIFY wiring â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

/**
 * Cleanly destroy the current LISTEN client without leaking listeners.
 */
function _destroyListenClient() {
    if (!_listenClient) return;

    _listenClient.removeAllListeners();   // â† prevents memory leak

    _listenClient.end().catch(() => { });  // best-effort close; ignore errors
    _listenClient = null;
}

/**
 * Schedule a reconnect attempt with exponential backoff.
 * Only triggers if cache is not stopped.
 */
function _scheduleReconnect() {
    if (_stopped || _reconnectTimer) return;

    const delay = _reconnectDelay;
    _reconnectDelay = Math.min(_reconnectDelay * RECONNECT_MULTIPLIER, RECONNECT_MAX_DELAY_MS);

    console.log(`[settingsCache] LISTEN client disconnected. Reconnecting in ${delay}msâ€¦`);

    _reconnectTimer = setTimeout(() => {
        _reconnectTimer = null;
        _connectListenClient();  // eslint-disable-line no-use-before-define
    }, delay);
}

/**
 * Connect the dedicated LISTEN client, wire all event handlers,
 * issue LISTEN config_changed, and reset the reconnect backoff on success.
 */
async function _connectListenClient() {
    if (_stopped) return;

    _destroyListenClient();  // clean up any previous client first

    const client = _createClient();
    _listenClient = client;

    // â”€â”€ Error handler â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    // 'error' MUST be wired before connect() to avoid unhandled rejection.
    client.on('error', (err) => {
        console.error('[settingsCache] LISTEN client error:', err.message);
        _destroyListenClient();
        _scheduleReconnect();
    });

    // â”€â”€ End / unexpected close â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    client.on('end', () => {
        if (_stopped) return;   // intentional shutdown â€” do not reconnect
        console.warn('[settingsCache] LISTEN client connection ended unexpectedly.');
        _destroyListenClient();
        _scheduleReconnect();
    });

    // â”€â”€ Notification handler (non-blocking) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    client.on('notification', (_msg) => {
        // Return the promise so tests can deterministically await refresh.
        // In production, pg ignores the return value of notification listeners.
        return _loadFromDb().then(() => {
            console.log('[settingsCache] Cache refreshed via NOTIFY.');
        }).catch((err) => {
            console.error('[settingsCache] Cache refresh after NOTIFY failed:', err.message);
            // Non-fatal â€” TTL refresh will pick it up within 60s.
        });
    });

    try {
        await client.connect();
        await client.query('LISTEN config_changed');

        // Reset backoff after a successful connection
        _reconnectDelay = RECONNECT_BASE_DELAY_MS;

        console.log('[settingsCache] LISTEN client connected and listening on config_changed.');
    } catch (err) {
        console.error('[settingsCache] Failed to connect LISTEN client:', err.message);
        _destroyListenClient();
        _scheduleReconnect();
    }
}

// â”€â”€â”€ TTL background refresh â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

function _startTtlRefresh() {
    if (_ttlTimer) return;
    _ttlTimer = setInterval(() => {
        _loadFromDb().catch((err) => {
            console.error('[settingsCache] TTL refresh failed:', err.message);
        });
    }, SETTINGS_CACHE_TTL_MS);

    // Do NOT block process exit â€” this is a background task.
    if (_ttlTimer.unref) _ttlTimer.unref();
}

function _stopTtlRefresh() {
    if (_ttlTimer) {
        clearInterval(_ttlTimer);
        _ttlTimer = null;
    }
}

// â”€â”€â”€ Public API â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

/**
 * Initialize the settings cache:
 *  1. Load all values from DB.
 *  2. Start LISTEN client for push invalidation.
 *  3. Start TTL background refresh as safety net.
 *
 * Safe to call multiple times â€” subsequent calls are no-ops.
 *
 * @returns {Promise<void>}
 */
async function init() {
    if (_initialized) return;
    _initialized = true;
    _stopped = false;

    if (!DATABASE_URL) {
        console.warn('[settingsCache] DATABASE_URL not set â€” cache will not load. Using defaults.');
        return;
    }

    await _loadFromDb();
    await _connectListenClient();
    _startTtlRefresh();

    console.log(`[settingsCache] Initialized â€” ${_settings.size} settings, ${_flags.size} flags loaded.`);
}

/**
 * Force an immediate cache refresh from the DB.
 * Called by admin PATCH handlers after a successful write + NOTIFY,
 * so the API process itself is refreshed synchronously without waiting
 * for the NOTIFY round-trip.
 *
 * @returns {Promise<void>}
 */
async function refresh() {
    await _loadFromDb();
}

/**
 * Gracefully shut down the settings cache.
 * - Clears TTL timer (no memory leak).
 * - Removes all listeners from LISTEN client (no memory leak).
 * - Ends LISTEN client connection.
 * - Cancels any pending reconnect timer.
 *
 * Call this on SIGTERM/SIGINT BEFORE process.exit().
 */
function stop() {
    _stopped = true;
    _initialized = false;

    _stopTtlRefresh();

    if (_reconnectTimer) {
        clearTimeout(_reconnectTimer);
        _reconnectTimer = null;
    }

    _destroyListenClient();

    console.log('[settingsCache] Stopped.');
}

/**
 * Get a setting value by key.
 *
 * @param {string} key
 * @returns {string|null} raw TEXT value from DB, or null if not found
 */
function getSetting(key) {
    return _settings.get(key)?.value ?? null;
}

/**
 * Get a setting value parsed as a number.
 * Returns the fallback if key is missing or non-numeric.
 *
 * @param {string} key
 * @param {number} fallback
 * @returns {number}
 */
function getSettingNumber(key, fallback) {
    const raw = getSetting(key);
    if (raw === null) return fallback;
    const parsed = parseFloat(raw);
    return isNaN(parsed) ? fallback : parsed;
}

/**
 * Get a feature flag value.
 *
 * @param {string} key        â€” flag key (e.g. 'insurance_routing_enabled')
 * @param {object} [opts]     â€” scope options
 * @param {string} [opts.scope]     â€” 'global' (default) or 'zone'
 * @param {string} [opts.scope_id] â€” zone UUID if scope is 'zone'
 * @returns {boolean}         â€” defaults to FALSE on cache miss (fail-closed per FC-7)
 */
function isEnabled(key, opts = {}) {
    const scope = opts.scope ?? 'global';
    const scope_id = opts.scope_id ?? null;
    const mapKey = `${key}:${scope}:${scope_id ?? 'null'}`;

    const val = _flags.get(mapKey);

    // FC-7: Any feature not found in cache defaults to fail-closed (false)
    if (val === undefined) {
        console.warn(`[settingsCache] Flag '${mapKey}' not found in cache â€” defaulting to false (fail-closed).`);
        return false;
    }

    return val;
}

/**
 * Get the full metadata entry for a settings key (for validation at write time).
 *
 * @param {string} key
 * @returns {{ id, value, type, min_val, max_val, is_locked }|null}
 */
function getSettingMeta(key) {
    return _settings.get(key) ?? null;
}

/**
 * Expose raw flag map size and settings map size for health/diagnostics.
 */
function getStats() {
    return {
        settings_count: _settings.size,
        flags_count: _flags.size,
        listen_connected: _listenClient !== null,
    };
}

module.exports = {
    init,
    refresh,
    stop,
    getSetting,
    getSettingNumber,
    isEnabled,
    getSettingMeta,
    getStats,
};
