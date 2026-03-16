# Medyova Backend
Core backend services for the Medyova Pharmacies platform.

## Architecture

*   **Node.js / Express**: REST API engine.
*   **PostgreSQL**: Primary datastore configured with `pg-pool` & `node-pg-migrate`.
*   **Trigram Search**: Uses Postgres `pg_trgm` extension for robust fuzzy medicine matching.
*   **Workers**: Specialized async processes handling routing (`routing-worker`), loyalty scores (`pharmacy-score-calculator`), SLA sweeps (`order-sla-sweep`), subscriptions (`subscription-scheduler`), and demand intelligence (`demand-signal-aggregator`).
*   **PostgreSQL LISTEN/NOTIFY**: Used for distributed cache invalidation of features and system settings.

## System Dependencies

*   Node.js v18+
*   PostgreSQL 14+ (Must include `pg_trgm` and `uuid-ossp` extensions)

## Local Setup

1.  **Clone the Repository**
    ```bash
    git clone https://github.com/Omarahmed988/medyova-backend.git
    cd medyova-backend
    ```

2.  **Install Node Modules**
    ```bash
    npm install
    ```

3.  **Environment Variables**
    Copy `.env.example` to `.env.dev` (or your target environment).
    ```bash
    cp .env.example .env.dev
    ```
    Populate the variables, primarily `DATABASE_URL`.

4.  **Database Provisioning & Migrations**
    The database user must have permissions to create extensions:
    ```sql
    CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
    CREATE EXTENSION IF NOT EXISTS pg_trgm;
    ```
    Run all up migrations:
    ```bash
    npm run migrate:up
    ```

5.  **Running the Server**
    ```bash
    npm run start
    ```

## Testing

Medyova backend uses `Jest` and `Supertest` for comprehensive end-to-end integration coverage isolated from the HTTP server via mock mounting.

```bash
# Run the full regression test suite (230+ specs)
npm test

# Run a specific phase test suite
npx jest phase20
```
Note: Ensure you have a functioning `.env.dev` with a local test PostgreSQL database (`DATABASE_URL`) that Jest can safely wipe/recreate during execution.

## Core Domain Models

*   **Order Workflow State Machine:** Strict transitions across Patient → Routing Layer → Pharmacy Fulfillment → Delivery.
*   **Medicine Demand Heatmap:** Append-only signal table aggregating missed searches and supply failures to measure area liquidity.
*   **System Settings & Toggles:** Dynamic configurations cached in memory and updated via Postgres PubSub (`pg_notify`).
