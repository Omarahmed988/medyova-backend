# Implementation Plan: Core Backend Foundation

**Branch**: `001-core-backend-foundation` | **Date**: 2026-02-25 | **Spec**: [spec.md](./spec.md)
**Input**: Feature specification from `specs/001-core-backend-foundation/spec.md`

## Summary

Establish the production-grade Node.js/Express backend foundation for Medyova. This delivers a running HTTP server with security headers, request logging, centralized error handling, a health check endpoint, a PostgreSQL connection layer that fails gracefully, and a Jest test suite with coverage. No business logic is included.

## Technical Context

**Language/Version**: Node.js LTS (v22.x), JavaScript (ESM not used — CommonJS for compatibility)
**Primary Dependencies**: express, cors, dotenv, pg, helmet, morgan, jest, supertest
**Storage**: PostgreSQL via Supabase — `pg` Pool only, no ORM
**Testing**: Jest (coverage enabled by default) + Supertest
**Target Platform**: Linux server (Railway / Render free tier)
**Project Type**: REST API (web service)
**Performance Goals**: `/health` responds in < 2 seconds on a 512 MB RAM instance
**Constraints**: 512 MB RAM, shared CPU, free tier cold starts
**Scale/Scope**: Sprint 0 — foundation only. No concurrent user target yet.

## Constitution Check

*GATE: Must pass before Phase 0 research.*

| Principle | Status | Notes |
|-----------|--------|-------|
| I. Clean Architecture | ✅ PASS | routes → controllers → services → models → db enforced |
| II. Business Logic Isolation | ✅ PASS | No business logic in Sprint 0 — services/ is empty scaffold |
| III. Deterministic Routing Logic | ✅ N/A | No routing engine in Sprint 0 |
| IV. Testability First | ✅ PASS | Supertest in-process, Jest coverage enabled |
| V. Performance Under Low-Resource | ✅ PASS | No blocking I/O, no unbounded state, connection pooling |
| VI. Strict UI/Engine Separation | ✅ PASS | Backend-only, JSON responses, no templating |
| VII. Minimal Dependencies | ✅ PASS | 6 runtime deps (express, cors, dotenv, pg, helmet, morgan) |
| VIII. SQL-First Data Modeling | ✅ N/A | No queries in Sprint 0 — pattern established |
| IX. Scalability Without Rewrite | ✅ PASS | Stateless, pooled connections, env-based config |
| X. Graceful Failure Handling | ✅ PASS | Missing DB_URL → WARNING + server continues, 503 middleware |

**No constitution violations. Cleared to proceed.**

## Project Structure

### Documentation (this feature)

```text
specs/001-core-backend-foundation/
├── spec.md               (/speckit.specify output)
├── plan.md               (this file — /speckit.plan output)
├── research.md           (Phase 0 — 9 technical decisions)
├── data-model.md         (Phase 1 — 5 entities)
├── contracts/
│   └── api.md            (Phase 1 — health + error contracts)
├── checklists/
│   └── requirements.md   (all items pass)
└── tasks.md              (/speckit.tasks output — next step)
```

### Source Code (repository root)

```text
medyova-backend/
├── src/
│   ├── config/
│   │   ├── env.js          # Loads + validates env variables, exports config object
│   │   └── db.js           # pg.Pool singleton + testConnection() helper
│   ├── controllers/        # (empty scaffold — no business logic)
│   ├── services/           # (empty scaffold — no business logic)
│   ├── models/             # (empty scaffold — no business logic)
│   ├── routes/
│   │   └── health.js       # GET /health route
│   ├── middlewares/
│   │   ├── errorHandler.js # Centralized 4-arg Express error handler
│   │   ├── notFound.js     # 404 catch-all → structured JSON
│   │   └── requireDb.js    # 503 guard for future DB-required routes
│   ├── utils/              # (empty scaffold)
│   └── app.js              # Express app: helmet → morgan → routes → 404 → error handler
│
├── tests/
│   └── health.test.js      # GET /health — asserts 200, status:"ok", timestamp, uptime
│
├── docs/
│   ├── business-model.md
│   ├── routing-logic.md
│   ├── trust-engine.md
│   ├── api-contract.md
│   └── db-schema.md
│
├── specs/                  # Spec-Kit artifacts (see above)
├── .env.example
├── .gitignore
├── jest.config.js
├── package.json
├── README.md
├── LICENSE
└── server.js               # Entry point: imports app, calls app.listen()
```

**Structure Decision**: Single-project layout. No monorepo. Backend-only per constitution Principle VI.

## Complexity Tracking

No constitution violations — this section is not applicable.
