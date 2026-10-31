import { describe, expect, it, vi } from "vitest";
import { calculateSlaDeadline, evaluateSla, matchRoutingRule, processSlaOrganization, resolveRoutingTarget } from "./automation";

describe("SLA calculations", () => {
  const start = new Date("2026-01-01T00:00:00.000Z");
  const at = (percent: number) => new Date(start.getTime() + percent * 60_000);
  const metrics = (percent: number, escalated = false) => evaluateSla({ startedAt: start, dueAt: new Date(start.getTime() + 100 * 60_000), durationMinutes: 100, now: at(percent), escalated });

  it("reports warning, at-risk, breach, and escalation boundaries using the supplied server time", () => {
    expect(metrics(74.9).state).toBe("NORMAL");
    expect(metrics(75).state).toBe("WARNING");
    expect(metrics(90).state).toBe("AT_RISK");
    expect(metrics(100).state).toBe("BREACHED");
    expect(metrics(20, true).state).toBe("ESCALATED");
    expect(calculateSlaDeadline(start, 240).toISOString()).toBe("2026-01-01T04:00:00.000Z");
  });
});

describe("routing rules", () => {
  const dimensions = { categoryId: "roads", regionId: "central", wardCode: "14", severity: "HIGH", casePriority: "HIGH" };
  it("matches all configured dimensions and selects the most specific rule within priority order", () => {
    const chosen = matchRoutingRule([
      { id: "broad", categoryId: "roads", priority: 5, isActive: true },
      { id: "specific", categoryId: "roads", regionId: "central", wardCode: "14", severity: "HIGH", casePriority: "HIGH", priority: 5, isActive: true },
      { id: "wrong-ward", categoryId: "roads", wardCode: "15", priority: 1, isActive: true },
    ], dimensions);
    expect(chosen?.id).toBe("specific");
  });
  it("uses fallback only when explicitly configured and never mistakes it for a matching rule", () => {
    const rules = [{ id: "fallback", isFallback: true, isActive: true, priority: 0 }];
    expect(matchRoutingRule(rules, dimensions)).toBeNull();
    expect(resolveRoutingTarget(null, "configured-team")).toEqual({ routingRuleId: null, departmentId: null, teamId: "configured-team", fallbackUsed: true });
    expect(resolveRoutingTarget(null, null).fallbackUsed).toBe(false);
  });
});

describe("idempotent SLA processing", () => {
  it("creates escalation records, in-app notifications, and audit events once across repeated runs", async () => {
    const now = new Date("2026-01-01T07:00:00.000Z");
    const item = { id: "case-1", organizationId: "org-1", referenceNumber: "PMS-101", departmentId: "dept-1", createdAt: new Date("2026-01-01T00:00:00.000Z"), slaStartedAt: new Date("2026-01-01T00:00:00.000Z"), slaDueAt: new Date("2026-01-01T04:00:00.000Z"), slaDurationMinutesSnapshot: 240, status: "IN_PROGRESS", assignments: [{ teamId: "team-1" }], escalations: [] };
    const escalationKeys = new Set<string>(); const notificationKeys = new Set<string>(); const audits: any[] = [];
    let runId = 0;
    const db: any = {
      automationRun: { create: vi.fn(async () => ({ id: `run-${++runId}` })), update: vi.fn(async () => ({})) },
      complaintCase: { findMany: vi.fn(async () => [item]) },
      assignment: { findMany: vi.fn(async () => [{ assignedToUserId: "officer-1" }]) },
      teamMembership: { findMany: vi.fn(async () => [{ userId: "officer-1" }]) },
      user: { findMany: vi.fn(async () => [
        { id: "supervisor-1", departmentId: "dept-1", roles: [{ role: { code: "SUPERVISOR" } }] },
        { id: "manager-1", departmentId: "dept-1", roles: [{ role: { code: "DEPARTMENT_MANAGER" } }] },
      ]) },
      auditLog: { create: vi.fn(async ({ data }: any) => { audits.push(data); return { id: `audit-${audits.length}` }; }) },
      notification: { createMany: vi.fn(async ({ data }: any) => { let count = 0; for (const row of data) { const key = `${row.userId}:${row.dedupeKey}`; if (!notificationKeys.has(key)) { notificationKeys.add(key); count++; } } return { count }; }) },
      escalation: {
        createMany: vi.fn(async ({ data }: any) => { const row = data[0]; if (escalationKeys.has(row.dedupeKey)) return { count: 0 }; escalationKeys.add(row.dedupeKey); return { count: 1 }; }),
        findFirst: vi.fn(async ({ where }: any) => ({ id: `esc-${where.dedupeKey}`, ...where })),
      },
      $transaction: vi.fn(async (callback: (tx: any) => unknown) => callback(db)),
    };
    const thresholds = { warningPercent: 75, atRiskPercent: 90, extendedBreachMultiplier: 1.5 };
    const first = await processSlaOrganization(db, "org-1", { now, thresholds });
    const second = await processSlaOrganization(db, "org-1", { now, thresholds });
    expect(first.escalationCount).toBe(4);
    expect(second.escalationCount).toBe(0);
    expect(escalationKeys.size).toBe(4);
    expect(audits.filter((row) => row.action.startsWith("sla.escalation.")).length).toBe(4);
    expect(notificationKeys.size).toBe(12);
    expect([...notificationKeys].some((key) => key.startsWith("officer-1:"))).toBe(true);
    expect([...notificationKeys].some((key) => key.startsWith("supervisor-1:"))).toBe(true);
    expect([...notificationKeys].some((key) => key.startsWith("manager-1:"))).toBe(true);
    expect(db.automationRun.update).toHaveBeenCalledTimes(2);
  });
});
