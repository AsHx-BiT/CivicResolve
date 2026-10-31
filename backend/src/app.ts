import express, { type ErrorRequestHandler, type Request, type Response, type NextFunction } from "express";
import cors from "cors";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import multer from "multer";
import { calculateSlaDeadline, evaluateSla, LocalNotificationProvider, matchRoutingRule, resolveRoutingTarget } from "./automation";
import { z } from "zod";
import type { Prisma, PrismaClient } from "@prisma/client";
import { hashPassword, hashToken, newOpaqueToken, verifyPassword } from "./security";

// Prisma is injected so HTTP integration tests can exercise the authorization boundary.
export type DatabaseClient = PrismaClient;
type AuthContext = {
  userId: string; organizationId: string; sessionId: string; csrfHash: string;
  organizationName: string; organizationSlug: string; email: string; fullName: string; roles: string[]; permissions: Set<string>;
  citizenProfileId: string | null; departmentId: string | null;
};
type RequestWithAuth = Request & { auth?: AuthContext; requestId?: string };

const loginSchema = z.object({ organizationSlug: z.string().trim().min(2).max(100), email: z.email(), password: z.string().min(1).max(200) }).strict();
const citizenRegistrationSchema = z.object({
  organizationSlug: z.string().trim().toLowerCase().min(2).max(100),
  fullName: z.string().trim().min(2).max(120),
  email: z.email().trim().toLowerCase().max(254),
  phone: z.string().trim().max(30).optional(),
  password: z.string().min(12).max(200),
}).strict();
const createCaseSchema = z.object({
  title: z.string().trim().min(5).max(160), description: z.string().trim().min(10).max(5000),
  categoryId: z.string().min(1), subcategoryId: z.string().min(1).optional(),
  priority: z.enum(["LOW", "MEDIUM", "HIGH", "URGENT"]).default("MEDIUM"), location: z.string().trim().max(200).optional(),
  severity: z.enum(["LOW", "MEDIUM", "HIGH", "CRITICAL"]).optional(), regionId: z.string().min(1).optional(), wardCode: z.string().trim().max(40).optional(),
  latitude: z.coerce.number().min(-90).max(90).optional(), longitude: z.coerce.number().min(-180).max(180).optional(),
}).strict();
const statusSchema = z.object({ status: z.enum(["IN_REVIEW", "IN_PROGRESS", "RESOLVED", "CLOSED"]), note: z.string().trim().max(1000).optional() }).strict();
const assignmentSchema = z.object({ assignedToUserId: z.string().min(1).optional(), teamId: z.string().min(1).optional(), note: z.string().trim().max(1000).optional() })
  .strict().refine((value) => value.assignedToUserId || value.teamId, { message: "A user or team must be assigned" });
const commentSchema = z.object({ body: z.string().trim().min(1).max(5000), isInternal: z.boolean().default(false) }).strict();
const escalationSchema = z.object({ reason: z.string().trim().min(5).max(2000), level: z.number().int().min(1).max(5).default(1) }).strict();
const rolePermissionSchema = z.object({ permissionCodes: z.array(z.string().min(1)).max(100) }).strict();
const routingRuleSchema = z.object({ name: z.string().trim().min(2).max(120), categoryId: z.string().min(1).nullable().optional(), departmentId: z.string().min(1).nullable().optional(), teamId: z.string().min(1).nullable().optional(), regionId: z.string().min(1).nullable().optional(), wardCode: z.string().trim().max(40).nullable().optional(), severity: z.enum(["LOW", "MEDIUM", "HIGH", "CRITICAL"]).nullable().optional(), casePriority: z.enum(["LOW", "MEDIUM", "HIGH", "URGENT"]).nullable().optional(), priority: z.number().int().min(0).max(10000).default(100), isActive: z.boolean().default(true), conditions: z.record(z.string(), z.unknown()).optional() }).strict().refine((value) => value.departmentId || value.teamId, { message: "A department or team is required" });
const slaPolicySchema = z.object({ name: z.string().trim().min(2).max(120), categoryId: z.string().min(1).nullable().optional(), departmentId: z.string().min(1).nullable().optional(), severity: z.enum(["LOW", "MEDIUM", "HIGH", "CRITICAL"]).nullable().optional(), priority: z.enum(["LOW", "MEDIUM", "HIGH", "URGENT"]).nullable().optional(), responseMinutes: z.number().int().min(1).max(525600), resolutionMinutes: z.number().int().min(1).max(525600), isActive: z.boolean().default(true) }).strict();
const caseStatuses = ["SUBMITTED", "IN_REVIEW", "IN_PROGRESS", "RESOLVED", "CLOSED"] as const;
const priorities = ["LOW", "MEDIUM", "HIGH", "URGENT"] as const;
const authenticatedUserInclude = {
  organization: true,
  department: true,
  citizenProfile: true,
  roles: { include: { role: { include: { permissions: { include: { permission: true } } } } } },
};

function sendError(res: Response, status: number, code: string, message: string, details?: unknown) {
  res.status(status).json({ error: { code, message, ...(details ? { details } : {}) }, requestId: (res.req as RequestWithAuth).requestId });
}
function severityForPriority(priority: string): "LOW" | "MEDIUM" | "HIGH" | "CRITICAL" { return priority === "URGENT" ? "CRITICAL" : priority as "LOW" | "MEDIUM" | "HIGH"; }
function attachmentSignatureMatches(file: Express.Multer.File) {
  const bytes = file.buffer;
  if (file.mimetype === "application/pdf") return bytes.subarray(0, 5).toString("ascii") === "%PDF-";
  if (file.mimetype === "image/png") return bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  if (file.mimetype === "image/jpeg") return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  return false;
}
function caseResponse<T extends Record<string, any>>(item: T, now = new Date()) {
  const escalated = (item.escalations ?? []).some((event: any) => event.source === "MANUAL" || event.dedupeKey?.endsWith(":breached") || event.dedupeKey?.endsWith(":extended-breach"));
  return { ...item, slaMetrics: evaluateSla({ startedAt: item.slaStartedAt ?? item.createdAt, dueAt: item.slaDueAt, durationMinutes: item.slaDurationMinutesSnapshot, now, escalated }) };
}
function parseCookies(header = ""): Record<string, string> {
  return Object.fromEntries(header.split(";").flatMap((part) => {
    const index = part.indexOf("=");
    if (index < 0) return [];
    const key = part.slice(0, index).trim();
    try { return [[key, decodeURIComponent(part.slice(index + 1).trim())]]; } catch { return []; }
  }));
}
function cookieOptions(maxAgeSeconds: number) {
  const secure = process.env.COOKIE_SECURE === "true" || process.env.NODE_ENV === "production";
  return `Path=/api/v1; HttpOnly; SameSite=Strict; Max-Age=${maxAgeSeconds}${secure ? "; Secure" : ""}`;
}
function csrfCookieOptions(maxAgeSeconds: number) {
  const secure = process.env.COOKIE_SECURE === "true" || process.env.NODE_ENV === "production";
  return `Path=/; SameSite=Strict; Max-Age=${maxAgeSeconds}${secure ? "; Secure" : ""}`;
}
function userSummary(auth: AuthContext) {
  return { id: auth.userId, email: auth.email, fullName: auth.fullName, roles: auth.roles, permissions: [...auth.permissions], organizationId: auth.organizationId, citizenProfileId: auth.citizenProfileId, departmentId: auth.departmentId };
}
async function caseScopeWhere(db: DatabaseClient, auth: AuthContext): Promise<any | null> {
  const where: any = { organizationId: auth.organizationId };
  if (auth.roles.includes("CITIZEN")) return auth.citizenProfileId ? { ...where, citizenProfileId: auth.citizenProfileId } : null;
  if (auth.roles.includes("DEPARTMENT_MANAGER")) return auth.departmentId ? { ...where, departmentId: auth.departmentId } : null;
  const organizationWide = ["SUPERVISOR", "SENIOR_AUTHORITY", "ORGANIZATION_ADMINISTRATOR", "AUDITOR"].some((role) => auth.roles.includes(role));
  if (organizationWide) return where;
  if (auth.roles.includes("OFFICER") && !organizationWide) {
    const memberships = await db.teamMembership.findMany({ where: { organizationId: auth.organizationId, userId: auth.userId }, select: { teamId: true } });
    const OR: any[] = [{ assignedToUserId: auth.userId }];
    if (memberships.length) OR.push({ teamId: { in: memberships.map((item: any) => item.teamId) } });
    where.assignments = { some: { organizationId: auth.organizationId, endedAt: null, OR } };
    return where;
  }
  return null;
}

export function createApp(db: DatabaseClient, options: { rateLimitMax?: number; logger?: Pick<Console, "info" | "error"> } = {}) {
  const app = express();
  const logger = options.logger ?? console;
  const origins = (process.env.CORS_ORIGIN ?? "http://localhost:5173").split(",").map((origin) => origin.trim());
  app.disable("x-powered-by");
  app.use(helmet());
  app.use(cors({ origin: origins, credentials: true, allowedHeaders: ["Content-Type", "X-CSRF-Token"], methods: ["GET", "POST", "PATCH", "PUT", "DELETE", "OPTIONS"] }));
  app.use((req: RequestWithAuth, res, next) => {
    req.requestId = randomUUID();
    res.setHeader("X-Request-ID", req.requestId);
    logger.info(`${req.method} ${req.path} ${req.requestId}`);
    next();
  });
  app.use(express.json({ limit: "1mb" }));
  const defaultApiRateLimit = process.env.NODE_ENV === "production" ? 300 : 3000;
  app.use("/api", rateLimit({ windowMs: Number(process.env.API_RATE_LIMIT_WINDOW_MS) || 15 * 60_000, limit: options.rateLimitMax ?? (Number(process.env.API_RATE_LIMIT_MAX) || defaultApiRateLimit), standardHeaders: "draft-8", legacyHeaders: false, handler: (_req, res) => sendError(res, 429, "RATE_LIMITED", "Too many requests. Try again later.") }));
  app.get("/health", async (_req, res) => {
    try { await db.$queryRaw`SELECT 1`; res.json({ status: "ok", application: "healthy", database: "connected", timestamp: new Date().toISOString() }); }
    catch { res.status(503).json({ status: "degraded", application: "healthy", database: "unavailable", timestamp: new Date().toISOString() }); }
  });

  const loginLimiter = rateLimit({ windowMs: 15 * 60_000, limit: 10, standardHeaders: "draft-8", legacyHeaders: false, handler: (_req, res) => sendError(res, 429, "LOGIN_RATE_LIMITED", "Too many sign-in attempts. Try again later.") });
  const registrationLimiter = rateLimit({ windowMs: 60 * 60_000, limit: 5, standardHeaders: "draft-8", legacyHeaders: false, handler: (_req, res) => sendError(res, 429, "REGISTRATION_RATE_LIMITED", "Too many account registration attempts. Try again later.") });
  app.post("/api/v1/auth/register", registrationLimiter, async (req: RequestWithAuth, res) => {
    const parsed = citizenRegistrationSchema.safeParse(req.body);
    if (!parsed.success) return sendError(res, 400, "VALIDATION_ERROR", "Enter a name, valid email, and password with at least 12 characters.", z.flattenError(parsed.error).fieldErrors);
    const origin = req.get("origin");
    if (origin && !origins.includes(origin)) return sendError(res, 403, "ORIGIN_DENIED", "Request origin is not allowed.");

    const input = parsed.data;
    const organization = await db.organization.findFirst({ where: { slug: input.organizationSlug, isActive: true }, select: { id: true } });
    if (!organization) return sendError(res, 404, "ORGANIZATION_NOT_FOUND", "The selected organization is not available for registration.");
    const citizenRole = await db.role.findFirst({ where: { organizationId: organization.id, code: "CITIZEN" }, select: { id: true } });
    if (!citizenRole) return sendError(res, 503, "REGISTRATION_UNAVAILABLE", "Citizen registration is not configured for this organization.");

    const passwordHash = await hashPassword(input.password);
    try {
      const user = await db.$transaction(async (tx: Prisma.TransactionClient) => {
        const created = await tx.user.create({ data: { organizationId: organization.id, email: input.email, fullName: input.fullName, phone: input.phone || null, passwordHash } });
        await tx.userRole.create({ data: { organizationId: organization.id, userId: created.id, roleId: citizenRole.id } });
        await tx.citizenProfile.create({ data: { organizationId: organization.id, userId: created.id } });
        await tx.auditLog.create({ data: { organizationId: organization.id, actorUserId: created.id, action: "auth.citizen.registered", entityType: "User", entityId: created.id, metadata: {}, ipAddress: req.ip, userAgent: req.get("user-agent") } });
        return created;
      });
      return res.status(201).json({ data: { registered: true, email: user.email } });
    } catch (error) {
      if (typeof error === "object" && error !== null && "code" in error && error.code === "P2002") {
        return sendError(res, 409, "EMAIL_ALREADY_REGISTERED", "An account with this email already exists in this organization. Sign in or use another email.");
      }
      throw error;
    }
  });
  app.post("/api/v1/auth/login", loginLimiter, async (req: RequestWithAuth, res) => {
    const parsed = loginSchema.safeParse(req.body);
    if (!parsed.success) return sendError(res, 400, "VALIDATION_ERROR", "Invalid login details.", z.flattenError(parsed.error).fieldErrors);
    const origin = req.get("origin");
    if (origin && !origins.includes(origin)) return sendError(res, 403, "ORIGIN_DENIED", "Request origin is not allowed.");
    const input = parsed.data;
    const user = await db.user.findFirst({ where: { email: input.email.toLowerCase(), status: "ACTIVE", organization: { slug: input.organizationSlug, isActive: true } }, include: authenticatedUserInclude });
    if (!user || !(await verifyPassword(input.password, user.passwordHash))) return sendError(res, 401, "INVALID_CREDENTIALS", "Email or password is incorrect.");
    const token = newOpaqueToken(); const csrfToken = newOpaqueToken();
    const ttl = Math.min(Math.max(Number(process.env.SESSION_TTL_HOURS) || 12, 1), 24 * 7);
    const expiresAt = new Date(Date.now() + ttl * 60 * 60 * 1000);
    const session = await db.$transaction(async (tx: Prisma.TransactionClient) => {
      const created = await tx.userSession.create({ data: { organizationId: user.organizationId, userId: user.id, tokenHash: hashToken(token), csrfHash: hashToken(csrfToken), expiresAt, userAgent: req.get("user-agent")?.slice(0, 500), ipAddress: req.ip } });
      await tx.auditLog.create({ data: { organizationId: user.organizationId, actorUserId: user.id, action: "auth.session.created", entityType: "UserSession", entityId: created.id, metadata: {}, ipAddress: req.ip, userAgent: req.get("user-agent") } });
      return created;
    });
    res.setHeader("Set-Cookie", [
      `civic_session=${encodeURIComponent(token)}; ${cookieOptions(ttl * 3600)}`,
      `civic_csrf=${encodeURIComponent(csrfToken)}; ${csrfCookieOptions(ttl * 3600)}`,
    ]);
    const roles = user.roles.map((item: any) => item.role.code);
    const permissions = new Set<string>(user.roles.flatMap((item: any) => item.role.permissions.map((link: any) => link.permission.code)));
    const auth: AuthContext = { userId: user.id, organizationId: user.organizationId, organizationName: user.organization.name, organizationSlug: user.organization.slug, sessionId: session.id, csrfHash: hashToken(csrfToken), email: user.email, fullName: user.fullName, roles, permissions, citizenProfileId: user.citizenProfile?.id ?? null, departmentId: user.departmentId ?? null };
    return res.json({ data: { user: userSummary(auth), organization: { id: user.organization.id, name: user.organization.name, slug: user.organization.slug }, expiresAt } });
  });

  const authenticate = async (req: RequestWithAuth, res: Response, next: NextFunction) => {
    const token = parseCookies(req.get("cookie"))["civic_session"];
    if (!token || !/^[a-f0-9]{64}$/.test(token)) return sendError(res, 401, "AUTHENTICATION_REQUIRED", "Sign in to continue.");
    const session = await db.userSession.findUnique({ where: { tokenHash: hashToken(token) }, include: { organization: true, user: { include: { department: true, citizenProfile: true, roles: authenticatedUserInclude.roles } } } });
    if (!session || session.revokedAt || session.expiresAt <= new Date() || session.user.status !== "ACTIVE" || !session.organization.isActive || session.organizationId !== session.user.organizationId) return sendError(res, 401, "SESSION_INVALID", "Your session has expired. Sign in again.");
    res.setHeader("Cache-Control", "no-store");
    const roles = session.user.roles.map((item: any) => item.role.code);
    const permissions = new Set<string>(session.user.roles.flatMap((item: any) => item.role.permissions.map((link: any) => link.permission.code)));
    req.auth = { userId: session.user.id, organizationId: session.organizationId, organizationName: session.organization.name, organizationSlug: session.organization.slug, sessionId: session.id, csrfHash: session.csrfHash, email: session.user.email, fullName: session.user.fullName, roles, permissions, citizenProfileId: session.user.citizenProfile?.id ?? null, departmentId: session.user.departmentId ?? null };
    return next();
  };
  const csrfProtection = (req: RequestWithAuth, res: Response, next: NextFunction) => {
    const origin = req.get("origin");
    if (origin && !origins.includes(origin)) return sendError(res, 403, "ORIGIN_DENIED", "Request origin is not allowed.");
    if (["GET", "HEAD", "OPTIONS"].includes(req.method)) return next();
    const cookies = parseCookies(req.get("cookie")); const token = cookies["civic_csrf"]; const header = req.get("x-csrf-token");
    if (!token || !header || token !== header || hashToken(token) !== req.auth?.csrfHash) return sendError(res, 403, "CSRF_VALIDATION_FAILED", "A valid CSRF token is required.");
    return next();
  };
  const requirePermission = (permission: string) => (req: RequestWithAuth, res: Response, next: NextFunction) => {
    if (!req.auth?.permissions.has(permission)) return sendError(res, 403, "PERMISSION_DENIED", `Missing permission: ${permission}`);
    return next();
  };
  app.get("/api/v1/auth/me", authenticate, csrfProtection, (req: RequestWithAuth, res) => res.json({ data: { user: userSummary(req.auth!), organization: { id: req.auth!.organizationId, name: req.auth!.organizationName, slug: req.auth!.organizationSlug } } }));
  app.post("/api/v1/auth/logout", authenticate, csrfProtection, async (req: RequestWithAuth, res) => {
    await db.$transaction(async (tx: Prisma.TransactionClient) => {
      await tx.userSession.update({ where: { id: req.auth!.sessionId }, data: { revokedAt: new Date() } });
      await tx.auditLog.create({ data: { organizationId: req.auth!.organizationId, actorUserId: req.auth!.userId, action: "auth.session.revoked", entityType: "UserSession", entityId: req.auth!.sessionId, metadata: {}, ipAddress: req.ip } });
    });
    res.setHeader("Set-Cookie", [`civic_session=; ${cookieOptions(0)}`, `civic_csrf=; ${csrfCookieOptions(0)}`]);
    res.json({ data: { loggedOut: true } });
  });

  app.get("/api/v1/roles", authenticate, requirePermission("user.manage"), async (req: RequestWithAuth, res) => {
    const roles = await db.role.findMany({ where: { organizationId: req.auth!.organizationId }, include: { permissions: { include: { permission: true } } }, orderBy: { name: "asc" } });
    res.json({ data: roles.map((role: any) => ({ id: role.id, code: role.code, name: role.name, description: role.description, isSystem: role.isSystem, permissionCodes: role.permissions.map((link: any) => link.permission.code) })) });
  });
  app.put("/api/v1/roles/:roleId/permissions", authenticate, csrfProtection, requirePermission("user.manage"), async (req: RequestWithAuth, res) => {
    const parsed = rolePermissionSchema.safeParse(req.body);
    if (!parsed.success) return sendError(res, 400, "VALIDATION_ERROR", "Invalid permissions.", z.flattenError(parsed.error).fieldErrors);
    const orgId = req.auth!.organizationId;
    const roleId = String(req.params.roleId);
    const role = await db.role.findFirst({ where: { id: roleId, organizationId: orgId } });
    if (!role) return sendError(res, 404, "ROLE_NOT_FOUND", "Role not found.");
    const permissionRows = await db.permission.findMany({ where: { code: { in: [...new Set(parsed.data.permissionCodes)] } } });
    if (permissionRows.length !== new Set(parsed.data.permissionCodes).size) return sendError(res, 400, "UNKNOWN_PERMISSION", "One or more permissions are not recognized.");
    await db.$transaction(async (tx: Prisma.TransactionClient) => {
      await tx.rolePermission.deleteMany({ where: { organizationId: orgId, roleId: role.id } });
      if (permissionRows.length) await tx.rolePermission.createMany({ data: permissionRows.map((item: any) => ({ organizationId: orgId, roleId: role.id, permissionId: item.id })) });
      await tx.auditLog.create({ data: { organizationId: orgId, actorUserId: req.auth!.userId, action: "role.permissions.updated", entityType: "Role", entityId: role.id, metadata: { permissionCodes: parsed.data.permissionCodes }, ipAddress: req.ip } });
    });
    res.json({ data: { roleId: role.id, permissionCodes: [...new Set(parsed.data.permissionCodes)] } });
  });

  app.get("/api/v1/workflow/routing-rules", authenticate, requirePermission("workflow.manage"), async (req: RequestWithAuth, res) => {
    const managerDepartment = req.auth!.roles.includes("DEPARTMENT_MANAGER") ? req.auth!.departmentId : null;
    if (req.auth!.roles.includes("DEPARTMENT_MANAGER") && !managerDepartment) return sendError(res, 403, "USER_SCOPE_UNCONFIGURED", "Department manager has no department scope.");
    const where = { organizationId: req.auth!.organizationId, ...(managerDepartment ? { OR: [{ departmentId: managerDepartment }, { team: { departmentId: managerDepartment } }] } : {}) };
    const data = await db.routingRule.findMany({ where, include: { category: true, department: true, team: true, region: true }, orderBy: [{ priority: "asc" }, { name: "asc" }] });
    res.json({ data });
  });
  app.post("/api/v1/workflow/routing-rules", authenticate, csrfProtection, requirePermission("workflow.manage"), async (req: RequestWithAuth, res) => {
    const parsed = routingRuleSchema.safeParse(req.body);
    if (!parsed.success) return sendError(res, 400, "VALIDATION_ERROR", "Invalid routing rule.", z.flattenError(parsed.error).fieldErrors);
    const organizationId = req.auth!.organizationId;
    const managerDepartment = req.auth!.roles.includes("DEPARTMENT_MANAGER") ? req.auth!.departmentId : null;
    if (req.auth!.roles.includes("DEPARTMENT_MANAGER") && !managerDepartment) return sendError(res, 403, "USER_SCOPE_UNCONFIGURED", "Department manager has no department scope.");
    if (parsed.data.categoryId && !await db.category.findFirst({ where: { id: parsed.data.categoryId, organizationId } })) return sendError(res, 400, "CATEGORY_NOT_FOUND", "Category is not in this organization.");
    if (parsed.data.regionId && !await db.region.findFirst({ where: { id: parsed.data.regionId, organizationId } })) return sendError(res, 400, "REGION_NOT_FOUND", "Region is not in this organization.");
    if (parsed.data.departmentId && !await db.department.findFirst({ where: { id: parsed.data.departmentId, organizationId, ...(managerDepartment ? { id: managerDepartment } : {}) } })) return sendError(res, 400, "DEPARTMENT_NOT_FOUND", "Department is not in the authorized scope.");
    if (parsed.data.teamId && !await db.team.findFirst({ where: { id: parsed.data.teamId, organizationId, ...(managerDepartment ? { departmentId: managerDepartment } : parsed.data.departmentId ? { departmentId: parsed.data.departmentId } : {}) } })) return sendError(res, 400, "TEAM_NOT_FOUND", "Team does not match this organization or department.");
    const rule = await db.$transaction(async (tx: Prisma.TransactionClient) => {
      const { conditions, ...ruleData } = parsed.data;
      const created = await tx.routingRule.create({ data: { ...ruleData, conditions: conditions as Prisma.InputJsonValue | undefined, organizationId } });
      await tx.auditLog.create({ data: { organizationId, actorUserId: req.auth!.userId, action: "workflow.routing_rule.created", entityType: "RoutingRule", entityId: created.id, metadata: { name: created.name, isActive: created.isActive, categoryId: created.categoryId, regionId: created.regionId, wardCode: created.wardCode, severity: created.severity, casePriority: created.casePriority, departmentId: created.departmentId, teamId: created.teamId }, ipAddress: req.ip } });
      return created;
    });
    res.status(201).json({ data: rule });
  });
  app.put("/api/v1/workflow/routing-rules/:ruleId", authenticate, csrfProtection, requirePermission("workflow.manage"), async (req: RequestWithAuth, res) => {
    const parsed = routingRuleSchema.safeParse(req.body);
    if (!parsed.success) return sendError(res, 400, "VALIDATION_ERROR", "Invalid routing rule.", z.flattenError(parsed.error).fieldErrors);
    const organizationId = req.auth!.organizationId; const ruleId = String(req.params.ruleId);
    const existing = await db.routingRule.findFirst({ where: { organizationId, id: ruleId } });
    if (!existing) return sendError(res, 404, "ROUTING_RULE_NOT_FOUND", "Routing rule not found.");
    const managerDepartment = req.auth!.roles.includes("DEPARTMENT_MANAGER") ? req.auth!.departmentId : null;
    if (req.auth!.roles.includes("DEPARTMENT_MANAGER")) {
      const currentDepartmentId = existing.departmentId ?? (existing.teamId ? (await db.team.findFirst({ where: { id: existing.teamId, organizationId }, select: { departmentId: true } }))?.departmentId : null);
      if (!managerDepartment || currentDepartmentId !== managerDepartment) return sendError(res, 403, "PERMISSION_DENIED", "Department managers can change only routing rules for their department.");
    }
    if (parsed.data.categoryId && !await db.category.findFirst({ where: { id: parsed.data.categoryId, organizationId } })) return sendError(res, 400, "CATEGORY_NOT_FOUND", "Category is not in this organization.");
    if (parsed.data.regionId && !await db.region.findFirst({ where: { id: parsed.data.regionId, organizationId } })) return sendError(res, 400, "REGION_NOT_FOUND", "Region is not in this organization.");
    if (parsed.data.departmentId && !await db.department.findFirst({ where: { id: parsed.data.departmentId, organizationId, ...(managerDepartment ? { id: managerDepartment } : {}) } })) return sendError(res, 400, "DEPARTMENT_NOT_FOUND", "Department is not in the authorized scope.");
    if (parsed.data.teamId && !await db.team.findFirst({ where: { id: parsed.data.teamId, organizationId, ...(managerDepartment ? { departmentId: managerDepartment } : parsed.data.departmentId ? { departmentId: parsed.data.departmentId } : {}) } })) return sendError(res, 400, "TEAM_NOT_FOUND", "Team does not match this organization or department.");
    const updated = await db.$transaction(async (tx: Prisma.TransactionClient) => {
      const { conditions, ...ruleData } = parsed.data;
      const row = await tx.routingRule.update({ where: { organizationId_id: { organizationId, id: ruleId } }, data: { ...ruleData, conditions: conditions as Prisma.InputJsonValue | undefined } });
      await tx.auditLog.create({ data: { organizationId, actorUserId: req.auth!.userId, action: existing.isActive !== row.isActive ? row.isActive ? "workflow.routing_rule.activated" : "workflow.routing_rule.deactivated" : "workflow.routing_rule.updated", entityType: "RoutingRule", entityId: row.id, metadata: { before: { name: existing.name, isActive: existing.isActive }, after: { name: row.name, isActive: row.isActive, match: { categoryId: row.categoryId, regionId: row.regionId, wardCode: row.wardCode, severity: row.severity, casePriority: row.casePriority }, target: { departmentId: row.departmentId, teamId: row.teamId } } }, ipAddress: req.ip } });
      return row;
    });
    res.json({ data: updated });
  });
  app.patch("/api/v1/workflow/routing-rules/:ruleId/active", authenticate, csrfProtection, requirePermission("workflow.manage"), async (req: RequestWithAuth, res) => {
    const parsed = z.object({ isActive: z.boolean() }).strict().safeParse(req.body);
    if (!parsed.success) return sendError(res, 400, "VALIDATION_ERROR", "isActive must be true or false.");
    const organizationId = req.auth!.organizationId; const ruleId = String(req.params.ruleId);
    const existing = await db.routingRule.findFirst({ where: { organizationId, id: ruleId } });
    if (!existing) return sendError(res, 404, "ROUTING_RULE_NOT_FOUND", "Routing rule not found.");
    const managerDepartment = req.auth!.roles.includes("DEPARTMENT_MANAGER") ? req.auth!.departmentId : null;
    if (req.auth!.roles.includes("DEPARTMENT_MANAGER")) {
      const currentDepartmentId = existing.departmentId ?? (existing.teamId ? (await db.team.findFirst({ where: { id: existing.teamId, organizationId }, select: { departmentId: true } }))?.departmentId : null);
      if (!managerDepartment || currentDepartmentId !== managerDepartment) return sendError(res, 403, "PERMISSION_DENIED", "Department managers can change only routing rules for their department.");
    }
    const row = await db.$transaction(async (tx: Prisma.TransactionClient) => {
      const updated = await tx.routingRule.update({ where: { organizationId_id: { organizationId, id: ruleId } }, data: { isActive: parsed.data.isActive } });
      await tx.auditLog.create({ data: { organizationId, actorUserId: req.auth!.userId, action: parsed.data.isActive ? "workflow.routing_rule.activated" : "workflow.routing_rule.deactivated", entityType: "RoutingRule", entityId: ruleId, metadata: { before: existing.isActive, after: parsed.data.isActive }, ipAddress: req.ip } });
      return updated;
    });
    res.json({ data: row });
  });
  app.get("/api/v1/workflow/fallback-queue", authenticate, requirePermission("workflow.manage"), async (req: RequestWithAuth, res) => {
    const organization = await db.organization.findFirst({ where: { id: req.auth!.organizationId }, select: { fallbackTeamId: true, fallbackTeam: { select: { id: true, name: true, departmentId: true, department: { select: { name: true } } } } } });
    res.json({ data: { teamId: organization?.fallbackTeamId ?? null, team: organization?.fallbackTeam ?? null } });
  });
  app.put("/api/v1/workflow/fallback-queue", authenticate, csrfProtection, requirePermission("workflow.manage"), async (req: RequestWithAuth, res) => {
    if (!req.auth!.roles.some((role) => ["SENIOR_AUTHORITY", "ORGANIZATION_ADMINISTRATOR"].includes(role))) return sendError(res, 403, "PERMISSION_DENIED", "Only a senior authority or organization administrator can change the organization fallback queue.");
    const parsed = z.object({ teamId: z.string().min(1).nullable() }).strict().safeParse(req.body);
    if (!parsed.success) return sendError(res, 400, "VALIDATION_ERROR", "Choose an organization team or clear the fallback queue.");
    const organizationId = req.auth!.organizationId;
    if (parsed.data.teamId && !await db.team.findFirst({ where: { id: parsed.data.teamId, organizationId } })) return sendError(res, 400, "TEAM_NOT_FOUND", "Fallback team is not in this organization.");
    const row = await db.$transaction(async (tx: Prisma.TransactionClient) => {
      const updated = await tx.organization.update({ where: { id: organizationId }, data: { fallbackTeamId: parsed.data.teamId } });
      await tx.auditLog.create({ data: { organizationId, actorUserId: req.auth!.userId, action: "workflow.fallback_queue.updated", entityType: "Organization", entityId: organizationId, metadata: { fallbackTeamId: parsed.data.teamId }, ipAddress: req.ip } });
      return updated;
    });
    res.json({ data: { fallbackTeamId: row.fallbackTeamId } });
  });
  app.get("/api/v1/sla-policies", authenticate, requirePermission("sla.manage"), async (req: RequestWithAuth, res) => {
    const data = await db.sLAPolicy.findMany({ where: { organizationId: req.auth!.organizationId, ...(req.auth!.roles.includes("DEPARTMENT_MANAGER") ? { departmentId: req.auth!.departmentId } : {}) }, include: { category: true, department: true }, orderBy: { name: "asc" } });
    res.json({ data });
  });
  app.get("/api/v1/automation/runs", authenticate, requirePermission("sla.manage"), async (req: RequestWithAuth, res) => {
    const runs = await db.automationRun.findMany({ where: { organizationId: req.auth!.organizationId, jobName: "sla-monitor" }, orderBy: { startedAt: "desc" }, take: 50 });
    res.json({ data: runs });
  });
  app.post("/api/v1/sla-policies", authenticate, csrfProtection, requirePermission("sla.manage"), async (req: RequestWithAuth, res) => {
    const parsed = slaPolicySchema.safeParse(req.body);
    if (!parsed.success) return sendError(res, 400, "VALIDATION_ERROR", "Invalid SLA policy.", z.flattenError(parsed.error).fieldErrors);
    const organizationId = req.auth!.organizationId;
    const managerDepartment = req.auth!.roles.includes("DEPARTMENT_MANAGER") ? req.auth!.departmentId : null;
    if (req.auth!.roles.includes("DEPARTMENT_MANAGER") && !managerDepartment) return sendError(res, 403, "USER_SCOPE_UNCONFIGURED", "Department manager has no department scope.");
    if (req.auth!.roles.includes("DEPARTMENT_MANAGER") && parsed.data.departmentId !== managerDepartment) return sendError(res, 403, "PERMISSION_DENIED", "Department managers can configure SLA policies only for their department.");
    if (parsed.data.categoryId && !await db.category.findFirst({ where: { id: parsed.data.categoryId, organizationId } })) return sendError(res, 400, "CATEGORY_NOT_FOUND", "Category is not in this organization.");
    if (parsed.data.departmentId && !await db.department.findFirst({ where: { id: parsed.data.departmentId, organizationId } })) return sendError(res, 400, "DEPARTMENT_NOT_FOUND", "Department is not in this organization.");
    const policy = await db.$transaction(async (tx: Prisma.TransactionClient) => {
      const created = await tx.sLAPolicy.create({ data: { ...parsed.data, organizationId } });
      await tx.auditLog.create({ data: { organizationId, actorUserId: req.auth!.userId, action: "sla.policy.created", entityType: "SLAPolicy", entityId: created.id, metadata: { name: created.name, severity: created.severity, priority: created.priority, categoryId: created.categoryId, departmentId: created.departmentId, resolutionMinutes: created.resolutionMinutes }, ipAddress: req.ip } });
      return created;
    });
    res.status(201).json({ data: policy });
  });
  app.put("/api/v1/sla-policies/:policyId", authenticate, csrfProtection, requirePermission("sla.manage"), async (req: RequestWithAuth, res) => {
    const parsed = slaPolicySchema.safeParse(req.body);
    if (!parsed.success) return sendError(res, 400, "VALIDATION_ERROR", "Invalid SLA policy.", z.flattenError(parsed.error).fieldErrors);
    const organizationId = req.auth!.organizationId; const policyId = String(req.params.policyId);
    const before = await db.sLAPolicy.findFirst({ where: { id: policyId, organizationId } });
    if (!before) return sendError(res, 404, "SLA_POLICY_NOT_FOUND", "SLA policy not found.");
    const managerDepartment = req.auth!.roles.includes("DEPARTMENT_MANAGER") ? req.auth!.departmentId : null;
    if (req.auth!.roles.includes("DEPARTMENT_MANAGER") && (!managerDepartment || before.departmentId !== managerDepartment || parsed.data.departmentId !== managerDepartment)) return sendError(res, 403, "PERMISSION_DENIED", "Department managers can change only SLA policies scoped to their department.");
    if (parsed.data.categoryId && !await db.category.findFirst({ where: { id: parsed.data.categoryId, organizationId } })) return sendError(res, 400, "CATEGORY_NOT_FOUND", "Category is not in this organization.");
    if (parsed.data.departmentId && !await db.department.findFirst({ where: { id: parsed.data.departmentId, organizationId } })) return sendError(res, 400, "DEPARTMENT_NOT_FOUND", "Department is not in this organization.");
    const updated = await db.$transaction(async (tx: Prisma.TransactionClient) => {
      const row = await tx.sLAPolicy.update({ where: { organizationId_id: { organizationId, id: policyId } }, data: parsed.data });
      await tx.auditLog.create({ data: { organizationId, actorUserId: req.auth!.userId, action: before.isActive !== row.isActive ? row.isActive ? "sla.policy.activated" : "sla.policy.deactivated" : "sla.policy.updated", entityType: "SLAPolicy", entityId: row.id, metadata: { before: { name: before.name, resolutionMinutes: before.resolutionMinutes, isActive: before.isActive }, after: { name: row.name, severity: row.severity, priority: row.priority, categoryId: row.categoryId, departmentId: row.departmentId, resolutionMinutes: row.resolutionMinutes, isActive: row.isActive }, existingCaseDeadlinesChanged: false }, ipAddress: req.ip } });
      return row;
    });
    res.json({ data: updated, note: "Existing cases retain their stored SLA policy snapshot and deadline. Changes apply to new cases." });
  });

  app.get("/api/v1/analytics", authenticate, requirePermission("report.view"), async (req: RequestWithAuth, res) => {
    const auth = req.auth!;
    const scope = await caseScopeWhere(db, auth);
    if (!scope) return sendError(res, 403, "USER_SCOPE_UNCONFIGURED", "User is not configured with an organization case scope.");
    const dateFilters = z.object({ from: z.iso.date().optional(), to: z.iso.date().optional() }).safeParse(req.query);
    if (!dateFilters.success) return sendError(res, 400, "VALIDATION_ERROR", "Invalid analytics date range.", z.flattenError(dateFilters.error).fieldErrors);
    const now = new Date(); const weekStart = new Date(now); weekStart.setUTCHours(0, 0, 0, 0); weekStart.setUTCDate(weekStart.getUTCDate() - 6);
    const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    const createdAt = { ...(dateFilters.data.from ? { gte: new Date(`${dateFilters.data.from}T00:00:00.000Z`) } : {}), ...(dateFilters.data.to ? { lte: new Date(`${dateFilters.data.to}T23:59:59.999Z`) } : {}) };
    const filteredScope = Object.keys(createdAt).length ? { ...scope, createdAt } : scope;
    const [total, grouped, resolvedThisMonth, recent, rows, escalations] = await Promise.all([
      db.complaintCase.count({ where: filteredScope }),
      db.complaintCase.groupBy({ by: ["status"], where: filteredScope, _count: { _all: true } }),
      db.complaintCase.count({ where: { ...filteredScope, status: "RESOLVED", updatedAt: { gte: monthStart } } }),
      db.complaintCase.findMany({ where: { ...filteredScope, createdAt: { gte: weekStart, ...(dateFilters.data.to ? { lte: new Date(`${dateFilters.data.to}T23:59:59.999Z`) } : {}) } }, select: { createdAt: true, status: true } }),
      db.complaintCase.findMany({ where: filteredScope, select: { status: true, slaDueAt: true, updatedAt: true, department: { select: { name: true } }, category: { select: { name: true } } } }),
      db.escalation.count({ where: { organizationId: auth.organizationId, complaintCase: filteredScope } }),
    ]);
    const byStatus = Object.fromEntries((grouped as Array<{ status: string; _count: { _all: number } }>).map((row) => [row.status, row._count._all]));
    const weeklyActivity = Array.from({ length: 7 }, (_, index) => {
      const day = new Date(weekStart); day.setUTCDate(day.getUTCDate() + index); const key = day.toISOString().slice(0, 10);
      const entries = (recent as Array<{ createdAt: Date; status: string }>).filter((item) => item.createdAt.toISOString().slice(0, 10) === key);
      return { day: day.toLocaleDateString("en-US", { weekday: "short", timeZone: "UTC" }), received: entries.length, resolved: entries.filter((item) => item.status === "RESOLVED" || item.status === "CLOSED").length };
    });
    const tracked = (rows as Array<{ status: string; slaDueAt: Date | null; updatedAt: Date; department: { name: string } | null; category: { name: string } }>).filter((item) => item.slaDueAt);
    const compliant = tracked.filter((item) => item.status === "RESOLVED" || item.status === "CLOSED" ? item.updatedAt <= item.slaDueAt! : item.slaDueAt! >= now).length;
    const countBy = (key: "department" | "category") => Object.entries((rows as any[]).reduce<Record<string, number>>((acc, row) => { const label = row[key]?.name ?? "Unassigned"; acc[label] = (acc[label] ?? 0) + 1; return acc; }, {})).map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count);
    res.json({ data: { total, byStatus, resolvedThisMonth, overdue: (rows as any[]).filter((item) => item.slaDueAt && item.slaDueAt < now && !["RESOLVED", "CLOSED"].includes(item.status)).length, escalations, slaCompliance: tracked.length ? Math.round(compliant * 100 / tracked.length) : null, byDepartment: countBy("department"), byCategory: countBy("category"), weeklyActivity } });
  });

  const cases = express.Router();
  cases.use(authenticate, csrfProtection);
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024, files: 5 }, fileFilter: (_req, file, callback) => {
    const allowed = new Set(["image/jpeg", "image/png", "application/pdf"]);
    if (allowed.has(file.mimetype)) callback(null, true);
    else callback(Object.assign(new Error("Only PDF, JPEG and PNG attachments are accepted."), { status: 400 }));
  } });
  cases.get("/categories", requirePermission("complaint.view"), async (req: RequestWithAuth, res) => {
    const categories = await db.category.findMany({ where: { organizationId: req.auth!.organizationId, isActive: true }, include: { subcategories: { where: { isActive: true }, orderBy: { name: "asc" } } }, orderBy: { name: "asc" } });
    res.json({ data: categories });
  });
  cases.get("/", requirePermission("complaint.view"), async (req: RequestWithAuth, res) => {
    const querySchema = z.object({ status: z.enum(caseStatuses).optional(), priority: z.enum(priorities).optional(), categoryId: z.string().optional(), departmentId: z.string().optional(), q: z.string().trim().max(160).optional(), sortBy: z.enum(["createdAt", "updatedAt", "slaDueAt", "priority", "status"]).default("createdAt"), sortOrder: z.enum(["asc", "desc"]).default("desc"), page: z.coerce.number().int().min(1).default(1), pageSize: z.coerce.number().int().min(1).max(100).default(20) }).strict();
    const parsed = querySchema.safeParse(req.query);
    if (!parsed.success) return sendError(res, 400, "VALIDATION_ERROR", "Invalid case filters.", z.flattenError(parsed.error).fieldErrors);
    const auth = req.auth!;
    const where: any = await caseScopeWhere(db, auth);
    if (!where) return sendError(res, 403, "USER_SCOPE_UNCONFIGURED", "User is not configured with an organization case scope.");
    if (parsed.data.status) where.status = parsed.data.status;
    if (parsed.data.priority) where.priority = parsed.data.priority;
    if (parsed.data.categoryId) where.categoryId = parsed.data.categoryId;
    if (parsed.data.departmentId) where.departmentId = parsed.data.departmentId;
    if (parsed.data.q) where.OR = [{ referenceNumber: { contains: parsed.data.q, mode: "insensitive" } }, { title: { contains: parsed.data.q, mode: "insensitive" } }, { description: { contains: parsed.data.q, mode: "insensitive" } }];
    const skip = (parsed.data.page - 1) * parsed.data.pageSize;
    const [rows, total] = await Promise.all([db.complaintCase.findMany({ where, include: { category: true, subcategory: true, department: true, assignments: { where: { endedAt: null }, include: { assignedTo: { select: { id: true, fullName: true } }, team: true } }, escalations: { select: { id: true, source: true, dedupeKey: true } }, citizenProfile: { include: { user: { select: { id: true, fullName: true } } } } }, orderBy: { [parsed.data.sortBy]: parsed.data.sortOrder }, skip, take: parsed.data.pageSize }), db.complaintCase.count({ where })]);
    res.json({ data: rows.map((row: any) => caseResponse(row)), pagination: { page: parsed.data.page, pageSize: parsed.data.pageSize, total, pages: Math.ceil(total / parsed.data.pageSize) } });
  });

  cases.post("/", requirePermission("complaint.create"), async (req: RequestWithAuth, res) => {
    const parsed = createCaseSchema.safeParse(req.body);
    if (!parsed.success) return sendError(res, 400, "VALIDATION_ERROR", "Invalid case details.", z.flattenError(parsed.error).fieldErrors);
    const auth = req.auth!;
    const citizenProfileId = auth.citizenProfileId;
    if (!auth.roles.includes("CITIZEN") || !citizenProfileId) return sendError(res, 403, "CITIZEN_ONLY", "Case creation is currently available to authenticated citizens.");
    const category = await db.category.findFirst({ where: { organizationId: auth.organizationId, id: parsed.data.categoryId, isActive: true } });
    if (!category) return sendError(res, 400, "CATEGORY_NOT_FOUND", "Category is unavailable in this organization.");
    if (parsed.data.subcategoryId) {
      const subcategory = await db.subcategory.findFirst({ where: { organizationId: auth.organizationId, categoryId: category.id, id: parsed.data.subcategoryId, isActive: true } });
      if (!subcategory) return sendError(res, 400, "SUBCATEGORY_NOT_FOUND", "Subcategory does not belong to the selected category.");
    }
    const severity = parsed.data.severity ?? severityForPriority(parsed.data.priority);
    if (parsed.data.regionId && !await db.region.findFirst({ where: { organizationId: auth.organizationId, id: parsed.data.regionId }, select: { id: true } })) return sendError(res, 400, "REGION_NOT_FOUND", "Region is unavailable in this organization.");
    const dimensions = { categoryId: category.id, regionId: parsed.data.regionId ?? null, wardCode: parsed.data.wardCode ?? null, severity, casePriority: parsed.data.priority };
    const routingRules = await db.routingRule.findMany({ where: { organizationId: auth.organizationId, isActive: true, isFallback: false } });
    const matchedRule = matchRoutingRule(routingRules, dimensions);
    const organizationRouting = await db.organization.findFirst({ where: { id: auth.organizationId }, select: { fallbackTeamId: true } });
    const routingTarget = resolveRoutingTarget(matchedRule, organizationRouting?.fallbackTeamId ?? null);
    const targetTeamId = routingTarget.teamId;
    const targetDepartmentId = routingTarget.departmentId;
    const team = targetTeamId ? await db.team.findFirst({ where: { id: targetTeamId, organizationId: auth.organizationId }, select: { id: true, departmentId: true } }) : null;
    if (targetTeamId && !team) return sendError(res, 409, "ROUTING_TARGET_INVALID", "Configured routing target is unavailable. Ask an administrator to repair the routing configuration.");
    const departmentId = targetDepartmentId ?? team?.departmentId ?? null;
    const policies = await db.sLAPolicy.findMany({ where: { organizationId: auth.organizationId, isActive: true } });
    const matchingPolicies = policies.filter((policy: any) => (!policy.categoryId || policy.categoryId === category.id)
      && (!policy.departmentId || policy.departmentId === departmentId)
      && (!policy.severity || policy.severity === severity)
      && (!policy.priority || policy.priority === parsed.data.priority))
      .sort((a: any, b: any) => Number(Boolean(b.categoryId)) + Number(Boolean(b.departmentId)) + Number(Boolean(b.severity)) + Number(Boolean(b.priority))
        - Number(Boolean(a.categoryId)) - Number(Boolean(a.departmentId)) - Number(Boolean(a.severity)) - Number(Boolean(a.priority))
        || new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
    const sla = matchingPolicies[0] ?? null;
    const slaStartedAt = new Date();
    const slaDueAt = sla ? calculateSlaDeadline(slaStartedAt, sla.resolutionMinutes) : null;
    const referenceNumber = `PMS-${new Date().getFullYear()}-${randomUUID().slice(0, 8).toUpperCase()}`;
    const item = await db.$transaction(async (tx: Prisma.TransactionClient) => {
      const created = await tx.complaintCase.create({ data: { ...parsed.data, severity, organizationId: auth.organizationId, referenceNumber, citizenProfileId, createdByUserId: auth.userId, departmentId, slaStartedAt, slaDueAt, slaPolicyId: sla?.id ?? null, slaPolicyNameSnapshot: sla?.name ?? null, slaPolicySnapshot: sla ? { id: sla.id, name: sla.name, categoryId: sla.categoryId, departmentId: sla.departmentId, severity: sla.severity, priority: sla.priority, responseMinutes: sla.responseMinutes, resolutionMinutes: sla.resolutionMinutes } : undefined, slaDurationMinutesSnapshot: sla?.resolutionMinutes ?? null } });
      await tx.statusHistory.create({ data: { organizationId: auth.organizationId, caseId: created.id, changedById: auth.userId, fromStatus: null, toStatus: "SUBMITTED", note: "Case submitted" } });
      await tx.auditLog.create({ data: { organizationId: auth.organizationId, actorUserId: auth.userId, caseId: created.id, action: "case.created", entityType: "ComplaintCase", entityId: created.id, metadata: { referenceNumber }, ipAddress: req.ip, userAgent: req.get("user-agent") } });
      await tx.auditLog.create({ data: { organizationId: auth.organizationId, actorUserId: auth.userId, caseId: created.id, action: matchedRule ? "workflow.route.matched" : targetTeamId ? "workflow.route.fallback" : "workflow.route.unmatched", entityType: "RoutingDecision", entityId: matchedRule?.id ?? targetTeamId ?? "unassigned", metadata: { dimensions, routingRuleId: matchedRule?.id ?? null, departmentId, teamId: targetTeamId, fallbackTeamId: routingTarget.fallbackUsed ? targetTeamId : null }, ipAddress: req.ip } });
      if (departmentId || targetTeamId) {
        const assignment = await tx.assignment.create({ data: { organizationId: auth.organizationId, caseId: created.id, departmentId, teamId: targetTeamId, routingRuleId: matchedRule?.id ?? null, assignedByUserId: null, note: matchedRule ? `Automatically routed by rule: ${matchedRule.name}` : "Automatically routed to configured fallback queue" } });
        await tx.auditLog.create({ data: { organizationId: auth.organizationId, actorUserId: auth.userId, caseId: created.id, action: "case.assigned", entityType: "Assignment", entityId: assignment.id, metadata: { source: "ROUTING_ENGINE", routingRuleId: matchedRule?.id ?? null, departmentId, teamId: targetTeamId }, ipAddress: req.ip } });
      }
      await tx.notification.create({ data: { organizationId: auth.organizationId, userId: auth.userId, caseId: created.id, type: "case.received", payload: { referenceNumber } } });
      return tx.complaintCase.findFirst({ where: { organizationId: auth.organizationId, id: created.id }, include: { category: true, subcategory: true, statusHistory: true, assignments: { where: { endedAt: null }, include: { team: true, department: true } }, escalations: true } });
    });
    res.status(201).json({ data: item ? caseResponse(item) : item, routing: { ruleId: routingTarget.routingRuleId, fallbackUsed: routingTarget.fallbackUsed, assigned: Boolean(departmentId || targetTeamId) }, slaPolicy: sla ? { id: sla.id, name: sla.name, dueAt: slaDueAt } : null });
  });

  cases.get("/:caseId", requirePermission("complaint.view"), async (req: RequestWithAuth, res) => {
    const auth = req.auth!;
    const caseId = String(req.params.caseId);
    const scope = await caseScopeWhere(db, auth);
    if (!scope) return sendError(res, 403, "USER_SCOPE_UNCONFIGURED", "User is not configured with an organization case scope.");
    const where = { ...scope, id: caseId };
    const item = await db.complaintCase.findFirst({ where, include: { category: true, subcategory: true, department: { include: { region: true } }, citizenProfile: { include: { user: { select: auth.permissions.has("complaint.contact.view") ? { id: true, fullName: true, email: true, phone: true } : { id: true, fullName: true } } } }, assignments: { orderBy: { assignedAt: "desc" }, select: { id: true, assignedAt: true, endedAt: true, assignedTo: { select: { id: true, fullName: true } }, assignedBy: { select: { id: true, fullName: true } }, team: true } }, comments: { where: auth.permissions.has("complaint.assign") ? {} : { isInternal: false }, include: { author: { select: { id: true, fullName: true } } }, orderBy: { createdAt: "asc" } }, statusHistory: { include: { changedBy: { select: { id: true, fullName: true } } }, orderBy: { createdAt: "asc" } }, attachments: true, escalations: auth.roles.includes("CITIZEN") ? false : true } });
    if (!item) return sendError(res, 404, "CASE_NOT_FOUND", "Case not found.");
    res.json({ data: caseResponse(item) });
  });

  cases.patch("/:caseId/status", async (req: RequestWithAuth, res) => {
    const parsed = statusSchema.safeParse(req.body);
    if (!parsed.success) return sendError(res, 400, "VALIDATION_ERROR", "Invalid status change.", z.flattenError(parsed.error).fieldErrors);
    const needed = parsed.data.status === "RESOLVED" ? "complaint.resolve" : parsed.data.status === "CLOSED" ? "complaint.close" : "complaint.assign";
    if (!req.auth!.permissions.has(needed)) return sendError(res, 403, "PERMISSION_DENIED", `Missing permission: ${needed}`);
    const orgId = req.auth!.organizationId;
    const caseId = String(req.params.caseId);
    const scope = await caseScopeWhere(db, req.auth!);
    if (!scope) return sendError(res, 403, "USER_SCOPE_UNCONFIGURED", "User is not configured with an organization case scope.");
    const current = await db.complaintCase.findFirst({ where: { ...scope, id: caseId }, select: { id: true, status: true, citizenProfile: { select: { userId: true } } } });
    if (!current) return sendError(res, 404, "CASE_NOT_FOUND", "Case not found.");
    const allowedTransitions: Record<string, string[]> = {
      SUBMITTED: ["IN_REVIEW"],
      IN_REVIEW: ["IN_PROGRESS", "RESOLVED"],
      IN_PROGRESS: ["IN_REVIEW", "RESOLVED"],
      RESOLVED: ["IN_PROGRESS", "CLOSED"],
      CLOSED: [],
    };
    if (!allowedTransitions[current.status]?.includes(parsed.data.status)) return sendError(res, 409, "INVALID_STATUS_TRANSITION", `A case cannot move from ${current.status} to ${parsed.data.status}.`);
    const updated = await db.$transaction(async (tx: Prisma.TransactionClient) => {
      const row = await tx.complaintCase.update({ where: { organizationId_id: { organizationId: orgId, id: current.id } }, data: { status: parsed.data.status } });
      await tx.statusHistory.create({ data: { organizationId: orgId, caseId: current.id, changedById: req.auth!.userId, fromStatus: current.status, toStatus: parsed.data.status, note: parsed.data.note } });
      await tx.auditLog.create({ data: { organizationId: orgId, actorUserId: req.auth!.userId, caseId: current.id, action: "case.status.changed", entityType: "ComplaintCase", entityId: current.id, metadata: { from: current.status, to: parsed.data.status }, ipAddress: req.ip } });
      await tx.notification.create({ data: { organizationId: orgId, userId: current.citizenProfile.userId, caseId: current.id, type: "case.status.changed", payload: { status: parsed.data.status } } });
      return row;
    });
    res.json({ data: updated });
  });

  cases.post("/:caseId/assignments", requirePermission("complaint.assign"), async (req: RequestWithAuth, res) => {
    const parsed = assignmentSchema.safeParse(req.body);
    if (!parsed.success) return sendError(res, 400, "VALIDATION_ERROR", "Invalid assignment.", z.flattenError(parsed.error).fieldErrors);
    const orgId = req.auth!.organizationId; const caseId = String(req.params.caseId);
    const scope = await caseScopeWhere(db, req.auth!);
    if (!scope) return sendError(res, 403, "USER_SCOPE_UNCONFIGURED", "User is not configured with an organization case scope.");
    const item = await db.complaintCase.findFirst({ where: { ...scope, id: caseId }, select: { id: true, departmentId: true } });
    if (!item) return sendError(res, 404, "CASE_NOT_FOUND", "Case not found.");
    const managerDepartment = req.auth!.roles.includes("DEPARTMENT_MANAGER") ? req.auth!.departmentId : null;
    if (req.auth!.roles.includes("DEPARTMENT_MANAGER") && !managerDepartment) return sendError(res, 403, "USER_SCOPE_UNCONFIGURED", "Department manager has no department scope.");
    const targetUser = parsed.data.assignedToUserId ? await db.user.findFirst({ where: { id: parsed.data.assignedToUserId, organizationId: orgId, status: "ACTIVE", ...(managerDepartment ? { departmentId: managerDepartment } : {}) }, select: { id: true, departmentId: true } }) : null;
    if (parsed.data.assignedToUserId && !targetUser) return sendError(res, 400, "USER_NOT_FOUND", "Assignee is not an active user in the authorized department.");
    const targetTeam = parsed.data.teamId ? await db.team.findFirst({ where: { id: parsed.data.teamId, organizationId: orgId, ...(managerDepartment ? { departmentId: managerDepartment } : {}) }, select: { id: true, departmentId: true } }) : null;
    if (parsed.data.teamId && !targetTeam) return sendError(res, 400, "TEAM_NOT_FOUND", "Team is not in the authorized department.");
    if (targetUser?.departmentId && targetTeam?.departmentId && targetUser.departmentId !== targetTeam.departmentId) return sendError(res, 400, "ASSIGNMENT_DEPARTMENT_MISMATCH", "The officer and team must belong to the same department.");
    const targetDepartmentId = targetTeam?.departmentId ?? targetUser?.departmentId ?? item.departmentId;
    const assignment = await db.$transaction(async (tx: Prisma.TransactionClient) => {
      await tx.assignment.updateMany({ where: { organizationId: orgId, caseId, endedAt: null }, data: { endedAt: new Date() } });
      await tx.complaintCase.update({ where: { organizationId_id: { organizationId: orgId, id: caseId } }, data: { departmentId: targetDepartmentId } });
      const created = await tx.assignment.create({ data: { ...parsed.data, organizationId: orgId, caseId, departmentId: targetDepartmentId, assignedByUserId: req.auth!.userId } });
      await tx.auditLog.create({ data: { organizationId: orgId, actorUserId: req.auth!.userId, caseId, action: "case.assigned", entityType: "Assignment", entityId: created.id, metadata: { assignedToUserId: parsed.data.assignedToUserId ?? null, teamId: parsed.data.teamId ?? null, departmentId: targetDepartmentId }, ipAddress: req.ip } });
      if (parsed.data.assignedToUserId) await tx.notification.create({ data: { organizationId: orgId, userId: parsed.data.assignedToUserId, caseId, type: "case.assigned", payload: { assignmentId: created.id } } });
      return created;
    });
    res.status(201).json({ data: assignment });
  });

  cases.post("/:caseId/comments", requirePermission("complaint.comment"), async (req: RequestWithAuth, res) => {
    const parsed = commentSchema.safeParse(req.body);
    if (!parsed.success) return sendError(res, 400, "VALIDATION_ERROR", "Invalid note.", z.flattenError(parsed.error).fieldErrors);
    const auth = req.auth!; const orgId = auth.organizationId; const caseId = String(req.params.caseId);
    if (parsed.data.isInternal && !auth.permissions.has("complaint.assign")) return sendError(res, 403, "PERMISSION_DENIED", "Only staff may add internal notes.");
    const scope = await caseScopeWhere(db, auth);
    if (!scope) return sendError(res, 403, "USER_SCOPE_UNCONFIGURED", "User is not configured with an organization case scope.");
    const where = { ...scope, id: caseId };
    const exists = await db.complaintCase.findFirst({ where, select: { id: true } });
    if (!exists) return sendError(res, 404, "CASE_NOT_FOUND", "Case not found.");
    const comment = await db.$transaction(async (tx: Prisma.TransactionClient) => {
      const row = await tx.comment.create({ data: { ...parsed.data, organizationId: orgId, caseId, authorUserId: auth.userId } });
      await tx.auditLog.create({ data: { organizationId: orgId, actorUserId: auth.userId, caseId, action: parsed.data.isInternal ? "case.internal_note.added" : "case.comment.added", entityType: "Comment", entityId: row.id, metadata: {}, ipAddress: req.ip } });
      return row;
    });
    res.status(201).json({ data: comment });
  });

  cases.post("/:caseId/escalations", requirePermission("complaint.escalate"), async (req: RequestWithAuth, res) => {
    const parsed = escalationSchema.safeParse(req.body);
    if (!parsed.success) return sendError(res, 400, "VALIDATION_ERROR", "Invalid escalation.", z.flattenError(parsed.error).fieldErrors);
    const orgId = req.auth!.organizationId; const caseId = String(req.params.caseId);
    const scope = await caseScopeWhere(db, req.auth!);
    if (!scope) return sendError(res, 403, "USER_SCOPE_UNCONFIGURED", "User is not configured with an organization case scope.");
    if (!await db.complaintCase.findFirst({ where: { ...scope, id: caseId }, select: { id: true } })) return sendError(res, 404, "CASE_NOT_FOUND", "Case not found.");
    const escalation = await db.$transaction(async (tx: Prisma.TransactionClient) => {
      const row = await tx.escalation.create({ data: { ...parsed.data, organizationId: orgId, caseId, escalatedByUserId: req.auth!.userId } });
      await tx.auditLog.create({ data: { organizationId: orgId, actorUserId: req.auth!.userId, caseId, action: "case.escalated", entityType: "Escalation", entityId: row.id, metadata: { level: row.level }, ipAddress: req.ip } });
      return row;
    });
    res.status(201).json({ data: escalation });
  });
  cases.post("/:caseId/attachments", upload.array("files", 5), async (req: RequestWithAuth, res) => {
    if (!req.auth!.permissions.has("complaint.create") && !req.auth!.permissions.has("complaint.comment")) return sendError(res, 403, "PERMISSION_DENIED", "You cannot upload case attachments.");
    const scope = await caseScopeWhere(db, req.auth!);
    if (!scope) return sendError(res, 403, "USER_SCOPE_UNCONFIGURED", "User is not configured with a case scope.");
    const caseId = String(req.params.caseId);
    if (!await db.complaintCase.findFirst({ where: { ...scope, id: caseId }, select: { id: true } })) return sendError(res, 404, "CASE_NOT_FOUND", "Case not found.");
    const files = (req.files ?? []) as Express.Multer.File[];
    if (!files.length) return sendError(res, 400, "ATTACHMENT_REQUIRED", "Choose at least one attachment.");
    if (files.some((file) => !attachmentSignatureMatches(file))) return sendError(res, 400, "ATTACHMENT_CONTENT_INVALID", "An attachment's contents do not match its declared PDF, JPEG or PNG file type.");
    const directory = path.join(process.cwd(), "storage", "uploads");
    await mkdir(directory, { recursive: true });
    const saved = await db.$transaction(async (tx: Prisma.TransactionClient) => {
      const records = [];
      for (const file of files) {
        const extension = file.mimetype === "application/pdf" ? ".pdf" : file.mimetype === "image/png" ? ".png" : ".jpg";
        const storageKey = `${randomUUID()}${extension}`;
        await writeFile(path.join(directory, storageKey), file.buffer, { flag: "wx" });
        records.push(await tx.attachment.create({ data: { organizationId: req.auth!.organizationId, caseId, uploadedById: req.auth!.userId, fileName: path.basename(file.originalname).slice(0, 180), contentType: file.mimetype, storageKey, sizeBytes: file.size } }));
      }
      await tx.auditLog.create({ data: { organizationId: req.auth!.organizationId, actorUserId: req.auth!.userId, caseId, action: "case.attachments.uploaded", entityType: "Attachment", entityId: records[0]!.id, metadata: { count: records.length }, ipAddress: req.ip } });
      return records;
    });
    res.status(201).json({ data: saved });
  });

  app.use("/api/v1/cases", cases);

  app.get("/api/v1/departments", authenticate, requirePermission("complaint.view"), async (req: RequestWithAuth, res) => {
    const rows = await db.department.findMany({ where: { organizationId: req.auth!.organizationId }, include: { region: true, teams: true }, orderBy: { name: "asc" } });
    res.json({ data: rows });
  });
  app.get("/api/v1/regions", authenticate, requirePermission("complaint.view"), async (req: RequestWithAuth, res) => {
    const rows = await db.region.findMany({ where: { organizationId: req.auth!.organizationId }, orderBy: { name: "asc" } });
    res.json({ data: rows });
  });
  app.get("/api/v1/assignment-options", authenticate, requirePermission("complaint.assign"), async (req: RequestWithAuth, res) => {
    const managerDepartment = req.auth!.roles.includes("DEPARTMENT_MANAGER") ? req.auth!.departmentId : null;
    const where = { organizationId: req.auth!.organizationId, status: "ACTIVE" as const, ...(managerDepartment ? { departmentId: managerDepartment } : {}) };
    const [users, teams] = await Promise.all([
      db.user.findMany({ where, select: { id: true, fullName: true, departmentId: true, department: { select: { name: true } } }, orderBy: { fullName: "asc" } }),
      db.team.findMany({ where: { organizationId: req.auth!.organizationId, ...(managerDepartment ? { departmentId: managerDepartment } : {}) }, select: { id: true, name: true, departmentId: true }, orderBy: { name: "asc" } }),
    ]);
    res.json({ data: { users, teams } });
  });
  app.get("/api/v1/users", authenticate, requirePermission("user.manage"), async (req: RequestWithAuth, res) => {
    const rows = await db.user.findMany({ where: { organizationId: req.auth!.organizationId }, select: { id: true, email: true, fullName: true, phone: true, status: true, departmentId: true, department: { select: { name: true } }, roles: { include: { role: { select: { code: true, name: true } } } } }, orderBy: { fullName: "asc" } });
    res.json({ data: rows });
  });
  app.get("/api/v1/permissions", authenticate, requirePermission("user.manage"), async (_req, res) => {
    const rows = await db.permission.findMany({ orderBy: { code: "asc" } });
    res.json({ data: rows });
  });
  app.get("/api/v1/notifications", authenticate, async (req: RequestWithAuth, res) => {
    const rows = await db.notification.findMany({ where: { organizationId: req.auth!.organizationId, userId: req.auth!.userId }, orderBy: { createdAt: "desc" }, take: 100 });
    res.json({ data: rows });
  });
  app.patch("/api/v1/notifications/:notificationId/read", authenticate, csrfProtection, async (req: RequestWithAuth, res) => {
    const notificationId = String(req.params.notificationId);
    const changed = await db.notification.updateMany({ where: { id: notificationId, organizationId: req.auth!.organizationId, userId: req.auth!.userId, readAt: null }, data: { readAt: new Date() } });
    if (!changed.count) return sendError(res, 404, "NOTIFICATION_NOT_FOUND", "Notification not found or already read.");
    res.json({ data: { id: notificationId, read: true } });
  });
  app.get("/api/v1/audit-logs", authenticate, requirePermission("audit.view"), async (req: RequestWithAuth, res) => {
    const parsed = z.object({ page: z.coerce.number().int().min(1).default(1), pageSize: z.coerce.number().int().min(1).max(100).default(25), action: z.string().max(100).optional() }).safeParse(req.query);
    if (!parsed.success) return sendError(res, 400, "VALIDATION_ERROR", "Invalid audit filters.", z.flattenError(parsed.error).fieldErrors);
    const where = { organizationId: req.auth!.organizationId, ...(parsed.data.action ? { action: { contains: parsed.data.action, mode: "insensitive" as const } } : {}) };
    const [data, total] = await Promise.all([db.auditLog.findMany({ where, include: { actor: { select: { fullName: true, email: true } } }, orderBy: { createdAt: "desc" }, skip: (parsed.data.page - 1) * parsed.data.pageSize, take: parsed.data.pageSize }), db.auditLog.count({ where })]);
    res.json({ data, pagination: { page: parsed.data.page, pageSize: parsed.data.pageSize, total, pages: Math.ceil(total / parsed.data.pageSize) } });
  });
  app.get("/api/v1/attachments/:attachmentId", authenticate, async (req: RequestWithAuth, res) => {
    if (!req.auth!.permissions.has("complaint.view")) return sendError(res, 403, "PERMISSION_DENIED", "You cannot view case attachments.");
    const attachment = await db.attachment.findFirst({ where: { id: String(req.params.attachmentId), organizationId: req.auth!.organizationId }, select: { id: true, caseId: true, fileName: true, contentType: true, storageKey: true } });
    const scope = await caseScopeWhere(db, req.auth!);
    if (!attachment || !scope || !await db.complaintCase.findFirst({ where: { ...scope, id: attachment.caseId }, select: { id: true } })) return sendError(res, 404, "ATTACHMENT_NOT_FOUND", "Attachment not found.");
    try {
      const file = await readFile(path.join(process.cwd(), "storage", "uploads", path.basename(attachment.storageKey)));
      res.setHeader("Content-Type", attachment.contentType);
      res.setHeader("Content-Disposition", `attachment; filename*=UTF-8''${encodeURIComponent(attachment.fileName)}`);
      res.setHeader("X-Content-Type-Options", "nosniff");
      res.send(file);
    } catch { return sendError(res, 404, "ATTACHMENT_FILE_MISSING", "The attachment file is unavailable."); }
  });
  app.use((req: RequestWithAuth, res) => sendError(res, 404, "NOT_FOUND", "Endpoint not found."));
  const errorHandler: ErrorRequestHandler = (error, req: RequestWithAuth, res, _next) => {
    logger.error(`${req.requestId ?? "unknown"} ${error instanceof Error ? error.message : "Unknown error"}`);
    if (res.headersSent) return;
    const zod = error instanceof z.ZodError;
    const prismaInitializationError = typeof error === "object" && error !== null
      && (("name" in error && error.name === "PrismaClientInitializationError")
        || ("code" in error && ["P1000", "P1001", "P1002", "P1017"].includes(String(error.code))));
    if (prismaInitializationError) return sendError(res, 503, "DATABASE_UNAVAILABLE", "The database service is unavailable. Check that PostgreSQL is running and DATABASE_URL has valid credentials.");
    const status = zod ? 400 : typeof error === "object" && error !== null && "status" in error && typeof error.status === "number" && error.status >= 400 && error.status < 500 ? error.status : typeof error === "object" && error !== null && "code" in error && String(error.code).startsWith("LIMIT_") ? 413 : 500;
    sendError(res, status, zod ? "VALIDATION_ERROR" : status === 500 ? "INTERNAL_ERROR" : "INVALID_REQUEST", zod ? "Request validation failed." : status === 500 ? "An unexpected error occurred." : "Invalid request.", zod ? z.flattenError(error).fieldErrors : undefined);
  };
  app.use(errorHandler);
  return app;
}
