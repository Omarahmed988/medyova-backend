/**
 * Migration: Enable uuid-ossp Extension
 *
 * Enables PostgreSQL UUID generation functions (uuid_generate_v4, etc.)
 * Required before any table uses UUID as primary key type.
 *
 * This is a bootstrap migration — must be the first migration executed.
 */

/** @type {import('node-pg-migrate').MigrationBuilder} */
exports.up = (pgm) => {
    pgm.sql('CREATE EXTENSION IF NOT EXISTS "uuid-ossp"');
};

/** @type {import('node-pg-migrate').MigrationBuilder} */
exports.down = (pgm) => {
    pgm.sql('DROP EXTENSION IF EXISTS "uuid-ossp"');
};
