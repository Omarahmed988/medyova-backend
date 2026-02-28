/**
 * Migration runner — loads the correct .env file before executing node-pg-migrate.
 *
 * Usage:
 *   node scripts/migrate.js up
 *   node scripts/migrate.js down
 *   node scripts/migrate.js create my-migration-name
 */
'use strict';

const path = require('path');

const NODE_ENV = process.env.NODE_ENV || 'development';
const envFile = NODE_ENV === 'production' ? '.env.prod' : '.env.dev';

require('dotenv').config({
    path: path.resolve(__dirname, '..', envFile),
});

if (!process.env.DATABASE_URL) {
    console.error(`[MIGRATE] DATABASE_URL is not set in ${envFile}. Aborting.`);
    process.exit(1);
}

const { execSync } = require('child_process');
const args = process.argv.slice(2).join(' ');
const cmd = `node-pg-migrate ${args} --migrations-dir migrations`;

console.info(`[MIGRATE] Environment: ${NODE_ENV}`);
console.info(`[MIGRATE] Env file:    ${envFile}`);
console.info(`[MIGRATE] Command:     ${cmd}`);

try {
    execSync(cmd, { stdio: 'inherit', cwd: path.resolve(__dirname, '..') });
} catch (err) {
    process.exit(err.status || 1);
}
