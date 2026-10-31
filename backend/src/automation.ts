import type { PrismaClient } from "@prisma/client";

export type SlaState = "NORMAL" | "WARNING" | "AT_RISK" | "BREACHED" | "ESCALATED" | "NONE";
export type SlaMetrics = { state: SlaState; remainingMs: number | null; consumptionPercent: number | null; calculatedAt: string; dueAt: string | null };
export type RoutingDimensions = { categoryId: string; regionId?: string | null; wardCode?: string | null; severity?: string | null; casePriority?: string | null };
export type SlaThresholds = { warningPercent: number; atRiskPercent: number; extendedBreachMultiplier: number };
type DbLike = any;

/** Extension point for an organization-specific working-hours calendar implementation. */
export interface SlaCalendar { addMinutes(startAt: Date, minutes: number): Date }
export class ElapsedHoursCalendar implements SlaCalendar {
  addMinutes(startAt: Date, minutes: number) { return new Date(startAt.getTime() + minutes * 60_000); }
}
export function calculateSlaDeadline(startAt: Date, resolutionMinutes: number, calendar: SlaCalendar = new ElapsedHoursCalendar()) {
  return calendar.addMinutes(startAt, resolutionMinutes);
}

export function evaluateSla(input: { startedAt: Date | string | null; dueAt: Date | string | null; durationMinutes?: number | null; now?: Date; escalated?: boolean }): SlaMetrics {
  const calculatedAt = input.now ?? new Date();
  if (!input.dueAt) return { state: "NONE", remainingMs: null, consumptionPercent: null, calculatedAt: calculatedAt.toISOString(), dueAt: null };
  const dueAt = new Date(input.dueAt);
  const startedAt = input.startedAt ? new Date(input.startedAt) : new Date(dueAt.getTime() - (input.durationMinutes ?? Math.max(0, dueAt.getTime() - calculatedAt.getTime())) * 60_000);
  const duration = input.durationMinutes && input.durationMinutes > 0 ? input.durationMinutes * 60_000 : dueAt.getTime() - startedAt.getTime();
  const remainingMs = dueAt.getTime() - calculatedAt.getTime();
  const consumptionPercent = duration > 0 ? Math.round(((calculatedAt.getTime() - startedAt.getTime()) / duration) * 1000) / 10 : 0;
  let state: SlaState = "NORMAL";
  if (consumptionPercent >= 100) state = "BREACHED";
  else if (consumptionPercent >= 90) state = "AT_RISK";
  else if (consumptionPercent >= 75) state = "WARNING";
  if (input.escalated) state = "ESCALATED";
  return { state, remainingMs, consumptionPercent, calculatedAt: calculatedAt.toISOString(), dueAt: dueAt.toISOString() };
}

export function matchRoutingRule<T extends { categoryId?: string | null; regionId?: string | null; wardCode?: string | null; severity?: string | null; casePriority?: string | null; isActive?: boolean; isFallback?: boolean; priority?: number }>(rules: T[], dimensions: RoutingDimensions): T | null {
  return rules.filter((rule) => rule.isActive !== false && !rule.isFallback
    && (!rule.categoryId || rule.categoryId === dimensions.categoryId)
    && (!rule.regionId || rule.regionId === (dimensions.regionId ?? null))
    && (!rule.wardCode || rule.wardCode.toLowerCase() === (dimensions.wardCode ?? "").toLowerCase())
    && (!rule.severity || rule.severity === (dimensions.severity ?? null))
    && (!rule.casePriority || rule.casePriority === (dimensions.casePriority ?? null)))
    .sort((a, b) => (a.priority ?? 100) - (b.priority ?? 100)
      || specificity(b) - specificity(a))[0] ?? null;
}
function specificity(rule: { categoryId?: string | null; regionId?: string | null; wardCode?: string | null; severity?: string | null; casePriority?: string | null }) { return [rule.categoryId, rule.regionId, rule.wardCode, rule.severity, rule.casePriority].filter(Boolean).length; }
export function resolveRoutingTarget(rule: { id: string; departmentId?: string | null; teamId?: string | null } | null, fallbackTeamId: string | null) {
  return rule
    ? { routingRuleId: rule.id, departmentId: rule.departmentId ?? null, teamId: rule.teamId ?? null, fallbackUsed: false }
    : { routingRuleId: null, departmentId: null, teamId: fallbackTeamId, fallbackUsed: Boolean(fallbackTeamId) };
}

export interface NotificationProvider {
  publish(tx: DbLike, event: { organizationId: string; caseId: string; type: string; payload: Record<string, unknown>; recipientIds: string[]; dedupeKey: string }): Promise<number>;
}

/** Local PostgreSQL-backed provider; this interface can be replaced by a queue/email provider later. */
export class LocalNotificationProvider implements NotificationProvider {
  async publish(tx: DbLike, event: { organizationId: string; caseId: string; type: string; payload: Record<string, unknown>; recipientIds: string[]; dedupeKey: string }) {
    const recipientIds = [...new Set(event.recipientIds)];
    if (!recipientIds.length) return 0;
    const result = await tx.notification.createMany({
      data: recipientIds.map((userId) => ({ organizationId: event.organizationId, userId, caseId: event.caseId, type: event.type, payload: event.payload, dedupeKey: event.dedupeKey })),
      skipDuplicates: true,
    });
    return result.count;
  }
}

function configuredThresholds(): SlaThresholds {
  const thresholds = {
    warningPercent: Number(process.env.SLA_WARNING_PERCENT) || 75,
    atRiskPercent: Number(process.env.SLA_AT_RISK_PERCENT) || 90,
    extendedBreachMultiplier: Number(process.env.SLA_EXTENDED_BREACH_MULTIPLIER) || 1.5,
  };
  if (thresholds.warningPercent <= 0 || thresholds.warningPercent >= thresholds.atRiskPercent || thresholds.atRiskPercent >= 100 || thresholds.extendedBreachMultiplier <= 1) {
    throw new Error("Invalid SLA thresholds: require 0 < warning < at-risk < 100 and extended-breach multiplier > 1.");
  }
  return thresholds;
}
const milestones = (thresholds: SlaThresholds) => [
  { key: "warning", fraction: thresholds.warningPercent / 100, level: 1, type: "sla.warning", label: "Warning" },
  { key: "at-risk", fraction: thresholds.atRiskPercent / 100, level: 2, type: "sla.at-risk", label: "At risk" },
  { key: "breached", fraction: 1, level: 3, type: "sla.breached", label: "Breached" },
  { key: "extended-breach", fraction: thresholds.extendedBreachMultiplier, level: 4, type: "sla.extended-breach", label: "Extended breach" },
];

async function recipientsForCase(tx: DbLike, organizationId: string, item: any): Promise<string[]> {
  const [assigned, teamMembers, managers] = await Promise.all([
    tx.assignment.findMany({ where: { organizationId, caseId: item.id, endedAt: null, assignedToUserId: { not: null } }, select: { assignedToUserId: true } }),
    tx.teamMembership.findMany({ where: { organizationId, teamId: { in: (item.assignments ?? []).map((assignment: any) => assignment.teamId).filter(Boolean) }, user: { status: "ACTIVE" } }, select: { userId: true } }),
    tx.user.findMany({
      where: { organizationId, status: "ACTIVE", roles: { some: { role: { code: { in: ["SUPERVISOR", "DEPARTMENT_MANAGER"] } } } } },
      select: { id: true, departmentId: true, roles: { select: { role: { select: { code: true } } } } },
    }),
  ]);
  const relevantManagers = managers.filter((manager: any) => manager.roles.some((link: any) => link.role.code === "SUPERVISOR")
    ? !manager.departmentId || manager.departmentId === item.departmentId
    : Boolean(manager.departmentId && manager.departmentId === item.departmentId));
  return [...new Set([
    ...assigned.map((row: any) => row.assignedToUserId).filter(Boolean),
    ...teamMembers.map((row: any) => row.userId),
    ...relevantManagers.map((row: any) => row.id),
  ])];
}

/** Process one organization's open cases. Unique database keys make retries/concurrent runs idempotent. */
export async function processSlaOrganization(db: PrismaClient | DbLike, organizationId: string, options: { now?: Date; thresholds?: SlaThresholds; notificationProvider?: NotificationProvider } = {}) {
  const now = options.now ?? new Date();
  const thresholds = options.thresholds ?? configuredThresholds();
  const notificationProvider = options.notificationProvider ?? new LocalNotificationProvider();
  const run = await db.automationRun.create({ data: { organizationId, jobName: "sla-monitor", status: "RUNNING" } });
  let processedCount = 0;
  let escalationCount = 0;
  const errors: { caseId: string; message: string }[] = [];
  try {
    const cases = await db.complaintCase.findMany({
      where: { organizationId, slaDueAt: { not: null }, status: { in: ["SUBMITTED", "IN_REVIEW", "IN_PROGRESS"] } },
      include: { assignments: { where: { endedAt: null }, select: { teamId: true } }, escalations: { select: { source: true, dedupeKey: true } } },
      orderBy: { slaDueAt: "asc" },
    });
    for (const item of cases) {
      processedCount++;
      const durationMs = (item.slaDurationMinutesSnapshot ?? Math.max(0, (new Date(item.slaDueAt).getTime() - new Date(item.slaStartedAt ?? item.createdAt).getTime()) / 60_000)) * 60_000;
      if (!durationMs) continue;
      const elapsedFraction = (now.getTime() - new Date(item.slaStartedAt ?? item.createdAt).getTime()) / durationMs;
      const crossed = milestones(thresholds).filter((milestone) => elapsedFraction >= milestone.fraction);
      if (!crossed.length) continue;
      try {
        const recipientIds = await recipientsForCase(db, organizationId, item);
        for (const milestone of crossed) {
          const createdCount = await db.$transaction(async (tx: DbLike) => {
            const dedupeKey = `sla:${item.id}:${milestone.key}`;
            const insert = await tx.escalation.createMany({ data: [{ organizationId, caseId: item.id, escalatedByUserId: null, level: milestone.level, reason: `SLA ${milestone.label.toLowerCase()} threshold reached by the automated SLA processor.`, source: "SLA_AUTOMATION", dedupeKey }], skipDuplicates: true });
            if (!insert.count) return 0;
            const escalation = await tx.escalation.findFirst({ where: { organizationId, caseId: item.id, dedupeKey } });
            await notificationProvider.publish(tx, { organizationId, caseId: item.id, type: milestone.type, payload: { referenceNumber: item.referenceNumber, state: milestone.label, dueAt: new Date(item.slaDueAt).toISOString() }, recipientIds, dedupeKey });
            await tx.auditLog.create({ data: { organizationId, actorUserId: null, caseId: item.id, action: `sla.escalation.${milestone.key}`, entityType: "Escalation", entityId: escalation.id, metadata: { level: milestone.level, dedupeKey, remainingMs: new Date(item.slaDueAt).getTime() - now.getTime() } } });
            return 1;
          });
          escalationCount += createdCount;
        }
      } catch (error) {
        errors.push({ caseId: item.id, message: error instanceof Error ? error.message : "Unknown case processing error" });
      }
    }
    const result = { processedCount, escalationCount, errors };
    await db.automationRun.update({ where: { id: run.id }, data: { status: errors.length ? "PARTIAL" : "COMPLETED", finishedAt: now, processedCount, errorCount: errors.length, result } });
    return { runId: run.id, ...result };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown scheduler error";
    await db.automationRun.update({ where: { id: run.id }, data: { status: "FAILED", finishedAt: now, processedCount, errorCount: errors.length + 1, error: message, result: { errors } } });
    throw error;
  }
}

export async function runSlaAutomation(db: PrismaClient | DbLike, options: { now?: Date; thresholds?: SlaThresholds; notificationProvider?: NotificationProvider } = {}) {
  const organizations = await db.organization.findMany({ where: { isActive: true }, select: { id: true } });
  const results = [];
  for (const organization of organizations) results.push(await processSlaOrganization(db, organization.id, options));
  return results;
}
