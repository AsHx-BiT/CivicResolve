import { beforeAll, describe, expect, it, vi } from "vitest";
import request from "supertest";
import { createApp } from "./app";
import { hashPassword, hashToken } from "./security";

const orgId = "org-pune";
const citizenId = "citizen-user";
const citizenProfileId = "citizen-profile";
const csrf = "a".repeat(64);
let passwordHash: string;

beforeAll(async () => { passwordHash = await hashPassword("integration-test-password"); });

function makeDatabase(configuration: { roles?: string[]; permissions?: string[]; citizen?: boolean; caseResult?: any; caseRows?: any[]; caseTotal?: number; routingRules?: any[]; slaPolicies?: any[]; fallbackTeamId?: string | null; assignmentUser?: any } = {}) {
  const roles = configuration.roles ?? ["CITIZEN"];
  const permissions = configuration.permissions ?? ["complaint.view", "complaint.create", "complaint.comment"];
  const roleLinks = roles.map((code) => ({ role: { code, permissions: permissions.map((permission) => ({ permission: { code: permission } })) } }));
  const citizenProfile = configuration.citizen === false ? null : { id: citizenProfileId };
  const user = { id: citizenId, organizationId: orgId, email: "asha@example.test", fullName: "Asha Kulkarni", status: "ACTIVE", passwordHash, departmentId: null, organization: { id: orgId, name: "Pune Municipal Services", slug: "pune-municipal-services", isActive: true }, roles: roleLinks, citizenProfile };
  const session = { id: "session-1", organizationId: orgId, userId: citizenId, csrfHash: hashToken(csrf), expiresAt: new Date(Date.now() + 60_000), revokedAt: null, organization: user.organization, user: { ...user } };
  const db: any = {
    $queryRaw: vi.fn().mockResolvedValue([{ "?column?": 1 }]),
    $transaction: vi.fn(async (callback: (tx: any) => unknown) => callback(db)),
    user: { findFirst: vi.fn().mockImplementation(async ({ where }: any) => where?.email ? user : configuration.assignmentUser ?? user) },
    userSession: { create: vi.fn(async ({ data }: any) => { session.csrfHash = data.csrfHash; return { id: session.id }; }), findUnique: vi.fn().mockResolvedValue(session), update: vi.fn().mockResolvedValue({}) },
    auditLog: { create: vi.fn().mockResolvedValue({ id: "audit-1" }) },
    role: { findMany: vi.fn().mockResolvedValue([]), findFirst: vi.fn().mockResolvedValue({ id: "role-1" }) },
    permission: { findMany: vi.fn().mockResolvedValue([]) },
    rolePermission: { deleteMany: vi.fn(), createMany: vi.fn() },
    complaintCase: { findMany: vi.fn().mockResolvedValue(configuration.caseRows ?? []), count: vi.fn().mockResolvedValue(configuration.caseTotal ?? 0), groupBy: vi.fn().mockResolvedValue([]), findFirst: vi.fn().mockImplementation(async ({ where }: any) => where.organizationId === orgId && (!where.citizenProfileId || where.citizenProfileId === citizenProfileId) ? configuration.caseResult ?? null : null), create: vi.fn().mockResolvedValue({ id: "case-1", referenceNumber: "PMS-2026-TEST" }), update: vi.fn().mockResolvedValue({ id: "case-1" }) },
    category: { findFirst: vi.fn().mockResolvedValue({ id: "category-1" }), findMany: vi.fn().mockResolvedValue([]) },
    region: { findFirst: vi.fn().mockResolvedValue({ id: "region-1" }) },
    routingRule: { findMany: vi.fn().mockResolvedValue(configuration.routingRules ?? []), findFirst: vi.fn().mockResolvedValue(null) },
    organization: { findFirst: vi.fn().mockResolvedValue({ fallbackTeamId: configuration.fallbackTeamId ?? null }), findMany: vi.fn().mockResolvedValue([]) },
    subcategory: { findFirst: vi.fn().mockResolvedValue({ id: "subcategory-1" }) },
    sLAPolicy: { findFirst: vi.fn().mockResolvedValue(null), findMany: vi.fn().mockResolvedValue(configuration.slaPolicies ?? []) },
    statusHistory: { create: vi.fn().mockResolvedValue({}) },
    notification: { create: vi.fn().mockResolvedValue({}) },
    teamMembership: { findMany: vi.fn().mockResolvedValue([]) },
    assignment: { create: vi.fn().mockResolvedValue({ id: "assignment-1" }), updateMany: vi.fn() },
    team: { findFirst: vi.fn().mockResolvedValue({ id: "team-1" }) },
    comment: { create: vi.fn().mockResolvedValue({ id: "comment-1" }) },
    escalation: { create: vi.fn().mockResolvedValue({ id: "escalation-1" }), count: vi.fn().mockResolvedValue(0) },
    attachment: { findFirst: vi.fn().mockResolvedValue(null) },
  };
  return db;
}

function appFor(db: any) { return createApp(db, { logger: { info: vi.fn(), error: vi.fn() } }); }
async function citizenCookies(app: ReturnType<typeof appFor>) {
  const response = await request(app).post("/api/v1/auth/login").send({ organizationSlug: "pune-municipal-services", email: "asha@example.test", password: "integration-test-password" });
  expect(response.status).toBe(200);
  const cookies = response.headers["set-cookie"];
  const cookieList = Array.isArray(cookies) ? cookies : cookies ? [cookies] : [];
  const sessionCookie = cookieList.find((item) => item.startsWith("civic_session="))!;
  const csrfCookie = cookieList.find((item) => item.startsWith("civic_csrf="))!;
  const token = decodeURIComponent(csrfCookie.match(/^civic_csrf=([^;]+)/)![1]!);
  return { cookie: `${sessionCookie.split(";")[0]}; ${csrfCookie.split(";")[0]}`, csrf: token, response };
}

describe("CivicResolve v1 tenant API", () => {
  it("requires authentication, hashes passwords and issues protected sessions", async () => {
    const db = makeDatabase(); const app = appFor(db);
    const unauthenticated = await request(app).get("/api/v1/cases");
    expect(unauthenticated.status).toBe(401);
    expect(unauthenticated.body.error.code).toBe("AUTHENTICATION_REQUIRED");
    const { cookie, response } = await citizenCookies(app);
    const setCookies = response.headers["set-cookie"];
    const cookieText = (Array.isArray(setCookies) ? setCookies : [setCookies ?? ""]).join("|");
    expect(cookieText).toContain("HttpOnly");
    expect(cookieText).toContain("SameSite=Strict");
    expect(db.userSession.create.mock.calls[0]![0].data.tokenHash).not.toBe(cookie.split(";")[0]!.split("=")[1]);
    const me = await request(app).get("/api/v1/auth/me").set("Cookie", cookie);
    expect(me.status).toBe(200);
    expect(me.body.data.user.roles).toContain("CITIZEN");
  });

  it("returns a request ID and structured error for malformed JSON", async () => {
    const app = appFor(makeDatabase());
    const response = await request(app).post("/api/v1/auth/login").set("Content-Type", "application/json").send("{");
    expect(response.status).toBe(400);
    expect(response.headers["x-request-id"]).toBeTruthy();
    expect(response.body.error.code).toBe("INVALID_REQUEST");
    expect(response.body.requestId).toBe(response.headers["x-request-id"]);
  });

  it("reports a database credential/connection failure as a service-unavailable response", async () => {
    const db = makeDatabase();
    db.user.findFirst.mockRejectedValue(Object.assign(new Error("private database connection details"), { name: "PrismaClientInitializationError" }));
    const response = await request(appFor(db)).post("/api/v1/auth/login").send({ organizationSlug: "pune-municipal-services", email: "asha@example.test", password: "integration-test-password" });
    expect(response.status).toBe(503);
    expect(response.body.error.code).toBe("DATABASE_UNAVAILABLE");
    expect(response.body.error.message).toContain("DATABASE_URL");
    expect(response.body.error.message).not.toContain("private database connection details");
  });

  it("enforces permissions before reading cases", async () => {
    const db = makeDatabase({ permissions: [] }); const app = appFor(db); const { cookie } = await citizenCookies(app);
    const response = await request(app).get("/api/v1/cases").set("Cookie", cookie);
    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe("PERMISSION_DENIED");
    expect(db.complaintCase.findMany).not.toHaveBeenCalled();
  });

  it("creates a case in the authenticated tenant and rejects a client organization override", async () => {
    const db = makeDatabase(); const app = appFor(db); const { cookie, csrf: token } = await citizenCookies(app);
    const created = await request(app).post("/api/v1/cases").set("Cookie", cookie).set("X-CSRF-Token", token).send({ title: "Broken streetlight outside the library", description: "The streetlight has been out for four nights and the walkway is very dark.", categoryId: "category-1", priority: "HIGH", location: "Shivajinagar" });
    expect(created.status).toBe(201);
    const createData = db.complaintCase.create.mock.calls[0]![0].data;
    expect(createData.referenceNumber).toMatch(/^PMS-\d{4}-[A-F0-9]{8}$/);
    expect(createData.organizationId).toBe(orgId);
    expect(createData.citizenProfileId).toBe(citizenProfileId);
    expect(db.auditLog.create).toHaveBeenCalled();
    const injected = await request(app).post("/api/v1/cases").set("Cookie", cookie).set("X-CSRF-Token", token).send({ title: "Broken streetlight outside the library", description: "The streetlight has been out for four nights and the walkway is very dark.", categoryId: "category-1", organizationId: "another-tenant" });
    expect(injected.status).toBe(400);
    expect(db.complaintCase.create).toHaveBeenCalledTimes(1);
  });

  it("denies a citizen access to another tenant's or another citizen's case", async () => {
    const db = makeDatabase(); const app = appFor(db); const { cookie } = await citizenCookies(app);
    const response = await request(app).get("/api/v1/cases/case-from-another-tenant").set("Cookie", cookie);
    expect(response.status).toBe(404);
    expect(db.complaintCase.findFirst.mock.calls[0]![0].where).toEqual({ organizationId: orgId, citizenProfileId: citizenProfileId, id: "case-from-another-tenant" });
  });

  it("returns the stored chronological status history for a visible case", async () => {
    const historyAt = new Date("2026-05-01T10:00:00.000Z");
    const db = makeDatabase({ permissions: ["complaint.view"], caseResult: { id: "case-1", referenceNumber: "PMS-2026-TEST", status: "IN_PROGRESS", createdAt: historyAt, statusHistory: [{ id: "history-1", fromStatus: "IN_REVIEW", toStatus: "IN_PROGRESS", note: "Crew dispatched", createdAt: historyAt, changedBy: { fullName: "Rohan Deshmukh" } }], comments: [], assignments: [], escalations: [], attachments: [] } });
    const app = appFor(db); const { cookie } = await citizenCookies(app);
    const response = await request(app).get("/api/v1/cases/case-1").set("Cookie", cookie);
    expect(response.status).toBe(200);
    expect(response.body.data.statusHistory[0]).toMatchObject({ fromStatus: "IN_REVIEW", toStatus: "IN_PROGRESS", note: "Crew dispatched", changedBy: { fullName: "Rohan Deshmukh" } });
  });

  it("denies unauthorized routing-rule changes before touching configuration data", async () => {
    const db = makeDatabase(); const app = appFor(db); const { cookie, csrf: token } = await citizenCookies(app);
    const response = await request(app).put("/api/v1/workflow/routing-rules/rule-1").set("Cookie", cookie).set("X-CSRF-Token", token).send({ name: "Attempted route", departmentId: "dept-1", priority: 10, isActive: true });
    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe("PERMISSION_DENIED");
    expect(db.routingRule.findFirst).not.toHaveBeenCalled();
  });

  it("revokes a session on logout and clears both authentication cookies", async () => {
    const db = makeDatabase(); const app = appFor(db); const { cookie, csrf: token } = await citizenCookies(app);
    const response = await request(app).post("/api/v1/auth/logout").set("Cookie", cookie).set("X-CSRF-Token", token).send({});
    expect(response.status).toBe(200);
    expect(response.body.data.loggedOut).toBe(true);
    expect(db.userSession.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ revokedAt: expect.any(Date) }) }));
    expect(response.headers["set-cookie"]?.toString()).toContain("Max-Age=0");
  });

  it("applies server-side case filters, sorting and pagination", async () => {
    const db = makeDatabase({ permissions: ["complaint.view"], caseRows: [{ id: "case-1", referenceNumber: "PMS-2026-TEST", status: "IN_PROGRESS", priority: "HIGH", createdAt: new Date(), slaDueAt: null }], caseTotal: 42 });
    const app = appFor(db); const { cookie } = await citizenCookies(app);
    const response = await request(app).get("/api/v1/cases?status=IN_PROGRESS&priority=HIGH&page=2&pageSize=10&sortBy=slaDueAt&sortOrder=asc").set("Cookie", cookie);
    expect(response.status).toBe(200);
    expect(response.body.pagination).toEqual({ page: 2, pageSize: 10, total: 42, pages: 5 });
    expect(db.complaintCase.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ organizationId: orgId, citizenProfileId, status: "IN_PROGRESS", priority: "HIGH" }), skip: 10, take: 10, orderBy: { slaDueAt: "asc" } }));
  });

  it("records an allowed status transition and rejects an invalid transition", async () => {
    const db = makeDatabase({ permissions: ["complaint.view", "complaint.assign", "complaint.close"], caseResult: { id: "case-1", status: "SUBMITTED", citizenProfile: { userId: citizenId } } });
    const app = appFor(db); const { cookie, csrf: token } = await citizenCookies(app);
    const allowed = await request(app).patch("/api/v1/cases/case-1/status").set("Cookie", cookie).set("X-CSRF-Token", token).send({ status: "IN_REVIEW", note: "Triage started" });
    expect(allowed.status).toBe(200);
    expect(db.statusHistory.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ fromStatus: "SUBMITTED", toStatus: "IN_REVIEW", note: "Triage started" }) }));
    const denied = await request(app).patch("/api/v1/cases/case-1/status").set("Cookie", cookie).set("X-CSRF-Token", token).send({ status: "CLOSED" });
    expect(denied.status).toBe(409);
    expect(denied.body.error.code).toBe("INVALID_STATUS_TRANSITION");
    expect(db.complaintCase.update).toHaveBeenCalledTimes(1);
  });

  it("keeps attachment lookup tenant-scoped and denies missing cross-tenant attachments", async () => {
    const db = makeDatabase(); const app = appFor(db); const { cookie } = await citizenCookies(app);
    const response = await request(app).get("/api/v1/attachments/attachment-from-another-tenant").set("Cookie", cookie);
    expect(response.status).toBe(404);
    expect(db.attachment.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "attachment-from-another-tenant", organizationId: orgId } }));
  });

  it("denies cross-tenant case modification before creating an assignment", async () => {
    const db = makeDatabase({ permissions: ["complaint.view", "complaint.assign"], caseResult: null }); const app = appFor(db); const { cookie, csrf: token } = await citizenCookies(app);
    const response = await request(app).post("/api/v1/cases/case-from-another-tenant/assignments").set("Cookie", cookie).set("X-CSRF-Token", token).send({ teamId: "team-1" });
    expect(response.status).toBe(404);
    expect(db.assignment.create).not.toHaveBeenCalled();
    expect(db.auditLog.create.mock.calls.some(([call]: any[]) => call.data.action === "case.assigned")).toBe(false);
  });

  it("rejects an attachment whose bytes do not match its declared image type", async () => {
    const db = makeDatabase({ caseResult: { id: "case-1" } }); const app = appFor(db); const { cookie, csrf: token } = await citizenCookies(app);
    const response = await request(app).post("/api/v1/cases/case-1/attachments").set("Cookie", cookie).set("X-CSRF-Token", token).attach("files", Buffer.from("this is not a PNG image"), { filename: "photo.png", contentType: "image/png" });
    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe("ATTACHMENT_CONTENT_INVALID");
    expect(db.attachment.findFirst).not.toHaveBeenCalled();
  });

  it("enforces the attachment count and 10 MiB per-file limits", async () => {
    const db = makeDatabase({ caseResult: { id: "case-1" } }); const app = appFor(db); const { cookie, csrf: token } = await citizenCookies(app);
    let tooMany = request(app).post("/api/v1/cases/case-1/attachments").set("Cookie", cookie).set("X-CSRF-Token", token);
    for (let index = 0; index < 6; index++) tooMany = tooMany.attach("files", Buffer.from("%PDF-1.7\n"), { filename: `file-${index}.pdf`, contentType: "application/pdf" });
    const countResponse = await tooMany;
    expect(countResponse.status).toBe(413);
    const oversized = Buffer.alloc(10 * 1024 * 1024 + 1, 65);
    const sizeResponse = await request(app).post("/api/v1/cases/case-1/attachments").set("Cookie", cookie).set("X-CSRF-Token", token).attach("files", oversized, { filename: "large.pdf", contentType: "application/pdf" });
    expect(sizeResponse.status).toBe(413);
  });

  it("assigns a case to a tenant-local team and audits the assignment", async () => {
    const db = makeDatabase({ roles: ["ORGANIZATION_ADMINISTRATOR"], permissions: ["complaint.assign"], citizen: false, caseResult: { id: "case-1", departmentId: "department-1" } });
    const app = appFor(db); const { cookie, csrf: token } = await citizenCookies(app);
    const response = await request(app).post("/api/v1/cases/case-1/assignments").set("Cookie", cookie).set("X-CSRF-Token", token).send({ teamId: "team-1", note: "Route to service team" });
    expect(response.status).toBe(201);
    expect(db.team.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "team-1", organizationId: orgId } }));
    expect(db.auditLog.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ action: "case.assigned", caseId: "case-1" }) }));
  });

  it("assigns a case to an active tenant-local officer", async () => {
    const db = makeDatabase({ roles: ["ORGANIZATION_ADMINISTRATOR"], permissions: ["complaint.assign"], citizen: false, caseResult: { id: "case-1", departmentId: "dept-roads" }, assignmentUser: { id: "officer-2", departmentId: "dept-roads" } });
    const app = appFor(db); const { cookie, csrf: token } = await citizenCookies(app);
    const response = await request(app).post("/api/v1/cases/case-1/assignments").set("Cookie", cookie).set("X-CSRF-Token", token).send({ assignedToUserId: "officer-2", note: "Officer dispatch" });
    expect(response.status).toBe(201);
    expect(db.user.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "officer-2", organizationId: orgId, status: "ACTIVE" }, select: { id: true, departmentId: true } }));
    expect(db.assignment.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ assignedToUserId: "officer-2", departmentId: "dept-roads" }) }));
  });

  it("scopes analytics report queries to the authenticated organization", async () => {
    const db = makeDatabase({ roles: ["ORGANIZATION_ADMINISTRATOR"], permissions: ["report.view"], citizen: false });
    const app = appFor(db); const { cookie } = await citizenCookies(app);
    const response = await request(app).get("/api/v1/analytics").set("Cookie", cookie);
    expect(response.status).toBe(200);
    expect(db.complaintCase.count).toHaveBeenCalledWith(expect.objectContaining({ where: { organizationId: orgId } }));
    expect(db.complaintCase.groupBy).toHaveBeenCalledWith(expect.objectContaining({ where: { organizationId: orgId } }));
    expect(db.escalation.count).toHaveBeenCalledWith(expect.objectContaining({ where: { organizationId: orgId, complaintCase: { organizationId: orgId } } }));
  });

  it("uses a matched route and snapshots the selected SLA at case creation", async () => {
    const db = makeDatabase({
      routingRules: [{ id: "route-roads", name: "Roads queue", categoryId: "category-1", regionId: "region-1", wardCode: "14", severity: "HIGH", casePriority: "HIGH", departmentId: "dept-roads", teamId: "team-roads", priority: 10, isActive: true }],
      slaPolicies: [{ id: "sla-high", name: "High · 24 hours", categoryId: null, departmentId: "dept-roads", severity: "HIGH", priority: "HIGH", responseMinutes: 120, resolutionMinutes: 1440, isActive: true }],
    });
    const app = appFor(db); const { cookie, csrf: token } = await citizenCookies(app);
    const response = await request(app).post("/api/v1/cases").set("Cookie", cookie).set("X-CSRF-Token", token).send({ title: "Broken streetlight at ward office", description: "The streetlight has been off on the footpath outside the ward office for several nights.", categoryId: "category-1", priority: "HIGH", severity: "HIGH", regionId: "region-1", wardCode: "14" });
    expect(response.status).toBe(201);
    expect(response.body.routing).toEqual({ ruleId: "route-roads", fallbackUsed: false, assigned: true });
    const create = db.complaintCase.create.mock.calls[0]![0].data;
    expect(create.departmentId).toBe("dept-roads");
    expect(create.slaPolicyId).toBe("sla-high");
    expect(create.slaPolicyNameSnapshot).toBe("High · 24 hours");
    expect(create.slaPolicySnapshot).toMatchObject({ id: "sla-high", severity: "HIGH", priority: "HIGH", resolutionMinutes: 1440 });
    expect(create.slaDurationMinutesSnapshot).toBe(1440);
    expect(db.assignment.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ routingRuleId: "route-roads", teamId: "team-roads", assignedByUserId: null }) }));
    expect(db.auditLog.create.mock.calls.some(([call]: any[]) => call.data.action === "workflow.route.matched")).toBe(true);
  });

  it("routes an unmatched case only to the explicitly configured fallback team", async () => {
    const db = makeDatabase({ fallbackTeamId: "fallback-team" });
    const app = appFor(db); const { cookie, csrf: token } = await citizenCookies(app);
    const response = await request(app).post("/api/v1/cases").set("Cookie", cookie).set("X-CSRF-Token", token).send({ title: "Roadside issue in ward", description: "A civic issue has been reported near the central bus stop.", categoryId: "category-1" });
    expect(response.status).toBe(201);
    expect(response.body.routing.fallbackUsed).toBe(true);
    expect(db.assignment.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ teamId: "fallback-team", routingRuleId: null }) }));
  });
});
