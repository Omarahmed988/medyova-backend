<!--
SYNC IMPACT REPORT
Version change: N/A → 1.0.0 (initial ratification)
Added sections: Core Principles (10), Technology Constraints, Development Workflow, Governance
Removed sections: All placeholder tokens replaced
Templates updated:
  ✅ .specify/memory/constitution.md (this file)
  ⚠ .specify/templates/plan-template.md (review for constitution alignment)
  ⚠ .specify/templates/spec-template.md (review for scope alignment)
  ⚠ .specify/templates/tasks-template.md (review for task categorization)
Follow-up TODOs: None — all fields defined.
-->

# Medyova Constitution

## Core Principles

### I. Clean Architecture (NON-NEGOTIABLE)

Every module MUST have a single, explicit responsibility. Business logic MUST
NOT bleed into route handlers, middleware, or data-access layers. Dependencies
MUST point inward: routes → controllers → services → models → DB. No circular
dependencies are permitted.

**Rationale**: Clean separation allows the small founding team to onboard new
engineers without tribal knowledge, and enables unit-testing business logic in
isolation.

### II. Business Logic Isolation (NON-NEGOTIABLE)

All domain logic (routing, trust scoring, rare-medicine prioritization) MUST
live exclusively in `src/services/`. Controllers MUST remain thin orchestrators
that call services and return HTTP responses. Services MUST NOT import from
`routes/` or `middlewares/`.

**Rationale**: The routing, trust, and rare engines are Medyova's core
competitive assets. They MUST be independently testable and portable without
Express coupling.

### III. Deterministic Routing Logic

The demand-to-pharmacy routing algorithm MUST produce deterministic, auditable
outputs for identical inputs. No randomization without explicit seeding.
Ranking decisions MUST be traceable to input parameters and score components.
All tie-breaking rules MUST be documented and coded explicitly.

**Rationale**: Healthcare marketplace trust requires operators and auditors to
explain any routing decision. Black-box behavior is not acceptable.

### IV. Testability First

Every service function MUST be independently testable without a live database
or HTTP server. Database interactions MUST be injectable/mockable. Test
coverage MUST be reported on every run (Jest coverage enabled by default).
A failing test suite MUST block commits on CI.

**Rationale**: A 2-engineer team cannot afford regressions. Tests are the
safety net that enables confident iteration.

### V. Performance Under Low-Resource Environments

The server MUST start and serve `/health` in under 2 seconds on a free-tier
instance (512 MB RAM, shared CPU). No in-memory caches that grow unbounded.
No synchronous blocking I/O in request handlers. Database queries MUST use
parameterized statements and explicit column selection (no `SELECT *`).

**Rationale**: Hosting is on Railway/Render free tiers during early stage.
Performance budget is constrained; efficiency is non-negotiable.

### VI. Strict UI/Engine Separation

This repository is backend-only. No HTML, CSS, templating engines, or
frontend build tools MUST ever be introduced. The API MUST remain stateless
and UI-agnostic. All responses MUST be JSON. CORS MUST be configured
explicitly, not with wildcard origins in production.

**Rationale**: Frontend is a separate repository and team concern. Mixing
concerns in this repo would violate the architecture directive and complicate
future team splits.

### VII. Minimal Dependencies

A new `npm` dependency MUST be justified by: (a) significant complexity saved,
(b) active maintenance record, and (c) no equivalent achievable with Node.js
stdlib or existing deps. No ORM. Raw SQL via `pg` is the mandated data access
pattern. Dependency additions require team discussion and documentation in the
relevant PR.

**Rationale**: Fewer dependencies reduce attack surface, bundle size, and the
cognitive overhead of onboarding new engineers.

### VIII. SQL-First Data Modeling

All data access MUST use raw parameterized SQL via the `pg` client. Schema
changes MUST be managed through versioned migration files. No query builders,
no ORMs, no ActiveRecord patterns. Queries MUST be written in `src/models/`
as named, exported functions — not inline in services or controllers.

**Rationale**: Direct SQL gives full control over query performance, indexing
strategy, and schema evolution — critical for a data-intensive routing engine
on a constrained budget.

### IX. Scalability Without Rewrite

Every architectural decision MUST be evaluated against the question: "Will
this decision require a rewrite at 100× current load?" Stateless request
handling is MANDATORY. Session state MUST NOT be stored in-process. Database
connection pooling MUST be configured from day one. Environment-specific
config MUST use environment variables exclusively.

**Rationale**: Medyova is a startup. The foundation must support growth from
prototype to production without architectural rewrites that divert engineering
resources from the core product.

### X. Graceful Failure Handling

The server MUST start and remain operational even when optional external
services (database, third-party APIs) are unavailable. Missing `DATABASE_URL`
MUST log a WARNING and allow startup to proceed. Routes that require a
database MUST return HTTP 503 with a structured error body when the DB is
unreachable. Unhandled promise rejections and uncaught exceptions MUST be
caught globally and logged — never silently swallowed.

**Rationale**: Free-tier hosting environments experience cold starts and
transient failures. Graceful degradation prevents full outages during partial
infrastructure issues.

## Technology Constraints

- **Runtime**: Node.js LTS (current: v22.x) — no Bun, Deno, or non-LTS versions.
- **Framework**: Express.js — no Fastify, Hapi, or Koa unless explicitly re-ratified.
- **Database**: PostgreSQL via Supabase — `pg` client only, no ORMs.
- **Testing**: Jest + Supertest — coverage threshold enforced in `jest.config.js`.
- **Logging**: Morgan for HTTP logs; `console.warn/error` for app-level alerts
  until a structured logger is formally adopted.
- **Security**: Helmet for HTTP headers — MUST be applied before all routes.
- **Auth**: NOT in scope for Sprint 0. Supabase Auth deferred to future sprint.
- **Hosting**: Railway or Render free tier.

## Development Workflow

- Branch strategy: `main` (production) → `dev` (integration) → `feature/*`.
- All commits MUST follow [Conventional Commits](https://www.conventionalcommits.org/).
- Pull requests MUST target `dev`; `main` receives only release merges.
- Every PR MUST pass `npm test` (with coverage) before merge.
- Environment variables MUST be documented in `.env.example` — real credentials
  MUST NEVER be committed.
- The `.agent/` directory MUST remain in `.gitignore` at all times.

## Governance

This Constitution supersedes all other informal practices or verbal agreements.
Amendments require:
1. A documented rationale (GitHub PR description or ADR in `docs/`).
2. Explicit version bump following semantic versioning rules defined above.
3. Update of this file and re-propagation to affected templates.
4. Team review (both founding engineers must approve).

Compliance is verified at PR review time. The Governance section is reviewed
each quarter or upon any principle amendment.

**Version**: 1.0.0 | **Ratified**: 2026-02-25 | **Last Amended**: 2026-02-25
