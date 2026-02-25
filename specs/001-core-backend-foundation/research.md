# Research: Core Backend Foundation

## Node.js Project Structure

**Decision**: Layered architecture — `routes → controllers → services → models → db`
**Rationale**: Enforces constitution principle of Business Logic Isolation; each layer is independently testable; standard pattern understood by any Node.js engineer.
**Alternatives considered**: Feature-based folders (rejected — harder to enforce layer boundaries for a small team); Flat structure (rejected — no separation).

## Express.js App vs Server Separation

**Decision**: `src/app.js` exports the Express app; `server.js` calls `app.listen()`.
**Rationale**: Allows `supertest` to import the app without binding to a port, enabling isolated HTTP testing without a network socket. This is the standard Express testing pattern.
**Alternatives considered**: Single `app.js` file with listen (rejected — blocks portless testing).

## Database Connection Pattern

**Decision**: Singleton `pg.Pool` exported from `src/config/db.js`; `testConnection()` helper returns `{ connected: boolean, error?: string }`.
**Rationale**: Connection pooling is essential from day one per constitution Principle IX (Scalability). Graceful failure is required by Principle X and FR-002/FR-006.
**Alternatives considered**: `pg.Client` per request (rejected — connection overhead, no pooling); Sequelize (rejected — no ORM per constitution Principle VIII).

## Graceful DB Missing — 503 Future-Proofing

**Decision**: Export a `requireDb` middleware from `src/middlewares/requireDb.js` that returns 503 when DB client is not connected.
**Rationale**: Applied to any future DB-required routes. Keeps the pattern consistent and avoids ad-hoc DB checks scattered through controllers.
**Alternatives considered**: Boolean flag checked in each controller (rejected — duplication, fragile).

## Security Headers

**Decision**: `helmet()` applied globally before all routes in `src/app.js`.
**Rationale**: One-line activation for 14+ HTTP security headers. Standard minimum for any production API. Constitution Principle VI (UI/Engine Separation) implies no browser-rendered content, making header correctness important.
**Alternatives considered**: Manual `res.setHeader()` calls (rejected — error-prone, incomplete).

## HTTP Logging

**Decision**: `morgan('combined')` applied after `helmet()` in `src/app.js`.
**Rationale**: `combined` format includes method, URL, status, response time, and user agent — sufficient for debugging free-tier deployments without a paid logging service.
**Alternatives considered**: `morgan('dev')` (rejected — missing timestamp; fine for dev, not prod); Winston (deferred — acceptable future enhancement, not needed in Sprint 0).

## Error Handling

**Decision**: Centralized Express error middleware `src/middlewares/errorHandler.js` with 4-argument signature `(err, req, res, next)`. Must be registered last.
**Rationale**: Single point of error response formatting ensures no stack traces leak to clients. Consistent JSON error body regardless of error source.
**Alternatives considered**: Per-route try/catch only (rejected — misses async errors and unhandled promise rejections).

## Testing

**Decision**: Jest + Supertest. Jest configured with `--coverage` in `jest.config.js` `coverageReporters` and as default test script.
**Rationale**: Constitution Principle IV mandates coverage on every run. Supertest allows in-process HTTP testing without a live server port.
**Alternatives considered**: Mocha + Chai (no coverage integration by default); Vitest (mature but less ecosystem stability for backend).

## Environment Config

**Decision**: `dotenv` loaded once in `src/config/env.js`, which exports validated config object. All other modules import from `env.js`, not `process.env` directly.
**Rationale**: Centralizes config validation; easier to mock in tests; documents all required variables in one place.
**Alternatives considered**: Direct `process.env` reads scattered through files (rejected — untestable, undocumented).
