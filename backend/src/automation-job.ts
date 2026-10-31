import dotenv from "dotenv";
import { PrismaClient } from "@prisma/client";
import { runSlaAutomation } from "./automation";

dotenv.config({ path: "../.env" });
const prisma = new PrismaClient();
const once = process.argv.includes("--once");
let running = false;

async function run() {
  if (running) return;
  running = true;
  try {
    const results = await runSlaAutomation(prisma);
    console.info(JSON.stringify({ job: "sla-monitor", completedAt: new Date().toISOString(), results }, null, 2));
  } catch (error) {
    console.error("SLA automation run failed", error);
    if (once) process.exitCode = 1;
  } finally { running = false; }
}

async function shutdown() { await prisma.$disconnect(); process.exit(); }
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());

if (once) {
  run().finally(() => prisma.$disconnect());
} else {
  const intervalSeconds = Math.min(3600, Math.max(15, Number(process.env.SLA_PROCESS_INTERVAL_SECONDS) || 60));
  console.info(`SLA scheduler started; polling every ${intervalSeconds}s.`);
  void run();
  setInterval(() => void run(), intervalSeconds * 1000);
}
