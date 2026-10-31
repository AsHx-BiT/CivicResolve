# CivicResolve

CivicResolve is a local full-stack municipal grievance demo built with React, TypeScript, Vite, Express, Prisma, PostgreSQL and Zod. It includes organization-scoped case management, cookie sessions, role permissions, routing rules, elapsed-time SLA policies, a local escalation processor, in-app notifications and an audit trail.

This repository is a **development demo**, not an independently security-audited or production-ready service. Read [Security](docs/SECURITY.md) and [Architecture](docs/ARCHITECTURE.md) before deployment.

## Prerequisites

- Node.js 20.19+ (or 22.12+) and npm 10+
- Docker Desktop/Engine with Compose, or PostgreSQL 18 for the Windows local-server option

## Start the local demo (PowerShell)

```powershell
Copy-Item .env.example .env
npm install
docker compose up -d postgres
npm run db:generate
npm run db:deploy
npm run db:seed
npm run dev
```

Wait for PostgreSQL to pass its Compose health check, then open <http://localhost:5173>. Vite proxies `/api` and `/health` to Express on port 4000. PostgreSQL data persists in the `civicresolve-postgres` named volume.

If PowerShell reports that `npm.ps1` cannot load because script execution is disabled, run the same commands through `npm.cmd` (for example, `npm.cmd run dev`). This does not change the machine's execution policy.

If Vite reports that port 5173 is in use and starts on 5174, another development server is already running. Keep using its printed URL or press `Ctrl+C` in the extra terminal before starting CivicResolve again.

### Windows local PostgreSQL alternative

Use this when Docker is unavailable. PostgreSQL 18 must be installed in the default Windows location (`C:\Program Files\PostgreSQL\18\bin`). Set `DATABASE_URL` in `.env` to a local-only URL using port 5433, for example `postgresql://civicresolve:civicresolve@127.0.0.1:5433/civicresolve?schema=public`; use a unique development password if you create a fresh `.env`. Then run:

```powershell
npm run db:start-local
npm run db:generate
npm run db:deploy
npm run db:seed
npm run dev
```

`db:start-local` initializes `%LOCALAPPDATA%\CivicResolve\postgres18-demo` from the credentials in `.env` if that directory is absent, then starts PostgreSQL on `127.0.0.1:5433`. It never deletes or overwrites a nonempty uninitialized directory. The data directory persists across app restarts. Run `npm run db:start-local` again after a Windows restart. These credentials and demo data are development-only.

On the first seed, the command prints one random **development-only** password shared by the seeded accounts. Copy it from that command's output. To choose a known local demo password instead, set `SEED_PASSWORD` in your untracked `.env` before the first seed; it must be at least 16 characters. Do not use either the generated password or a development value outside a local demo. Production deployment must create new accounts and credentials and replace all local configuration before serving traffic.

## Demo accounts

Organization slug: `pune-municipal-services`. Use the development-only password printed by the first seed, or the local-only `SEED_PASSWORD` you configured.

Citizens can also select **Create a Citizen account** on the sign-in page. Registration creates only a Citizen role and profile for the active organization; the new user signs in after registration. Email verification is not enabled in the local demo.

| Role | Email |
| --- | --- |
| Citizen | `asha.kulkarni@citizen.pms.local` |
| Officer | `rohan.deshmukh@pms.local` |
| Supervisor | `meera.joshi@pms.local` |
| Department Manager | `sanjay.patil@pms.local` |
| Senior Authority | `anita.shah@pms.local` |
| Organization Administrator | `admin@pms.local` |
| Auditor | `priya.nair@pms.local` |

The development seed creates Pune departments, regions, categories, routing and SLA configuration, users, and more than 50 cases with varied statuses, priorities, SLA deadlines and seeded escalation events. Seed data is demo-only.

## Useful commands

| Command | Purpose |
| --- | --- |
| `npm run dev` | Run Express and Vite in development |
| `npm run build` | Build/type-check the backend and frontend |
| `npm test` | Run backend Vitest/Supertest HTTP integration tests and automation unit tests |
| `npm run db:generate` | Generate Prisma Client |
| `npm run db:deploy` | Apply committed migrations |
| `npm run db:migrate` | Create/apply a development migration |
| `npm run db:seed` | Seed development-only demo users and data |
| `npm run db:start-local` | Initialize/start the isolated Windows PostgreSQL 18 demo cluster on port 5433 |
| `npm run automation:run` | Run SLA escalation processing once |
| `npm run automation:scheduler` | Poll the database locally (default every 60 seconds) |
| `docker compose down` | Stop PostgreSQL and retain its volume |
| `docker compose down -v` | **Delete** the local database volume and its data |

The seed script refuses to run with `NODE_ENV=production`. It hashes passwords with scrypt; it does not store plaintext passwords. If `SEED_PASSWORD` is omitted, an unguessable development password is generated and printed once. Re-running seed without `SEED_PASSWORD` leaves existing password hashes intact.

## Documentation

- [Five-minute demo and limitations](docs/DEMO.md)
- [Architecture and local operations](docs/ARCHITECTURE.md)
- [Versioned API reference](docs/API.md)
- [Security controls and known gaps](docs/SECURITY.md)

## Troubleshooting

- `docker compose up -d postgres` needs Docker Desktop/Engine running. Check `docker compose ps` and `docker compose logs postgres`.
- `GET /health` returns `503` when Express is running but cannot query PostgreSQL.
- If you change `.env`, restart the dev server. Cookie `Secure` defaults to false only for localhost; production mode forces it on.
- If Prisma Client needs regeneration while a running Node process holds its native engine, stop the app and run `npm run db:generate` again.
