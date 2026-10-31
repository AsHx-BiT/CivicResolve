-- SLA deadlines on existing cases are retained as-is; new cases store a policy snapshot.
CREATE TYPE "ComplaintSeverity" AS ENUM ('LOW', 'MEDIUM', 'HIGH', 'CRITICAL');

ALTER TABLE "Organization" ADD COLUMN "fallbackTeamId" TEXT;
ALTER TABLE "ComplaintCase"
  ADD COLUMN "severity" "ComplaintSeverity" NOT NULL DEFAULT 'MEDIUM',
  ADD COLUMN "regionId" TEXT,
  ADD COLUMN "wardCode" TEXT,
  ADD COLUMN "slaStartedAt" TIMESTAMP(3),
  ADD COLUMN "slaPolicyId" TEXT,
  ADD COLUMN "slaPolicyNameSnapshot" TEXT,
  ADD COLUMN "slaPolicySnapshot" JSONB,
  ADD COLUMN "slaDurationMinutesSnapshot" INTEGER;
UPDATE "ComplaintCase" SET "severity" = CASE "priority"::text
  WHEN 'URGENT' THEN 'CRITICAL'::"ComplaintSeverity"
  WHEN 'HIGH' THEN 'HIGH'::"ComplaintSeverity"
  WHEN 'LOW' THEN 'LOW'::"ComplaintSeverity"
  ELSE 'MEDIUM'::"ComplaintSeverity" END;

ALTER TABLE "RoutingRule"
  ADD COLUMN "regionId" TEXT,
  ADD COLUMN "wardCode" TEXT,
  ADD COLUMN "severity" "ComplaintSeverity",
  ADD COLUMN "casePriority" "ComplaintPriority",
  ADD COLUMN "isFallback" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "SLAPolicy"
  ADD COLUMN "departmentId" TEXT,
  ADD COLUMN "severity" "ComplaintSeverity";

ALTER TABLE "Assignment" ADD COLUMN "routingRuleId" TEXT, ADD COLUMN "departmentId" TEXT;
ALTER TABLE "Assignment" ALTER COLUMN "assignedByUserId" DROP NOT NULL;
ALTER TABLE "Escalation"
  ALTER COLUMN "escalatedByUserId" DROP NOT NULL,
  ADD COLUMN "source" TEXT NOT NULL DEFAULT 'MANUAL',
  ADD COLUMN "dedupeKey" TEXT;
ALTER TABLE "Notification" ADD COLUMN "dedupeKey" TEXT;

CREATE TABLE "AutomationRun" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL,
  "jobName" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'RUNNING',
  "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "finishedAt" TIMESTAMP(3),
  "processedCount" INTEGER NOT NULL DEFAULT 0,
  "errorCount" INTEGER NOT NULL DEFAULT 0,
  "result" JSONB,
  "error" TEXT,
  CONSTRAINT "AutomationRun_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "Escalation_organizationId_caseId_dedupeKey_key" ON "Escalation"("organizationId", "caseId", "dedupeKey");
CREATE UNIQUE INDEX "Notification_organizationId_userId_dedupeKey_key" ON "Notification"("organizationId", "userId", "dedupeKey");
CREATE UNIQUE INDEX "AutomationRun_organizationId_id_key" ON "AutomationRun"("organizationId", "id");
CREATE INDEX "ComplaintCase_organizationId_regionId_wardCode_idx" ON "ComplaintCase"("organizationId", "regionId", "wardCode");
CREATE INDEX "AutomationRun_organizationId_jobName_startedAt_idx" ON "AutomationRun"("organizationId", "jobName", "startedAt");
CREATE INDEX "SLAPolicy_organizationId_departmentId_severity_priority_idx" ON "SLAPolicy"("organizationId", "departmentId", "severity", "priority");

ALTER TABLE "Organization" ADD CONSTRAINT "Organization_fallbackTeam_fkey"
  FOREIGN KEY ("id", "fallbackTeamId") REFERENCES "Team"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ComplaintCase" ADD CONSTRAINT "ComplaintCase_region_fkey"
  FOREIGN KEY ("organizationId", "regionId") REFERENCES "Region"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ComplaintCase" ADD CONSTRAINT "ComplaintCase_slaPolicy_fkey"
  FOREIGN KEY ("organizationId", "slaPolicyId") REFERENCES "SLAPolicy"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "RoutingRule" ADD CONSTRAINT "RoutingRule_region_fkey"
  FOREIGN KEY ("organizationId", "regionId") REFERENCES "Region"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "SLAPolicy" ADD CONSTRAINT "SLAPolicy_department_fkey"
  FOREIGN KEY ("organizationId", "departmentId") REFERENCES "Department"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Assignment" ADD CONSTRAINT "Assignment_routingRule_fkey"
  FOREIGN KEY ("organizationId", "routingRuleId") REFERENCES "RoutingRule"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Assignment" ADD CONSTRAINT "Assignment_department_fkey"
  FOREIGN KEY ("organizationId", "departmentId") REFERENCES "Department"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "AutomationRun" ADD CONSTRAINT "AutomationRun_organization_fkey"
  FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
