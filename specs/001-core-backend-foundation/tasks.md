# Tasks: Core Backend Foundation

**Feature**: `001-core-backend-foundation`
**Plan**: [plan.md](./plan.md) | **Spec**: [spec.md](./spec.md)
**Generated**: 2026-02-25
**Total Tasks**: 28

---

## Phase 1: Setup — Project Initialization

> Initialize `package.json`, install all dependencies, create folder scaffold.
> No story label — blocking prerequisite for everything.

- [ ] T001 Initialize `package.json` with `npm init -y` in `medyova-backend/`
- [ ] T002 Install runtime dependencies: `express cors dotenv pg helmet morgan`
- [ ] T003 Install dev dependencies: `jest supertest`
- [ ] T004 Create `jest.config.js` with coverage enabled and testPathPattern for `tests/`
- [ ] T005 Create all empty scaffold directories: `src/config/ src/controllers/ src/services/ src/models/ src/routes/ src/middlewares/ src/utils/ tests/ docs/`
- [ ] T006 Add `.gitkeep` to each empty scaffold directory to allow git tracking

---

## Phase 2: Foundational — Blocking Prerequisites

> These must complete before any user story work begins.

- [ ] T007 Create `src/config/env.js` — load `dotenv`, export `{ PORT, DATABASE_URL, NODE_ENV }` with defaults; log WARNING if `DATABASE_URL` is missing
- [ ] T008 Create `src/config/db.js` — export singleton `pg.Pool` and `testConnection()` helper that returns `{ connected: boolean, error?: string }` without throwing
- [ ] T009 Create `src/middlewares/errorHandler.js` — 4-arg Express error middleware returning `{ error, message, statusCode }` JSON; never HTML; never raw stack traces
- [ ] T010 Create `src/middlewares/notFound.js` — catch-all 404 returning `{ error: "Not Found", message, statusCode: 404 }` JSON
- [ ] T011 Create `src/middlewares/requireDb.js` — middleware returning HTTP 503 `{ error: "Service Unavailable", message: "Database not available", statusCode: 503 }` when DB is not connected; for future DB-required routes
- [ ] T012 Create `src/app.js` — instantiate Express app; apply helmet → morgan('combined') → routes → notFound → errorHandler in that order; export app without calling listen

---

## Phase 3: User Story 1 — Operator Confirms Service Is Live (P1)

> **Story Goal**: `GET /health` returns `{ status: "ok", timestamp, uptime }` with HTTP 200 — always, even without a database.
> **Independent Test**: HTTP GET to `/health` returns 200 and correct JSON body.

- [ ] T013 [US1] Create `src/routes/health.js` — define `GET /health` route returning `{ status: "ok", timestamp: new Date().toISOString(), uptime: process.uptime() }` with HTTP 200
- [ ] T014 [US1] Register health route in `src/app.js` at `/health` before the notFound middleware
- [ ] T015 [P] [US1] Create `tests/health.test.js` — import app with supertest; assert GET `/health` returns 200, `status === "ok"`, `timestamp` is a valid ISO string, `uptime` is a positive number
- [ ] T016 [P] [US1] Create `server.js` — import `app` and `config`; call `app.listen(PORT)`; log startup message with port and environment

---

## Phase 4: User Story 2 — Server Starts Gracefully Without Database (P2)

> **Story Goal**: Server boots, logs one WARNING, and remains operational when `DATABASE_URL` is absent.
> **Independent Test**: Start server with no `DATABASE_URL`; confirm boot + `/health` 200 + no crash.

- [ ] T017 [US2] Verify `src/config/env.js` logs exactly one `console.warn` when `DATABASE_URL` is absent (covered by T007; add assertion in test)
- [ ] T018 [US2] Verify `src/config/db.js` `testConnection()` returns `{ connected: false }` when DATABASE_URL is absent — no throw, no crash
- [ ] T019 [P] [US2] Add test to `tests/health.test.js` — confirm `/health` returns 200 even when DATABASE_URL env var is unset
- [ ] T020 [P] [US2] Create `tests/db.test.js` — test `testConnection()` returns `{ connected: false }` when `pg.Pool` cannot connect; mock the pool query to force failure

---

## Phase 5: User Story 3 — Developer Runs Test Suite and Sees Coverage (P3)

> **Story Goal**: `npm test` produces green results and a coverage report without any live services.
> **Independent Test**: `npm test` exits 0 and prints a coverage summary.

- [ ] T021 [US3] Add `"test": "jest"` and `"test:coverage": "jest --coverage"` scripts to `package.json`
- [ ] T022 [US3] Add `"dev": "node server.js"` and `"start": "node server.js"` scripts to `package.json`
- [ ] T023 [US3] Configure `jest.config.js` with `collectCoverage: true`, `coverageReporters: ["text", "lcov"]`, `testEnvironment: "node"`, `testMatch: ["**/tests/**/*.test.js"]`
- [ ] T024 [P] [US3] Verify all tests in `tests/` pass without any live database or network calls (supertest only — no external connections)

---

## Phase 6: Documentation

> Non-blocking — can run in parallel with Phase 3–5.

- [ ] T025 [P] Create `docs/business-model.md` — Medyova demand router, trust layer, rare engine; 5–7% commission; asset-light B2B2C
- [ ] T026 [P] Create `docs/db-schema.md` — tables: users, pharmacies, zones, prescriptions, prescription_items, offers, offer_items, orders, order_items, pharmacy_metrics; PKs, FKs, index suggestions, constraints (no migrations)
- [ ] T027 [P] Create `docs/api-contract.md` — request/response structure for: POST /prescriptions, GET /offers/:prescriptionId, POST /offers, POST /orders, GET /zones (no logic, structure only)
- [ ] T028 [P] Create `docs/trust-engine.md` — score formula: 0.40×fulfillment + 0.30×response_speed + 0.15×rating + 0.15×accuracy; normalization rules; partial fulfillment effect (no implementation)
- [ ] T029 [P] Create `docs/routing-logic.md` — zone filter → gold tier broadcast → accept/reject/partial → user selects ranked offers → fallback to silver if < 2 gold (no implementation)
- [ ] T030 [P] Create `.env.example` with `PORT=`, `DATABASE_URL=`, `NODE_ENV=`

---

## Phase 7: Polish & Cross-Cutting Concerns

- [ ] T031 Verify `global error handler` catches async errors — test an async route that throws; assert 500 JSON response (not HTML, not crash)
- [ ] T032 Run `npm test` end-to-end and confirm all tests pass with coverage report printed
- [ ] T033 Commit all Sprint 0 work: `feat: add core backend foundation (health route, db layer, error handling, tests)`

---

## Dependency Graph

```
T001 → T002 → T003 → T004
T004 → T005 → T006
T006 → T007 → T008 → T009 → T010 → T011 → T012
T012 → T013 → T014 → T015, T016          [US1]
T007, T008 → T017 → T018 → T019, T020    [US2]
T015, T020 → T021 → T022 → T023 → T024  [US3]
T025–T030 [P] — parallel to US phases
T024, T030 → T031 → T032 → T033
```

## Parallel Execution Opportunities

| Group | Tasks | Can run while… |
|-------|-------|---------------|
| A | T015, T016 | Each other — different files |
| B | T019, T020 | Each other — different test files |
| C | T025–T030 | Any US phase — docs are independent |

## Implementation Strategy

**MVP = Phase 1 + Phase 2 + Phase 3 (US1)**
A running server with a health check is the minimum meaningful output.
US2 (graceful DB failure) and US3 (test coverage) follow immediately after.
Documentation (Phase 6) can proceed in parallel without blocking any code phase.
