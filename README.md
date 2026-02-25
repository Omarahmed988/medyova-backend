# Medyova Backend

> Demand Router + Trust Layer + Rare Priority Engine

Backend API for the Medyova healthcare pharmacy marketplace. Asset-light B2B2C platform connecting patients with pharmacies in Egypt.

## Architecture

- **Backend:** Node.js (LTS) + Express.js
- **Database:** PostgreSQL (Supabase)
- **Data Access:** Raw SQL (no ORM)
- **Testing:** Jest + Supertest

## Quick Start

```bash
# Install dependencies
npm install

# Copy environment config
cp .env.example .env

# Start development server
npm run dev

# Run tests
npm test

# Run tests with coverage
npm run test:coverage
```

## Project Structure

```
medyova-backend/
├── src/
│   ├── config/          # Environment + DB connection
│   ├── controllers/     # Request handlers
│   ├── services/        # Business logic
│   ├── models/          # Data access layer
│   ├── routes/          # Route definitions
│   ├── middlewares/      # Error handling, logging
│   ├── utils/           # Shared utilities
│   └── app.js           # Express app setup
├── tests/               # Jest test suites
├── docs/                # Architecture & API documentation
├── .env.example         # Environment template
├── package.json
└── server.js            # Entry point
```

## Core Modules

| Module | Description |
|--------|-------------|
| **Routing Engine** | Demand-to-pharmacy matching by zone, tier, and trust score |
| **Trust Engine** | Composite pharmacy scoring (fulfillment, speed, rating, accuracy) |
| **Rare Priority** | Scarce medication sourcing via tiered pharmacy broadcast |

## Branch Strategy

| Branch | Purpose |
|--------|---------|
| `main` | Production-ready releases |
| `dev` | Integration branch |
| `feature/*` | Feature development |

## Commit Convention

This project follows [Conventional Commits](https://www.conventionalcommits.org/):

```
feat: add new feature
fix: bug fix
docs: documentation only
chore: build/tooling changes
test: adding/updating tests
refactor: code restructuring
```

## License

MIT — see [LICENSE](LICENSE)
