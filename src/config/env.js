'use strict';

const path = require('path');

// ─── Environment File Resolution ──────────────────────────────────────────
// Supports dual-environment setup:
//   NODE_ENV=development → loads .env.dev
//   NODE_ENV=production  → loads .env.prod
//   fallback             → loads .env
//
// Set NODE_ENV BEFORE starting the process:
//   $env:NODE_ENV="development"; npm run dev
//   $env:NODE_ENV="production"; npm start

const NODE_ENV = process.env.NODE_ENV || 'development';

const envFile = NODE_ENV === 'production'
    ? '.env.prod'
    : NODE_ENV === 'development'
        ? '.env.dev'
        : '.env';

require('dotenv').config({
    path: path.resolve(process.cwd(), envFile),
});

// ─── Exports ──────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
const DATABASE_URL = process.env.DATABASE_URL || null;

if (!DATABASE_URL) {
    console.warn(
        '[WARNING] DATABASE_URL is not set. ' +
        'The server will start, but database-dependent routes will return 503.'
    );
}

module.exports = {
    PORT,
    DATABASE_URL,
    NODE_ENV,
};
