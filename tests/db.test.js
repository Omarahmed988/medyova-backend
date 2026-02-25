'use strict';

const { testConnection } = require('../src/config/db');

describe('DB testConnection()', () => {
    it('returns { connected: false } when DATABASE_URL is not set', async () => {
        const savedUrl = process.env.DATABASE_URL;
        delete process.env.DATABASE_URL;

        // Re-require db.js after clearing the env
        jest.resetModules();
        const { testConnection: freshTest } = require('../src/config/db');
        const result = await freshTest();

        expect(result.connected).toBe(false);
        expect(result.error).toBeDefined();

        process.env.DATABASE_URL = savedUrl;
        jest.resetModules();
    });

    it('does not throw even when the database is unreachable', async () => {
        // Set an invalid URL and test that testConnection returns gracefully
        process.env.DATABASE_URL = 'postgresql://invalid:invalid@localhost:5432/fake';
        jest.resetModules();
        const { testConnection: badTest } = require('../src/config/db');

        await expect(badTest()).resolves.toHaveProperty('connected', false);

        delete process.env.DATABASE_URL;
        jest.resetModules();
    });
});
