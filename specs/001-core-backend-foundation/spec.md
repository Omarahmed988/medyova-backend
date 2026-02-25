# Feature Specification: Core Backend Foundation

**Feature Branch**: `001-core-backend-foundation`
**Created**: 2026-02-25
**Status**: Draft
**Input**: User description: "Backend-only Express server, PostgreSQL connection layer, health route, environment config, error handling, logging, folder structure, testing framework setup. No routing engine yet. No trust engine yet. No rare engine yet."

## User Scenarios & Testing *(mandatory)*

### User Story 1 — Operator Confirms Service Is Live (Priority: P1)

An operations engineer needs to confirm the backend service is running and
healthy before routing traffic or deploying dependent services. They call a
known endpoint and receive a machine-readable status response.

**Why this priority**: Without a reliable liveness check, the team cannot
confidently deploy to hosting platforms or integrate with uptime monitors.
This is the first thing a hosting platform will probe.

**Independent Test**: A fresh server start followed by a single HTTP GET
delivers a structured status response — no database or business logic needed.

**Acceptance Scenarios**:

1. **Given** the server has started successfully, **When** a request is made
   to the health endpoint, **Then** the response body contains `status: "ok"`,
   a timestamp, and server uptime, with HTTP 200.

2. **Given** the server has started but the database is unavailable,
   **When** a request is made to the health endpoint, **Then** the response
   still returns HTTP 200 with `status: "ok"` — the health check remains
   operational regardless of DB state.

3. **Given** an invalid path is requested, **When** any undefined route is
   called, **Then** the server returns HTTP 404 with a structured JSON error
   body, not an HTML page.

---

### User Story 2 — Server Starts Gracefully Without Database (Priority: P2)

A developer clones the repository, copies `.env.example` to `.env`, and
starts the server **without** providing a `DATABASE_URL`. The server must
not crash — it must start, warn, and serve non-database routes.

**Why this priority**: Free-tier environments have transient DB connectivity
issues. The server must never go down because the DB is temporarily
unreachable. This also allows frontend and infra teams to boot the server
before the DB is provisioned.

**Independent Test**: Start server with no `DATABASE_URL` set; confirm it
boots, logs a warning, and `/health` returns 200.

**Acceptance Scenarios**:

1. **Given** `DATABASE_URL` is not set in the environment, **When** the
   server starts, **Then** it logs exactly one WARNING message about missing
   DB config and completes startup within 5 seconds.

2. **Given** the server is running without a database, **When** a request
   hits a database-required route (future), **Then** the server returns
   HTTP 503 with a structured JSON error — it does not crash or hang.

---

### User Story 3 — Developer Runs the Test Suite and Sees Coverage (Priority: P3)

A developer runs the test command and receives a pass/fail result plus a
coverage report — without needing a live database or environment variables.

**Why this priority**: The team is small. Catching regressions automatically
is the safety net for rapid iteration. Coverage reporting is non-negotiable
per the constitution.

**Independent Test**: `npm test` produces a green result and a coverage
summary — no external services needed.

**Acceptance Scenarios**:

1. **Given** the project is freshly cloned and `npm install` is run,
   **When** `npm test` is executed, **Then** all tests pass and a coverage
   report is printed to stdout.

2. **Given** the health route test exists, **When** `npm test` runs,
   **Then** it makes an in-process HTTP request and asserts HTTP 200 and
   `{ status: "ok" }` in the body.

---

### Edge Cases

- What happens when an unhandled promise rejection occurs in a route handler?
  The global error handler must catch it and return 500, not crash the process.
- What happens when `PORT` environment variable is not set?
  The server must fall back to a default port and log which port it is using.
- What happens when a malformed JSON body is sent to a POST endpoint?
  The error handler must return HTTP 400 with a structured JSON error.
- What happens when the database connection pool is exhausted?
  Future DB-required routes return 503; health endpoint remains unaffected.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The server MUST expose a health check endpoint that returns
  `{ status: "ok", timestamp: <ISO8601>, uptime: <seconds> }` with HTTP 200.
- **FR-002**: The server MUST start successfully even when `DATABASE_URL`
  is absent, logging one WARNING and continuing startup.
- **FR-003**: The server MUST apply security headers to every HTTP response.
- **FR-004**: The server MUST log every incoming HTTP request including
  method, path, status code, and response time.
- **FR-005**: The server MUST catch all unhandled errors and return a
  structured JSON error response — never an HTML error page, never a crash.
- **FR-006**: The database client MUST expose a connection-test function
  that returns a boolean indicating connectivity — without throwing.
- **FR-007**: All configuration (port, DB URL) MUST be sourced exclusively
  from environment variables with documented defaults in `.env.example`.
- **FR-008**: The test suite MUST run without any live database or network
  calls — using in-process HTTP only.
- **FR-009**: Test coverage MUST be reported on every test run.
- **FR-010**: The project folder structure MUST match the documented layout
  in `README.md` (config, controllers, services, models, routes, middlewares,
  utils).

### Key Entities

- **Server**: The Node.js process that binds to a port and handles HTTP
  requests. Has a lifecycle (start, healthy, shutdown).
- **Database Client**: A reusable connection pool to PostgreSQL. Has a
  connectivity state (connected, disconnected, not configured).
- **Health Response**: A structured JSON payload reporting server liveness.
  Contains: status string, ISO timestamp, uptime in seconds.
- **Error Response**: A structured JSON payload for all error conditions.
  Contains: error code, human-readable message, HTTP status.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Server starts and responds to the health endpoint in under
  2 seconds on a free-tier hosting instance.
- **SC-002**: Server starts successfully without crashing when no database
  connection is available.
- **SC-003**: All automated tests pass without any external service dependency.
- **SC-004**: Test coverage report is produced on every `npm test` run.
- **SC-005**: Any unhandled server error returns a structured JSON response
  — never an HTML page, never an unformatted stack trace.
- **SC-006**: A new engineer can clone the repository, follow `README.md`,
  and have a locally running server in under 5 minutes.

## Assumptions

- "Health check" means liveness only (is the process alive?), not readiness
  (is the database connected?). Readiness checks are deferred to a future sprint.
- No authentication or authorization is in scope for this foundation sprint.
- HTTP logging uses the `combined` format (method, URL, status, response time).
- The default port when `PORT` is unset is `3000`.
- The database connection pool uses a default of 10 max connections unless
  overridden by environment variable.

## Out of Scope

- Routing engine, trust scoring, rare medicine prioritization.
- User authentication or Supabase Auth integration.
- Any business domain logic (pharmacies, prescriptions, orders).
- Frontend, templating, or HTML responses.
- Database migrations or schema creation.
- Deployment pipeline or CI/CD configuration.
