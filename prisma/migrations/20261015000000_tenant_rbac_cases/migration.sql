-- CreateEnum
CREATE TYPE "UserStatus" AS ENUM ('ACTIVE', 'DISABLED');

-- Bootstrap the tenant scope before backfilling the existing foundation tables.
CREATE TABLE "Organization" (
    "id" TEXT NOT NULL, "slug" TEXT NOT NULL, "name" TEXT NOT NULL,
    "timezone" TEXT NOT NULL DEFAULT 'Asia/Kolkata', "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "Organization_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "Region" (
    "id" TEXT NOT NULL, "organizationId" TEXT NOT NULL, "code" TEXT NOT NULL, "name" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "Region_pkey" PRIMARY KEY ("id")
);
INSERT INTO "Organization" ("id", "slug", "name", "createdAt", "updatedAt")
VALUES ('org_pune_municipal_services', 'pune-municipal-services', 'Pune Municipal Services', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);
INSERT INTO "Region" ("id", "organizationId", "code", "name", "createdAt", "updatedAt")
VALUES ('region_pune_central', 'org_pune_municipal_services', 'PUNE-CENTRAL', 'Pune Central Region', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);

-- DropForeignKey
ALTER TABLE "Complaint" DROP CONSTRAINT "Complaint_departmentId_fkey";

-- DropIndex
DROP INDEX "Department_name_key";

-- DropIndex
DROP INDEX "Complaint_referenceNumber_key";

-- DropIndex
DROP INDEX "Complaint_status_createdAt_idx";

-- DropIndex
DROP INDEX "Complaint_departmentId_idx";

-- AlterTable
ALTER TABLE "Department" ADD COLUMN     "organizationId" TEXT,
ADD COLUMN     "regionId" TEXT;

-- AlterTable
ALTER TABLE "Complaint" ADD COLUMN     "organizationId" TEXT;

UPDATE "Department" SET "organizationId" = 'org_pune_municipal_services', "regionId" = 'region_pune_central';
UPDATE "Complaint" SET "organizationId" = 'org_pune_municipal_services';
ALTER TABLE "Department" ALTER COLUMN "organizationId" SET NOT NULL, ALTER COLUMN "regionId" SET NOT NULL;
ALTER TABLE "Complaint" ALTER COLUMN "organizationId" SET NOT NULL;

-- CreateTable
CREATE TABLE "Team" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "departmentId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Team_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "fullName" TEXT NOT NULL,
    "phone" TEXT,
    "departmentId" TEXT,
    "status" "UserStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Role" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "isSystem" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Role_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Permission" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "description" TEXT NOT NULL,

    CONSTRAINT "Permission_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RolePermission" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "roleId" TEXT NOT NULL,
    "permissionId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RolePermission_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UserRole" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "roleId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UserRole_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TeamMembership" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "teamId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TeamMembership_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UserSession" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "csrfHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "userAgent" TEXT,
    "ipAddress" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UserSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CitizenProfile" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "address" TEXT,
    "regionCode" TEXT,
    "language" TEXT NOT NULL DEFAULT 'en',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CitizenProfile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Category" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Category_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Subcategory" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "categoryId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Subcategory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ComplaintCase" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "referenceNumber" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "status" "ComplaintStatus" NOT NULL DEFAULT 'SUBMITTED',
    "priority" "ComplaintPriority" NOT NULL DEFAULT 'MEDIUM',
    "citizenProfileId" TEXT NOT NULL,
    "createdByUserId" TEXT NOT NULL,
    "categoryId" TEXT NOT NULL,
    "subcategoryId" TEXT,
    "departmentId" TEXT,
    "location" TEXT,
    "latitude" DOUBLE PRECISION,
    "longitude" DOUBLE PRECISION,
    "slaDueAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ComplaintCase_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Assignment" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "caseId" TEXT NOT NULL,
    "assignedToUserId" TEXT,
    "teamId" TEXT,
    "assignedByUserId" TEXT NOT NULL,
    "note" TEXT,
    "assignedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Assignment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RoutingRule" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "categoryId" TEXT,
    "departmentId" TEXT,
    "teamId" TEXT,
    "priority" INTEGER NOT NULL DEFAULT 100,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "conditions" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RoutingRule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SLAPolicy" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "categoryId" TEXT,
    "priority" "ComplaintPriority",
    "responseMinutes" INTEGER NOT NULL,
    "resolutionMinutes" INTEGER NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SLAPolicy_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Escalation" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "caseId" TEXT NOT NULL,
    "escalatedByUserId" TEXT NOT NULL,
    "level" INTEGER NOT NULL,
    "reason" TEXT NOT NULL,
    "resolvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Escalation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Comment" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "caseId" TEXT NOT NULL,
    "authorUserId" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "isInternal" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Comment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Attachment" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "caseId" TEXT NOT NULL,
    "uploadedById" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "contentType" TEXT NOT NULL,
    "storageKey" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Attachment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StatusHistory" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "caseId" TEXT NOT NULL,
    "changedById" TEXT NOT NULL,
    "fromStatus" "ComplaintStatus",
    "toStatus" "ComplaintStatus" NOT NULL,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StatusHistory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Notification" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "caseId" TEXT,
    "type" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "readAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Notification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditLog" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "actorUserId" TEXT,
    "caseId" TEXT,
    "action" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "metadata" JSONB NOT NULL,
    "ipAddress" TEXT,
    "userAgent" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Feedback" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "caseId" TEXT NOT NULL,
    "citizenProfileId" TEXT NOT NULL,
    "rating" INTEGER NOT NULL,
    "comment" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Feedback_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Organization_slug_key" ON "Organization"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "Organization_id_key" ON "Organization"("id");

-- CreateIndex
CREATE INDEX "Region_organizationId_name_idx" ON "Region"("organizationId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "Region_organizationId_id_key" ON "Region"("organizationId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "Region_organizationId_code_key" ON "Region"("organizationId", "code");

-- CreateIndex
CREATE INDEX "Team_organizationId_departmentId_idx" ON "Team"("organizationId", "departmentId");

-- CreateIndex
CREATE UNIQUE INDEX "Team_organizationId_id_key" ON "Team"("organizationId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "Team_organizationId_code_key" ON "Team"("organizationId", "code");

-- CreateIndex
CREATE INDEX "User_organizationId_status_fullName_idx" ON "User"("organizationId", "status", "fullName");

-- CreateIndex
CREATE INDEX "User_organizationId_departmentId_idx" ON "User"("organizationId", "departmentId");

-- CreateIndex
CREATE UNIQUE INDEX "User_organizationId_id_key" ON "User"("organizationId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "User_organizationId_email_key" ON "User"("organizationId", "email");

-- CreateIndex
CREATE INDEX "Role_organizationId_name_idx" ON "Role"("organizationId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "Role_organizationId_id_key" ON "Role"("organizationId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "Role_organizationId_code_key" ON "Role"("organizationId", "code");

-- CreateIndex
CREATE UNIQUE INDEX "Permission_code_key" ON "Permission"("code");

-- CreateIndex
CREATE INDEX "RolePermission_organizationId_permissionId_idx" ON "RolePermission"("organizationId", "permissionId");

-- CreateIndex
CREATE UNIQUE INDEX "RolePermission_organizationId_roleId_permissionId_key" ON "RolePermission"("organizationId", "roleId", "permissionId");

-- CreateIndex
CREATE INDEX "UserRole_organizationId_roleId_idx" ON "UserRole"("organizationId", "roleId");

-- CreateIndex
CREATE UNIQUE INDEX "UserRole_organizationId_userId_roleId_key" ON "UserRole"("organizationId", "userId", "roleId");

-- CreateIndex
CREATE INDEX "TeamMembership_organizationId_userId_idx" ON "TeamMembership"("organizationId", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "TeamMembership_organizationId_teamId_userId_key" ON "TeamMembership"("organizationId", "teamId", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "UserSession_tokenHash_key" ON "UserSession"("tokenHash");

-- CreateIndex
CREATE INDEX "UserSession_organizationId_userId_expiresAt_idx" ON "UserSession"("organizationId", "userId", "expiresAt");

-- CreateIndex
CREATE INDEX "UserSession_expiresAt_idx" ON "UserSession"("expiresAt");

-- CreateIndex
CREATE INDEX "CitizenProfile_organizationId_regionCode_idx" ON "CitizenProfile"("organizationId", "regionCode");

-- CreateIndex
CREATE UNIQUE INDEX "CitizenProfile_organizationId_id_key" ON "CitizenProfile"("organizationId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "CitizenProfile_organizationId_userId_key" ON "CitizenProfile"("organizationId", "userId");

-- CreateIndex
CREATE INDEX "Category_organizationId_isActive_name_idx" ON "Category"("organizationId", "isActive", "name");

-- CreateIndex
CREATE UNIQUE INDEX "Category_organizationId_id_key" ON "Category"("organizationId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "Category_organizationId_code_key" ON "Category"("organizationId", "code");

-- CreateIndex
CREATE INDEX "Subcategory_organizationId_categoryId_isActive_idx" ON "Subcategory"("organizationId", "categoryId", "isActive");

-- CreateIndex
CREATE UNIQUE INDEX "Subcategory_organizationId_id_key" ON "Subcategory"("organizationId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "Subcategory_organizationId_categoryId_id_key" ON "Subcategory"("organizationId", "categoryId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "Subcategory_organizationId_categoryId_code_key" ON "Subcategory"("organizationId", "categoryId", "code");

-- CreateIndex
CREATE INDEX "ComplaintCase_organizationId_status_createdAt_idx" ON "ComplaintCase"("organizationId", "status", "createdAt");

-- CreateIndex
CREATE INDEX "ComplaintCase_organizationId_priority_createdAt_idx" ON "ComplaintCase"("organizationId", "priority", "createdAt");

-- CreateIndex
CREATE INDEX "ComplaintCase_organizationId_citizenProfileId_createdAt_idx" ON "ComplaintCase"("organizationId", "citizenProfileId", "createdAt");

-- CreateIndex
CREATE INDEX "ComplaintCase_organizationId_departmentId_status_idx" ON "ComplaintCase"("organizationId", "departmentId", "status");

-- CreateIndex
CREATE INDEX "ComplaintCase_organizationId_categoryId_createdAt_idx" ON "ComplaintCase"("organizationId", "categoryId", "createdAt");

-- CreateIndex
CREATE INDEX "ComplaintCase_organizationId_slaDueAt_idx" ON "ComplaintCase"("organizationId", "slaDueAt");

-- CreateIndex
CREATE UNIQUE INDEX "ComplaintCase_organizationId_id_key" ON "ComplaintCase"("organizationId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "ComplaintCase_organizationId_referenceNumber_key" ON "ComplaintCase"("organizationId", "referenceNumber");

-- CreateIndex
CREATE INDEX "Assignment_organizationId_caseId_endedAt_idx" ON "Assignment"("organizationId", "caseId", "endedAt");

-- CreateIndex
CREATE INDEX "Assignment_organizationId_assignedToUserId_endedAt_idx" ON "Assignment"("organizationId", "assignedToUserId", "endedAt");

-- CreateIndex
CREATE INDEX "Assignment_organizationId_teamId_endedAt_idx" ON "Assignment"("organizationId", "teamId", "endedAt");

-- CreateIndex
CREATE UNIQUE INDEX "Assignment_organizationId_id_key" ON "Assignment"("organizationId", "id");

-- CreateIndex
CREATE INDEX "RoutingRule_organizationId_isActive_priority_idx" ON "RoutingRule"("organizationId", "isActive", "priority");

-- CreateIndex
CREATE UNIQUE INDEX "RoutingRule_organizationId_id_key" ON "RoutingRule"("organizationId", "id");

-- CreateIndex
CREATE INDEX "SLAPolicy_organizationId_isActive_priority_categoryId_idx" ON "SLAPolicy"("organizationId", "isActive", "priority", "categoryId");

-- CreateIndex
CREATE UNIQUE INDEX "SLAPolicy_organizationId_id_key" ON "SLAPolicy"("organizationId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "SLAPolicy_organizationId_name_key" ON "SLAPolicy"("organizationId", "name");

-- CreateIndex
CREATE INDEX "Escalation_organizationId_caseId_createdAt_idx" ON "Escalation"("organizationId", "caseId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "Escalation_organizationId_id_key" ON "Escalation"("organizationId", "id");

-- CreateIndex
CREATE INDEX "Comment_organizationId_caseId_createdAt_idx" ON "Comment"("organizationId", "caseId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "Comment_organizationId_id_key" ON "Comment"("organizationId", "id");

-- CreateIndex
CREATE INDEX "Attachment_organizationId_caseId_createdAt_idx" ON "Attachment"("organizationId", "caseId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "Attachment_organizationId_id_key" ON "Attachment"("organizationId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "Attachment_organizationId_storageKey_key" ON "Attachment"("organizationId", "storageKey");

-- CreateIndex
CREATE INDEX "StatusHistory_organizationId_caseId_createdAt_idx" ON "StatusHistory"("organizationId", "caseId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "StatusHistory_organizationId_id_key" ON "StatusHistory"("organizationId", "id");

-- CreateIndex
CREATE INDEX "Notification_organizationId_userId_readAt_createdAt_idx" ON "Notification"("organizationId", "userId", "readAt", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "Notification_organizationId_id_key" ON "Notification"("organizationId", "id");

-- CreateIndex
CREATE INDEX "AuditLog_organizationId_entityType_entityId_createdAt_idx" ON "AuditLog"("organizationId", "entityType", "entityId", "createdAt");

-- CreateIndex
CREATE INDEX "AuditLog_organizationId_actorUserId_createdAt_idx" ON "AuditLog"("organizationId", "actorUserId", "createdAt");

-- CreateIndex
CREATE INDEX "AuditLog_organizationId_caseId_createdAt_idx" ON "AuditLog"("organizationId", "caseId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "AuditLog_organizationId_id_key" ON "AuditLog"("organizationId", "id");

-- CreateIndex
CREATE INDEX "Feedback_organizationId_rating_createdAt_idx" ON "Feedback"("organizationId", "rating", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "Feedback_organizationId_caseId_key" ON "Feedback"("organizationId", "caseId");

-- CreateIndex
CREATE INDEX "Department_organizationId_regionId_idx" ON "Department"("organizationId", "regionId");

-- CreateIndex
CREATE UNIQUE INDEX "Department_organizationId_id_key" ON "Department"("organizationId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "Department_organizationId_name_key" ON "Department"("organizationId", "name");

-- CreateIndex
CREATE INDEX "Complaint_organizationId_status_createdAt_idx" ON "Complaint"("organizationId", "status", "createdAt");

-- CreateIndex
CREATE INDEX "Complaint_organizationId_departmentId_idx" ON "Complaint"("organizationId", "departmentId");

-- CreateIndex
CREATE UNIQUE INDEX "Complaint_organizationId_id_key" ON "Complaint"("organizationId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "Complaint_organizationId_referenceNumber_key" ON "Complaint"("organizationId", "referenceNumber");

-- AddForeignKey
ALTER TABLE "Department" ADD CONSTRAINT "Department_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Department" ADD CONSTRAINT "Department_organizationId_regionId_fkey" FOREIGN KEY ("organizationId", "regionId") REFERENCES "Region"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Complaint" ADD CONSTRAINT "Complaint_organizationId_departmentId_fkey" FOREIGN KEY ("organizationId", "departmentId") REFERENCES "Department"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Complaint" ADD CONSTRAINT "Complaint_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Region" ADD CONSTRAINT "Region_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Team" ADD CONSTRAINT "Team_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Team" ADD CONSTRAINT "Team_organizationId_departmentId_fkey" FOREIGN KEY ("organizationId", "departmentId") REFERENCES "Department"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "User" ADD CONSTRAINT "User_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "User" ADD CONSTRAINT "User_organizationId_departmentId_fkey" FOREIGN KEY ("organizationId", "departmentId") REFERENCES "Department"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Role" ADD CONSTRAINT "Role_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RolePermission" ADD CONSTRAINT "RolePermission_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RolePermission" ADD CONSTRAINT "RolePermission_organizationId_roleId_fkey" FOREIGN KEY ("organizationId", "roleId") REFERENCES "Role"("organizationId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RolePermission" ADD CONSTRAINT "RolePermission_permissionId_fkey" FOREIGN KEY ("permissionId") REFERENCES "Permission"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserRole" ADD CONSTRAINT "UserRole_organizationId_userId_fkey" FOREIGN KEY ("organizationId", "userId") REFERENCES "User"("organizationId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserRole" ADD CONSTRAINT "UserRole_organizationId_roleId_fkey" FOREIGN KEY ("organizationId", "roleId") REFERENCES "Role"("organizationId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TeamMembership" ADD CONSTRAINT "TeamMembership_organizationId_teamId_fkey" FOREIGN KEY ("organizationId", "teamId") REFERENCES "Team"("organizationId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TeamMembership" ADD CONSTRAINT "TeamMembership_organizationId_userId_fkey" FOREIGN KEY ("organizationId", "userId") REFERENCES "User"("organizationId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserSession" ADD CONSTRAINT "UserSession_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserSession" ADD CONSTRAINT "UserSession_organizationId_userId_fkey" FOREIGN KEY ("organizationId", "userId") REFERENCES "User"("organizationId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CitizenProfile" ADD CONSTRAINT "CitizenProfile_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CitizenProfile" ADD CONSTRAINT "CitizenProfile_organizationId_userId_fkey" FOREIGN KEY ("organizationId", "userId") REFERENCES "User"("organizationId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Category" ADD CONSTRAINT "Category_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Subcategory" ADD CONSTRAINT "Subcategory_organizationId_categoryId_fkey" FOREIGN KEY ("organizationId", "categoryId") REFERENCES "Category"("organizationId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ComplaintCase" ADD CONSTRAINT "ComplaintCase_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ComplaintCase" ADD CONSTRAINT "ComplaintCase_organizationId_citizenProfileId_fkey" FOREIGN KEY ("organizationId", "citizenProfileId") REFERENCES "CitizenProfile"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ComplaintCase" ADD CONSTRAINT "ComplaintCase_organizationId_createdByUserId_fkey" FOREIGN KEY ("organizationId", "createdByUserId") REFERENCES "User"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ComplaintCase" ADD CONSTRAINT "ComplaintCase_organizationId_categoryId_fkey" FOREIGN KEY ("organizationId", "categoryId") REFERENCES "Category"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ComplaintCase" ADD CONSTRAINT "ComplaintCase_organizationId_categoryId_subcategoryId_fkey" FOREIGN KEY ("organizationId", "categoryId", "subcategoryId") REFERENCES "Subcategory"("organizationId", "categoryId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ComplaintCase" ADD CONSTRAINT "ComplaintCase_organizationId_departmentId_fkey" FOREIGN KEY ("organizationId", "departmentId") REFERENCES "Department"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Assignment" ADD CONSTRAINT "Assignment_organizationId_caseId_fkey" FOREIGN KEY ("organizationId", "caseId") REFERENCES "ComplaintCase"("organizationId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Assignment" ADD CONSTRAINT "Assignment_organizationId_assignedToUserId_fkey" FOREIGN KEY ("organizationId", "assignedToUserId") REFERENCES "User"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Assignment" ADD CONSTRAINT "Assignment_organizationId_assignedByUserId_fkey" FOREIGN KEY ("organizationId", "assignedByUserId") REFERENCES "User"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Assignment" ADD CONSTRAINT "Assignment_organizationId_teamId_fkey" FOREIGN KEY ("organizationId", "teamId") REFERENCES "Team"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RoutingRule" ADD CONSTRAINT "RoutingRule_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RoutingRule" ADD CONSTRAINT "RoutingRule_organizationId_categoryId_fkey" FOREIGN KEY ("organizationId", "categoryId") REFERENCES "Category"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RoutingRule" ADD CONSTRAINT "RoutingRule_organizationId_departmentId_fkey" FOREIGN KEY ("organizationId", "departmentId") REFERENCES "Department"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RoutingRule" ADD CONSTRAINT "RoutingRule_organizationId_teamId_fkey" FOREIGN KEY ("organizationId", "teamId") REFERENCES "Team"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SLAPolicy" ADD CONSTRAINT "SLAPolicy_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SLAPolicy" ADD CONSTRAINT "SLAPolicy_organizationId_categoryId_fkey" FOREIGN KEY ("organizationId", "categoryId") REFERENCES "Category"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Escalation" ADD CONSTRAINT "Escalation_organizationId_caseId_fkey" FOREIGN KEY ("organizationId", "caseId") REFERENCES "ComplaintCase"("organizationId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Escalation" ADD CONSTRAINT "Escalation_organizationId_escalatedByUserId_fkey" FOREIGN KEY ("organizationId", "escalatedByUserId") REFERENCES "User"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Comment" ADD CONSTRAINT "Comment_organizationId_caseId_fkey" FOREIGN KEY ("organizationId", "caseId") REFERENCES "ComplaintCase"("organizationId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Comment" ADD CONSTRAINT "Comment_organizationId_authorUserId_fkey" FOREIGN KEY ("organizationId", "authorUserId") REFERENCES "User"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Attachment" ADD CONSTRAINT "Attachment_organizationId_caseId_fkey" FOREIGN KEY ("organizationId", "caseId") REFERENCES "ComplaintCase"("organizationId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Attachment" ADD CONSTRAINT "Attachment_organizationId_uploadedById_fkey" FOREIGN KEY ("organizationId", "uploadedById") REFERENCES "User"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StatusHistory" ADD CONSTRAINT "StatusHistory_organizationId_caseId_fkey" FOREIGN KEY ("organizationId", "caseId") REFERENCES "ComplaintCase"("organizationId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StatusHistory" ADD CONSTRAINT "StatusHistory_organizationId_changedById_fkey" FOREIGN KEY ("organizationId", "changedById") REFERENCES "User"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_organizationId_caseId_fkey" FOREIGN KEY ("organizationId", "caseId") REFERENCES "ComplaintCase"("organizationId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_organizationId_userId_fkey" FOREIGN KEY ("organizationId", "userId") REFERENCES "User"("organizationId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_organizationId_actorUserId_fkey" FOREIGN KEY ("organizationId", "actorUserId") REFERENCES "User"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_organizationId_caseId_fkey" FOREIGN KEY ("organizationId", "caseId") REFERENCES "ComplaintCase"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Feedback" ADD CONSTRAINT "Feedback_organizationId_caseId_fkey" FOREIGN KEY ("organizationId", "caseId") REFERENCES "ComplaintCase"("organizationId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Feedback" ADD CONSTRAINT "Feedback_organizationId_citizenProfileId_fkey" FOREIGN KEY ("organizationId", "citizenProfileId") REFERENCES "CitizenProfile"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE FUNCTION prevent_audit_log_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION 'AuditLog rows are append-only';
END;
$$;
CREATE TRIGGER "AuditLog_append_only" BEFORE UPDATE OR DELETE ON "AuditLog"
FOR EACH ROW EXECUTE FUNCTION prevent_audit_log_mutation();
