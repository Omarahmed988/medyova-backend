'use strict';

const express = require('express');
const helmet = require('helmet');
const morgan = require('morgan');
const cors = require('cors');

const healthRouter = require('./routes/health');
const notFound = require('./middlewares/notFound');
const errorHandler = require('./middlewares/errorHandler');

const app = express();

// ─── Security Headers ────────────────────────────────────────────────────────
app.use(helmet());

// ─── CORS ────────────────────────────────────────────────────────────────────
app.use(cors());

// ─── HTTP Request Logging ─────────────────────────────────────────────────────
app.use(morgan('combined'));

// ─── Body Parsers ─────────────────────────────────────────────────────────────
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

// ─── Routes ───────────────────────────────────────────────────────────────────
app.use('/health', healthRouter);

// ─── 404 Catch-All (after all routes) ────────────────────────────────────────
app.use(notFound);

// ─── Centralized Error Handler (must be last) ─────────────────────────────────
app.use(errorHandler);

module.exports = app;
