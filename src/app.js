
'use strict';

const express = require('express');
const helmet = require('helmet');
const morgan = require('morgan');
const cors = require('cors');

const healthRouter = require('./routes/health');
const offersRouter = require('./routes/offers');
const adminRoutes = require('./routes/admin');
const areasRouter = require('./routes/areas');
const reviewsRouter = require('./routes/reviews');
const medicinesRouter = require('./routes/medicines');
const directOrdersRouter = require('./routes/directOrders');
const pharmaciesRouter = require('./routes/pharmacies');
const subscriptionsRouter = require('./routes/subscriptions');
const patientsRouter = require('./routes/patients');
const userInsuranceProfilesRouter = require('./routes/userInsuranceProfiles');
const insuranceOrdersRouter = require('./routes/insuranceOrders');
const requireDb = require('./middlewares/requireDb');
const requireAuth = require('./middlewares/requireAuth'); // Added requireAuth middleware
const notFound = require('./middlewares/notFound');
const errorHandler = require('./middlewares/errorHandler');

const app = express();

// â”€â”€â”€ Security Headers â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
app.use(helmet());

// â”€â”€â”€ CORS â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
app.use(cors());

// â”€â”€â”€ HTTP Request Logging â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
app.use(morgan('combined'));

// â”€â”€â”€ Body Parsers â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

// â”€â”€â”€ Routes â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
app.use('/health', healthRouter);
app.use('/requests', requireDb, offersRouter);
// Founder Control
app.use('/admin', requireAuth, adminRoutes);
// Phase 12 — Delivery Areas (auth checked per-route)
app.use('/', areasRouter);
// Phase 13 — Order Reviews
app.use('/orders', requireDb, reviewsRouter);
// Phase 14 — Medicine Search & Direct Orders
app.use('/medicines', requireDb, medicinesRouter);
app.use('/orders', requireDb, requireAuth, directOrdersRouter); // /orders/direct
app.use('/pharmacies', requireDb, requireAuth, pharmaciesRouter);
// Phase 16 — Medicine Subscriptions
app.use('/subscriptions', requireDb, requireAuth, subscriptionsRouter);
// Phase 18 — Patient Profiles, Insurance Profiles, Insurance Orders
app.use('/patients', requireDb, requireAuth, patientsRouter);
app.use('/user', requireDb, requireAuth, userInsuranceProfilesRouter);
app.use('/orders', requireDb, requireAuth, insuranceOrdersRouter);

// â”€â”€â”€ 404 Catch-All (after all routes) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
app.use(notFound);

// â”€â”€â”€ Centralized Error Handler (must be last) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
app.use(errorHandler);

module.exports = app;

