# API reference

Base path for application endpoints: `/api/v1`. JSON success responses use `{ "data": ... }`; errors use `{ "error": { "code", "message", "details?" }, "requestId" }`. `GET /health` is an unversioned readiness endpoint and returns 503 when PostgreSQL cannot be queried.

Citizen self-registration uses `POST /auth/register` with `{ "organizationSlug", "fullName", "email", "phone?", "password" }`. The server resolves the active organization and assigns only the Citizen role; clients cannot submit a tenant ID or role. Passwords must be at least 12 characters. A successful registration returns 201 and the citizen then signs in through `POST /auth/login` with `{ "organizationSlug", "email", "password" }`. Registration is rate limited. Email verification is not configured in this local demo. Login sets the session and CSRF cookies. Send `X-CSRF-Token` matching the `civic_csrf` cookie on authenticated writes. `GET /auth/me` returns the current user and permissions; `POST /auth/logout` revokes the session and clears cookies. Browser requests must include credentials.

## Routes

| Method and path | Permission / behavior |
| --- | --- |
| `POST /auth/register` | Public, rate limited; creates an organization-scoped Citizen account and profile |
| `POST /auth/login` | Credentials and organization slug; rate limited |
| `GET /auth/me`, `POST /auth/logout` | Authenticated session |
| `GET /cases` | `complaint.view`; server scope, filters, sorting and pagination |
| `POST /cases` | `complaint.create`; citizen case creation, server ID, routing and SLA snapshot |
| `GET /cases/categories` | `complaint.view`; active categories and subcategories |
| `GET /cases/:caseId` | `complaint.view`; authorized case detail, history, comments and attachments metadata |
| `PATCH /cases/:caseId/status` | `complaint.assign`, `.resolve` or `.close` depending on target status |
| `POST /cases/:caseId/assignments` | `complaint.assign`; assignment/reassignment |
| `POST /cases/:caseId/comments` | `complaint.comment`; internal notes additionally require `complaint.assign` |
| `POST /cases/:caseId/escalations` | `complaint.escalate`; manual escalation |
| `POST /cases/:caseId/attachments` | `complaint.create` or `.comment`; multipart `files`, PDF/JPEG/PNG, up to five and 10 MiB each |
| `GET /attachments/:attachmentId` | `complaint.view` plus case/tenant scope; access-controlled download |
| `GET /departments`, `GET /regions` | `complaint.view`; current organization only |
| `GET /assignment-options` | `complaint.assign`; active users and teams in the authorized scope |
| `GET /analytics?from=YYYY-MM-DD&to=YYYY-MM-DD` | `report.view`; organization and role scope |
| `GET /users`, `GET /permissions`, `GET /roles` | `user.manage` |
| `PUT /roles/:roleId/permissions` | `user.manage`; tenant-local role and known permissions |
| `GET /workflow/routing-rules`, `POST /workflow/routing-rules`, `PUT /workflow/routing-rules/:ruleId`, `PATCH /workflow/routing-rules/:ruleId/active` | `workflow.manage` |
| `GET /workflow/fallback-queue`, `PUT /workflow/fallback-queue` | `workflow.manage` |
| `GET /sla-policies`, `POST /sla-policies`, `PUT /sla-policies/:policyId`, `GET /automation/runs` | `sla.manage` |
| `GET /notifications`, `PATCH /notifications/:notificationId/read` | Authenticated user; own notifications only |
| `GET /audit-logs?page=&pageSize=&action=` | `audit.view`; tenant-scoped, paginated |

Case listing accepts `status`, `priority`, `categoryId`, `departmentId`, `q`, `sortBy` (`createdAt`, `updatedAt`, `slaDueAt`, `priority`, `status`), `sortOrder`, `page` and `pageSize` (maximum 100). Responses include `pagination` with total and pages.

Status transitions are constrained: Submitted → In review; In review → In progress or Resolved; In progress → In review or Resolved; Resolved → In progress or Closed; Closed is terminal. The permission corresponding to the requested transition is checked before updating. Invalid transitions return `409 INVALID_STATUS_TRANSITION`.

All endpoints trust session-derived tenant scope only. See [Security](SECURITY.md) for the current controls and limitations. The API currently does not expose CRUD endpoints for users/departments or public unauthenticated citizen intake.
