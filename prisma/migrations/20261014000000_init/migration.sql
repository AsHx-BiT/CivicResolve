CREATE TYPE "ComplaintStatus" AS ENUM ('SUBMITTED', 'IN_REVIEW', 'IN_PROGRESS', 'RESOLVED', 'CLOSED');
CREATE TYPE "ComplaintPriority" AS ENUM ('LOW', 'MEDIUM', 'HIGH', 'URGENT');

CREATE TABLE "Department" (
  "id" TEXT NOT NULL, "name" TEXT NOT NULL, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL, CONSTRAINT "Department_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "Complaint" (
  "id" TEXT NOT NULL, "referenceNumber" TEXT NOT NULL, "title" TEXT NOT NULL, "description" TEXT NOT NULL,
  "category" TEXT NOT NULL, "status" "ComplaintStatus" NOT NULL DEFAULT 'SUBMITTED',
  "priority" "ComplaintPriority" NOT NULL DEFAULT 'MEDIUM', "residentName" TEXT NOT NULL,
  "residentEmail" TEXT NOT NULL, "location" TEXT, "departmentId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "Complaint_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "Department_name_key" ON "Department"("name");
CREATE UNIQUE INDEX "Complaint_referenceNumber_key" ON "Complaint"("referenceNumber");
CREATE INDEX "Complaint_status_createdAt_idx" ON "Complaint"("status", "createdAt");
CREATE INDEX "Complaint_departmentId_idx" ON "Complaint"("departmentId");
ALTER TABLE "Complaint" ADD CONSTRAINT "Complaint_departmentId_fkey" FOREIGN KEY ("departmentId") REFERENCES "Department"("id") ON DELETE SET NULL ON UPDATE CASCADE;
