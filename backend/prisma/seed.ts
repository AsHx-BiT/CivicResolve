import dotenv from "dotenv";
import { randomBytes } from "node:crypto";
import { PrismaClient, ComplaintPriority, ComplaintStatus } from "@prisma/client";
import { hashPassword } from "../src/security";

dotenv.config({ path: "../.env" });
if (process.env.NODE_ENV === "production") throw new Error("The development seed is disabled in production.");

const prisma = new PrismaClient();
const permissionDescriptions: Record<string, string> = {
  "complaint.view": "View cases within the user's authorized scope",
  "complaint.create": "Submit a new case for the authenticated citizen",
  "complaint.assign": "Assign or reassign cases and add internal notes",
  "complaint.resolve": "Resolve cases",
  "complaint.close": "Close cases",
  "complaint.escalate": "Escalate cases to a higher authority",
  "user.manage": "Manage organization users and role permissions",
  "report.view": "View organization reports",
  "workflow.manage": "Manage routing rules and workflows",
  "sla.manage": "Manage service-level policies",
  "complaint.comment": "Comment on cases",
  "complaint.contact.view": "View citizen contact information on cases",
  "audit.view": "View append-only audit events",
};
const roleDefinitions = [
  { code: "CITIZEN", name: "Citizen", permissions: ["complaint.view", "complaint.create", "complaint.comment"] },
  { code: "OFFICER", name: "Officer", permissions: ["complaint.view", "complaint.comment", "complaint.contact.view"] },
  { code: "SUPERVISOR", name: "Supervisor", permissions: ["complaint.view", "complaint.assign", "complaint.resolve", "complaint.close", "complaint.escalate", "complaint.comment", "complaint.contact.view", "report.view"] },
  { code: "DEPARTMENT_MANAGER", name: "Department Manager", permissions: ["complaint.view", "complaint.assign", "complaint.resolve", "complaint.close", "complaint.escalate", "complaint.comment", "complaint.contact.view", "report.view", "workflow.manage", "sla.manage"] },
  { code: "SENIOR_AUTHORITY", name: "Senior Authority", permissions: ["complaint.view", "complaint.assign", "complaint.resolve", "complaint.close", "complaint.escalate", "complaint.comment", "complaint.contact.view", "report.view", "workflow.manage", "sla.manage", "audit.view"] },
  { code: "ORGANIZATION_ADMINISTRATOR", name: "Organization Administrator", permissions: Object.keys(permissionDescriptions) },
  { code: "AUDITOR", name: "Auditor", permissions: ["complaint.view", "report.view", "audit.view"] },
];
const departmentDefinitions = [
  { code: "ROADS", name: "Roads & Traffic", team: "Road Maintenance Team" },
  { code: "WATER", name: "Water Supply & Drainage", team: "Water Response Team" },
  { code: "SOLID_WASTE", name: "Solid Waste Management", team: "Ward Sanitation Team" },
  { code: "PUBLIC_HEALTH", name: "Public Health", team: "Community Health Team" },
  { code: "PROPERTY_TAX", name: "Property Tax", team: "Property Services Team" },
  { code: "GARDENS", name: "Gardens & Parks", team: "Parks Operations Team" },
  { code: "BUILDING", name: "Building Permissions", team: "Building Review Team" },
  { code: "CITIZEN_SERVICES", name: "Citizen Services", team: "Ward Services Team" },
];
const categoryDefinitions = [
  { code: "ROADS_TRAFFIC", name: "Roads & Traffic", subcategories: ["Potholes", "Street lights", "Traffic signals", "Footpaths"] },
  { code: "WATER_DRAINAGE", name: "Water & Drainage", subcategories: ["Water supply", "Leakage", "Drain blockage", "Flooding"] },
  { code: "WASTE", name: "Waste Management", subcategories: ["Missed collection", "Illegal dumping", "Public bins", "Street cleanliness"] },
  { code: "PUBLIC_HEALTH", name: "Public Health", subcategories: ["Mosquito control", "Food safety", "Public sanitation"] },
  { code: "PROPERTY_TAX", name: "Property Tax", subcategories: ["Assessment", "Payment", "Records"] },
  { code: "PARKS", name: "Parks & Gardens", subcategories: ["Park maintenance", "Trees", "Playgrounds"] },
  { code: "BUILDING", name: "Building Permissions", subcategories: ["Permit status", "Unauthorized construction"] },
  { code: "CITIZEN_SERVICES", name: "Citizen Services", subcategories: ["Certificates", "Ward office", "Other services"] },
];

async function main() {
  const developmentPassword = process.env.SEED_PASSWORD ?? randomBytes(24).toString("base64url");
  if (developmentPassword.length < 16) throw new Error("SEED_PASSWORD must contain at least 16 characters.");
  const passwordHash = await hashPassword(developmentPassword);
  const organization = await prisma.organization.upsert({ where: { slug: "pune-municipal-services" }, update: { name: "Pune Municipal Services", isActive: true }, create: { id: "org_pune_municipal_services", slug: "pune-municipal-services", name: "Pune Municipal Services", timezone: "Asia/Kolkata" } });

  const regionNames = ["Pune Central Region", "Pune East Region", "Pune West Region", "Pune North Region", "Pune South Region"];
  const regions = await Promise.all(regionNames.map((name, index) => prisma.region.upsert({ where: { organizationId_code: { organizationId: organization.id, code: `PUNE-${["CENTRAL", "EAST", "WEST", "NORTH", "SOUTH"][index]}` } }, update: { name }, create: { organizationId: organization.id, code: `PUNE-${["CENTRAL", "EAST", "WEST", "NORTH", "SOUTH"][index]}`, name } })));
  const departments = new Map<string, { id: string; name: string; teamId: string }>();
  for (const definition of departmentDefinitions) {
    const department = await prisma.department.upsert({ where: { organizationId_name: { organizationId: organization.id, name: definition.name } }, update: { regionId: regions[0]!.id }, create: { organizationId: organization.id, regionId: regions[0]!.id, name: definition.name } });
    const team = await prisma.team.upsert({ where: { organizationId_code: { organizationId: organization.id, code: `${definition.code}_TEAM` } }, update: { departmentId: department.id, name: definition.team }, create: { organizationId: organization.id, departmentId: department.id, code: `${definition.code}_TEAM`, name: definition.team } });
    departments.set(definition.code, { id: department.id, name: department.name, teamId: team.id });
  }

  const permissionRows = new Map<string, { id: string }>();
  for (const [code, description] of Object.entries(permissionDescriptions)) {
    permissionRows.set(code, await prisma.permission.upsert({ where: { code }, update: { description }, create: { code, description } }));
  }
  const roles = new Map<string, { id: string }>();
  for (const definition of roleDefinitions) {
    const role = await prisma.role.upsert({ where: { organizationId_code: { organizationId: organization.id, code: definition.code } }, update: { name: definition.name, isSystem: true }, create: { organizationId: organization.id, code: definition.code, name: definition.name, isSystem: true } });
    roles.set(definition.code, role);
    for (const permissionCode of definition.permissions) {
      const permission = permissionRows.get(permissionCode)!;
      await prisma.rolePermission.upsert({ where: { organizationId_roleId_permissionId: { organizationId: organization.id, roleId: role.id, permissionId: permission.id } }, update: {}, create: { organizationId: organization.id, roleId: role.id, permissionId: permission.id } });
    }
  }

  for (const definition of categoryDefinitions) {
    const category = await prisma.category.upsert({ where: { organizationId_code: { organizationId: organization.id, code: definition.code } }, update: { name: definition.name, isActive: true }, create: { organizationId: organization.id, code: definition.code, name: definition.name } });
    for (let index = 0; index < definition.subcategories.length; index++) {
      const name = definition.subcategories[index]!;
      const code = `${definition.code}_${index + 1}`;
      await prisma.subcategory.upsert({ where: { organizationId_categoryId_code: { organizationId: organization.id, categoryId: category.id, code } }, update: { name, isActive: true }, create: { organizationId: organization.id, categoryId: category.id, code, name } });
    }
  }

  // Seed one explicit fallback queue. This is a deliberate organization setting, not a routing guess.
  await prisma.organization.update({ where: { id: organization.id }, data: { fallbackTeamId: departments.get("CITIZEN_SERVICES")!.teamId } });
  await prisma.sLAPolicy.updateMany({ where: { organizationId: organization.id, name: { endsWith: " Standard" } }, data: { isActive: false } });
  const slaDefaults = [
    { name: "Critical · 4 hours", severity: "CRITICAL" as const, priority: "URGENT" as const, responseMinutes: 30, resolutionMinutes: 240 },
    { name: "High · 24 hours", severity: "HIGH" as const, priority: "HIGH" as const, responseMinutes: 120, resolutionMinutes: 1440 },
    { name: "Medium · 72 hours", severity: "MEDIUM" as const, priority: "MEDIUM" as const, responseMinutes: 360, resolutionMinutes: 4320 },
    { name: "Low · 7 days", severity: "LOW" as const, priority: "LOW" as const, responseMinutes: 1440, resolutionMinutes: 10080 },
  ];
  for (const policy of slaDefaults) await prisma.sLAPolicy.upsert({ where: { organizationId_name: { organizationId: organization.id, name: policy.name } }, update: { ...policy, categoryId: null, departmentId: null, isActive: true }, create: { organizationId: organization.id, ...policy } });

  for (const definition of categoryDefinitions) {
    const category = await prisma.category.findUniqueOrThrow({ where: { organizationId_code: { organizationId: organization.id, code: definition.code } } });
    const target = departments.get((definition.code === "ROADS_TRAFFIC" ? "ROADS" : definition.code === "WATER_DRAINAGE" ? "WATER" : definition.code === "WASTE" ? "SOLID_WASTE" : definition.code === "PARKS" ? "GARDENS" : definition.code === "BUILDING" ? "BUILDING" : definition.code === "CITIZEN_SERVICES" ? "CITIZEN_SERVICES" : definition.code) as string);
    if (!target) continue;
    const existing = await prisma.routingRule.findFirst({ where: { organizationId: organization.id, name: `${definition.name} category routing` } });
    const data = { organizationId: organization.id, name: `${definition.name} category routing`, categoryId: category.id, departmentId: target.id, teamId: target.teamId, priority: 50, isActive: true };
    if (existing) await prisma.routingRule.update({ where: { organizationId_id: { organizationId: organization.id, id: existing.id } }, data });
    else await prisma.routingRule.create({ data });
  }

  for (const rule of roleDefinitions) {
    const existing = await prisma.rolePermission.findMany({ where: { organizationId: organization.id, roleId: roles.get(rule.code)!.id }, include: { permission: true } });
    const expected = new Set(rule.permissions);
    const extras = existing.filter((link) => !expected.has(link.permission.code));
    if (extras.length) await prisma.rolePermission.deleteMany({ where: { id: { in: extras.map((link) => link.id) } } });
  }

  const users = [
    { role: "CITIZEN", email: "asha.kulkarni@citizen.pms.local", name: "Asha Kulkarni", departmentCode: null },
    { role: "OFFICER", email: "rohan.deshmukh@pms.local", name: "Rohan Deshmukh", departmentCode: "ROADS" },
    { role: "SUPERVISOR", email: "meera.joshi@pms.local", name: "Meera Joshi", departmentCode: "WATER" },
    { role: "DEPARTMENT_MANAGER", email: "sanjay.patil@pms.local", name: "Sanjay Patil", departmentCode: "SOLID_WASTE" },
    { role: "SENIOR_AUTHORITY", email: "anita.shah@pms.local", name: "Anita Shah", departmentCode: "CITIZEN_SERVICES" },
    { role: "ORGANIZATION_ADMINISTRATOR", email: "admin@pms.local", name: "Pune Services Administrator", departmentCode: null },
    { role: "AUDITOR", email: "priya.nair@pms.local", name: "Priya Nair", departmentCode: null },
  ];
  const createdUsers = new Map<string, { id: string }>();
  for (const definition of users) {
    const departmentId = definition.departmentCode ? departments.get(definition.departmentCode)!.id : null;
    const user = await prisma.user.upsert({ where: { organizationId_email: { organizationId: organization.id, email: definition.email } }, update: { fullName: definition.name, ...(process.env.SEED_PASSWORD ? { passwordHash } : {}), departmentId, status: "ACTIVE" }, create: { organizationId: organization.id, email: definition.email, fullName: definition.name, passwordHash, departmentId } });
    createdUsers.set(definition.role, user);
    await prisma.userRole.upsert({ where: { organizationId_userId_roleId: { organizationId: organization.id, userId: user.id, roleId: roles.get(definition.role)!.id } }, update: {}, create: { organizationId: organization.id, userId: user.id, roleId: roles.get(definition.role)!.id } });
    if (definition.role === "CITIZEN") await prisma.citizenProfile.upsert({ where: { organizationId_userId: { organizationId: organization.id, userId: user.id } }, update: { regionCode: "PUNE-CENTRAL", language: "en" }, create: { organizationId: organization.id, userId: user.id, address: "Shivajinagar, Pune", regionCode: "PUNE-CENTRAL", language: "en" } });
    if (definition.role === "OFFICER") await prisma.teamMembership.upsert({ where: { organizationId_teamId_userId: { organizationId: organization.id, teamId: departments.get("ROADS")!.teamId, userId: user.id } }, update: {}, create: { organizationId: organization.id, teamId: departments.get("ROADS")!.teamId, userId: user.id } });
  }

  const citizenProfile = await prisma.citizenProfile.findUniqueOrThrow({ where: { organizationId_userId: { organizationId: organization.id, userId: createdUsers.get("CITIZEN")!.id } } });
  const admin = createdUsers.get("ORGANIZATION_ADMINISTRATOR")!;
  const examples = [
    { referenceNumber: "PMS-2026-000101", categoryCode: "ROADS_TRAFFIC", title: "Street lights out near Sambhaji Park", description: "Two street lights have not worked for several evenings. The path is used by residents walking home after work.", location: "Shivajinagar, Ward 14", status: ComplaintStatus.IN_PROGRESS, priority: ComplaintPriority.HIGH, departmentCode: "ROADS" },
    { referenceNumber: "PMS-2026-000102", categoryCode: "WATER_DRAINAGE", title: "Water leakage on FC Road", description: "A continuous leak is pooling along the footpath outside the market entrance.", location: "Fergusson College Road, Ward 19", status: ComplaintStatus.IN_REVIEW, priority: ComplaintPriority.MEDIUM, departmentCode: "WATER" },
    { referenceNumber: "PMS-2026-000103", categoryCode: "WASTE", title: "Missed waste collection on lane", description: "Household waste has not been collected on the regular collection days this week.", location: "Kothrud, Ward 31", status: ComplaintStatus.SUBMITTED, priority: ComplaintPriority.MEDIUM, departmentCode: "SOLID_WASTE" },
  ];
  const demoStatuses = [ComplaintStatus.SUBMITTED, ComplaintStatus.IN_REVIEW, ComplaintStatus.IN_PROGRESS, ComplaintStatus.RESOLVED, ComplaintStatus.CLOSED];
  const demoPriorities = [ComplaintPriority.LOW, ComplaintPriority.MEDIUM, ComplaintPriority.HIGH, ComplaintPriority.URGENT];
  const categoryDepartment: Record<string, string> = { ROADS_TRAFFIC: "ROADS", WATER_DRAINAGE: "WATER", WASTE: "SOLID_WASTE", PUBLIC_HEALTH: "PUBLIC_HEALTH", PROPERTY_TAX: "PROPERTY_TAX", PARKS: "GARDENS", BUILDING: "BUILDING", CITIZEN_SERVICES: "CITIZEN_SERVICES" };
  const demoTitles: Record<string, string[]> = {
    ROADS_TRAFFIC: ["Pothole needs repair", "Street light not working", "Traffic signal timing issue", "Footpath obstruction"],
    WATER_DRAINAGE: ["Water supply interruption", "Leakage near residential lane", "Drain blockage reported", "Water logging after rain"],
    WASTE: ["Missed household waste collection", "Illegal dumping near road", "Public bin overflow", "Street cleanliness request"],
    PUBLIC_HEALTH: ["Mosquito control request", "Public sanitation concern", "Food safety inspection request"],
    PROPERTY_TAX: ["Property assessment review", "Property tax payment query", "Correction to property record"],
    PARKS: ["Park maintenance request", "Tree branch requires attention", "Playground equipment repair"],
    BUILDING: ["Building permit status request", "Unauthorized construction review"],
    CITIZEN_SERVICES: ["Certificate application follow-up", "Ward office service request", "Other municipal service request"],
  };
  const wards = ["14", "19", "31", "7", "22", "35", "12", "26"];
  const areas = ["Shivajinagar", "Deccan", "Kothrud", "Hadapsar", "Aundh", "Kondhwa", "Yerawada", "Baner"];
  const slaAgeFractions = [0.3, 0.8, 0.95, 1.1, 1.75];
  const generatedExamples = Array.from({ length: 60 }, (_, index) => {
    const category = categoryDefinitions[index % categoryDefinitions.length]!;
    const priority = demoPriorities[index % demoPriorities.length]!;
    const titleSet = demoTitles[category.code]!;
    return {
      referenceNumber: `PMS-${new Date().getFullYear()}-DEMO-${String(index + 1).padStart(3, "0")}`,
      categoryCode: category.code,
      title: titleSet[Math.floor(index / categoryDefinitions.length) % titleSet.length]!,
      description: `Resident report for ${areas[index % areas.length]} in Ward ${wards[index % wards.length]}. The service team is asked to inspect the location and record the required follow-up. Demo record ${index + 1}.`,
      location: `${areas[index % areas.length]}, Ward ${wards[index % wards.length]}`,
      status: demoStatuses[index % demoStatuses.length]!,
      priority,
      departmentCode: categoryDepartment[category.code]!,
      regionIndex: index % regions.length,
      wardCode: wards[index % wards.length]!,
      ageFraction: slaAgeFractions[Math.floor(index / demoStatuses.length) % slaAgeFractions.length]!,
      subcategoryIndex: Math.floor(index / categoryDefinitions.length) % category.subcategories.length,
      demoIndex: index,
    };
  });
  const allExamples = [
    ...examples.map((sample) => ({ ...sample, regionIndex: 0, wardCode: "14", ageFraction: 0.35, subcategoryIndex: 0, demoIndex: -1 })),
    ...generatedExamples,
  ];
  for (const sample of allExamples) {
    const category = await prisma.category.findUniqueOrThrow({ where: { organizationId_code: { organizationId: organization.id, code: sample.categoryCode } } });
    const severity = sample.priority === ComplaintPriority.URGENT ? "CRITICAL" : sample.priority === ComplaintPriority.LOW ? "LOW" : sample.priority === ComplaintPriority.HIGH ? "HIGH" : "MEDIUM";
    const sla = await prisma.sLAPolicy.findFirstOrThrow({ where: { organizationId: organization.id, priority: sample.priority, severity, categoryId: null, departmentId: null, isActive: true } });
    const startedAt = new Date(Date.now() - sla.resolutionMinutes * 60_000 * sample.ageFraction);
    const region = regions[sample.regionIndex]!;
    const subcategory = await prisma.subcategory.findFirstOrThrow({ where: { organizationId: organization.id, categoryId: category.id }, orderBy: { code: "asc" }, skip: sample.subcategoryIndex });
    const item = await prisma.complaintCase.upsert({ where: { organizationId_referenceNumber: { organizationId: organization.id, referenceNumber: sample.referenceNumber } }, update: {}, create: { organizationId: organization.id, referenceNumber: sample.referenceNumber, title: sample.title, description: sample.description, location: sample.location, status: sample.status, priority: sample.priority, severity, citizenProfileId: citizenProfile.id, createdByUserId: createdUsers.get("CITIZEN")!.id, categoryId: category.id, subcategoryId: subcategory.id, regionId: region.id, wardCode: sample.wardCode, departmentId: departments.get(sample.departmentCode)!.id, slaPolicyId: sla.id, slaPolicyNameSnapshot: sla.name, slaPolicySnapshot: { id: sla.id, name: sla.name, categoryId: sla.categoryId, departmentId: sla.departmentId, severity: sla.severity, priority: sla.priority, responseMinutes: sla.responseMinutes, resolutionMinutes: sla.resolutionMinutes }, slaDurationMinutesSnapshot: sla.resolutionMinutes, slaStartedAt: startedAt, slaDueAt: new Date(startedAt.getTime() + sla.resolutionMinutes * 60_000), createdAt: startedAt } });
    // Backfill only previously seeded demo rows that predate SLA snapshots; never reset an existing case clock.
    if (!item.slaDueAt) {
      await prisma.complaintCase.update({ where: { organizationId_id: { organizationId: organization.id, id: item.id } }, data: { severity, slaPolicyId: sla.id, slaPolicyNameSnapshot: sla.name, slaPolicySnapshot: { id: sla.id, name: sla.name, categoryId: sla.categoryId, departmentId: sla.departmentId, severity: sla.severity, priority: sla.priority, responseMinutes: sla.responseMinutes, resolutionMinutes: sla.resolutionMinutes }, slaDurationMinutesSnapshot: sla.resolutionMinutes, slaStartedAt: startedAt, slaDueAt: new Date(startedAt.getTime() + sla.resolutionMinutes * 60_000) } });
    }
    const initialHistory = await prisma.statusHistory.findFirst({ where: { organizationId: organization.id, caseId: item.id, toStatus: ComplaintStatus.SUBMITTED } });
    if (!initialHistory) await prisma.statusHistory.create({ data: { organizationId: organization.id, caseId: item.id, changedById: createdUsers.get("CITIZEN")!.id, toStatus: ComplaintStatus.SUBMITTED, note: "Case submitted" } });
    if (item.status !== ComplaintStatus.SUBMITTED && !await prisma.statusHistory.findFirst({ where: { organizationId: organization.id, caseId: item.id, toStatus: item.status } })) {
      await prisma.statusHistory.create({ data: { organizationId: organization.id, caseId: item.id, changedById: admin.id, fromStatus: ComplaintStatus.SUBMITTED, toStatus: item.status, note: "Initial routing review" } });
    }
    if (!await prisma.assignment.findFirst({ where: { organizationId: organization.id, caseId: item.id, endedAt: null } })) {
      const department = departments.get(sample.departmentCode)!;
      await prisma.assignment.create({ data: { organizationId: organization.id, caseId: item.id, teamId: department.teamId, assignedByUserId: admin.id, note: "Initial department routing" } });
    }
    if (sample.demoIndex >= 0 && item.status !== ComplaintStatus.RESOLVED && item.status !== ComplaintStatus.CLOSED) {
      const milestones = sample.ageFraction >= 1.5 ? ["breached", "extended-breach"] : sample.ageFraction >= 1 ? ["breached"] : [];
      for (const milestone of milestones) {
        const level = milestone === "breached" ? 3 : 4;
        const dedupeKey = `sla:${item.id}:${milestone}`;
        const escalation = await prisma.escalation.upsert({ where: { organizationId_caseId_dedupeKey: { organizationId: organization.id, caseId: item.id, dedupeKey } }, update: {}, create: { organizationId: organization.id, caseId: item.id, level, source: "SLA_AUTOMATION", dedupeKey, reason: `SLA ${milestone === "breached" ? "breach" : "extended breach"} recorded for the seeded demo case.` } });
        const auditId = `seed-audit-${item.id}-${milestone}`;
        const existingAudit = await prisma.auditLog.findFirst({ where: { organizationId: organization.id, id: auditId }, select: { id: true } });
        if (!existingAudit) await prisma.auditLog.create({ data: { id: auditId, organizationId: organization.id, actorUserId: null, caseId: item.id, action: `sla.escalation.${milestone}`, entityType: "Escalation", entityId: escalation.id, metadata: { level, dedupeKey, source: "DEVELOPMENT_SEED" } } });
        for (const recipient of [createdUsers.get("OFFICER")!, createdUsers.get("SUPERVISOR")!, createdUsers.get("DEPARTMENT_MANAGER")!]) {
          await prisma.notification.upsert({ where: { organizationId_userId_dedupeKey: { organizationId: organization.id, userId: recipient.id, dedupeKey } }, update: {}, create: { organizationId: organization.id, userId: recipient.id, caseId: item.id, type: milestone === "breached" ? "sla.breached" : "sla.extended-breach", payload: { referenceNumber: item.referenceNumber, state: milestone, dueAt: item.slaDueAt?.toISOString() }, dedupeKey } });
        }
      }
    }
  }

  console.info(`Seeded ${organization.name} (${organization.slug}), ${departmentDefinitions.length} departments, 7 role accounts, categories, SLAs, and ${allExamples.length} complaint cases with varied statuses, priorities, deadlines, and SLA escalations.`);
  if (!process.env.SEED_PASSWORD) console.info(`Development-only shared seed password (store securely): ${developmentPassword}`);
  else console.info("Seeded account passwords from SEED_PASSWORD.");
}

main().catch((error) => { console.error(error); process.exitCode = 1; }).finally(() => prisma.$disconnect());
