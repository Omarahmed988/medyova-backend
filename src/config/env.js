'use strict';

require('dotenv').config();

const PORT = process.env.PORT || 3000;
const DATABASE_URL = process.env.DATABASE_URL || null;
const NODE_ENV = process.env.NODE_ENV || 'development';

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
