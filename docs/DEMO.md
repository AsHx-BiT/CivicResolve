# Five-minute local demo

## Start it

In PowerShell from the repository root:

```powershell
Copy-Item .env.example .env
npm install
docker compose up -d postgres
docker compose ps
npm run db:generate
npm run db:deploy
npm run db:seed
npm run dev
```

Use the development-only password printed by the first `db:seed` command (or the local `SEED_PASSWORD` chosen before the first seed). Do not reuse it outside the demo. Login organization slug is `pune-municipal-services`.

## Walkthrough

1. **Login as administrator**: `admin@pms.local`. Open the dashboard and compare total/open/resolved counts, overdue cases, SLA compliance and escalations with seeded API data.
2. **Inspect the case register**: search a reference or title, filter by status/priority/department, change sort order, and page through the 60+ seeded cases. Open a case to inspect status history, assignment, SLA snapshot and escalation timeline.
3. **Change workflow configuration**: open routing rules and SLA policies, edit a rule/policy or toggle it, then reload and confirm the saved value comes back from PostgreSQL. Existing case SLA deadlines retain their snapshots.
4. **Check audit and notifications**: open audit logs and notifications. Seeded breach events and newly created routing/configuration actions are represented by stored records.
5. **Submit as a citizen**: sign out; log in as `asha.kulkarni@citizen.pms.local`. Submit a municipal issue with category, location and optional supported attachment. Confirm the returned case reference appears in complaint history, then open that case to review its status timeline and SLA deadline.
6. **Run escalation processing**: in a second terminal execute `npm run automation:run`. Inspect `GET /api/v1/automation/runs` as an SLA administrator or the SLA automation runs screen. Re-running the command should not duplicate a milestone for the same case.

Other demo emails are listed in the repository README. Use the same development-only password for each seeded account. Citizen, Officer, Supervisor, Department Manager, Senior Authority, Organization Administrator and Auditor are seeded roles.

## What this demo does not connect

SLA clocks use elapsed time rather than business calendars. Notifications are stored in PostgreSQL and displayed in-app; email, SMS, push, external queues and Redis are not connected. Attachments are local filesystem files, not private object storage. The seed currently associates the generated case set with the seeded citizen account for a straightforward history walkthrough. Docker, PostgreSQL migrations and a real local database are required to verify persistence and end-to-end screens; unit/in-memory HTTP tests do not replace that verification.
