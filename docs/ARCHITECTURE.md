# Architecture

## Components

- `frontend/`: React/TypeScript single-page service UI, built by Vite and styled with Tailwind CSS. Recharts renders analytics returned by the API. Vite proxies `/api` and `/health` to Express.
- `backend/`: Express 5 API, Zod validation, authentication/session middleware, authorization, file handling, SLA/routing services, CLI scheduler and Supertest/Vitest tests.
- `prisma/`: Prisma schema and ordered PostgreSQL migrations.
- `docker-compose.yml`: one PostgreSQL 17 service, persistent named volume, and `pg_isready` health check.

The development command runs the frontend and API together. There are no microservices or Redis dependency. The SLA scheduler is an in-process local polling loop or one-shot CLI command.

## Request and tenant boundaries

The API derives organization scope from the authenticated user's server-side session. It does not accept a client organization ID as authority. Case and related-record queries use organization scope plus citizen, department or assignment scope as applicable. Prisma relationships use composite organization foreign keys in the schema/migrations. Sensitive actions are written to `AuditLog`; a PostgreSQL trigger blocks updates and deletes on that table.

## Authentication and authorization

Login verifies scrypt password hashes and creates a random opaque session token. Only the token hash is stored. The browser receives an `HttpOnly`, `SameSite=Strict` session cookie plus a separate CSRF cookie. State-changing requests require matching CSRF cookie/header values and an allowed origin. Sessions expire and logout revokes them. `complaint.*`, `user.manage`, `report.view`, `workflow.manage`, `sla.manage` and audit permissions are loaded from organization role grants.

## Case lifecycle and automation

Case creation validates active category/subcategory and tenant-local region references. A priority and severity choose the most specific applicable active SLA. The API persists the policy snapshot, start and due timestamps on the case. Current targets are 4 hours (Critical), 24 hours (High), 72 hours (Medium), and 7 days (Low). Clocks currently use **elapsed time**, including nights, weekends and holidays. `SlaCalendar` is the extension point for future business-hour calendars.

Routing evaluates configured active rules against category, region, ward, severity and priority, ordered by configured rank then specificity. If no rule matches, the explicitly configured fallback queue may be used. With no fallback, cases remain unassigned; the API does not guess a department.

`npm run automation:run` evaluates each active organization's open cases once. `npm run automation:scheduler` repeats at `SLA_PROCESS_INTERVAL_SECONDS` (default 60, minimum 15). Warning, at-risk, breach and extended-breach thresholds are configured by `SLA_WARNING_PERCENT`, `SLA_AT_RISK_PERCENT` and `SLA_EXTENDED_BREACH_MULTIPLIER`. Unique database keys guard duplicate escalations and notifications; processing outcomes and per-case errors are stored in `AutomationRun`.

## Run locally

From the repository root in PowerShell:

```powershell
Copy-Item .env.example .env
npm install
docker compose up -d postgres
npm run db:generate
npm run db:deploy
npm run db:seed
npm run dev
```

`docker compose ps` should report PostgreSQL healthy. `GET http://localhost:4000/health` and `GET http://localhost:5173/health` report API/database readiness. Set `DATABASE_URL` in `.env` to use a local PostgreSQL installation instead of Compose.

## Verification and deployment boundary

The repository build and automated tests can run without a database. Migration, seed, real login, case workflow, upload delivery and scheduler verification require a reachable PostgreSQL database. The Compose defaults are local demo credentials, the seeded users are development accounts, and uploaded files use local disk. No production infrastructure, external notification delivery, working-hours calendar, backup/restore process, deployment pipeline, monitoring service or independent security review is supplied here. See [Security](SECURITY.md).
