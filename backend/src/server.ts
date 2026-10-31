import { PrismaClient } from "@prisma/client";
import { createApp } from "./app";
import dotenv from "dotenv";

dotenv.config({ path: "../.env" });

const prisma = new PrismaClient();
const app = createApp(prisma);
const port = Number(process.env.API_PORT) || 4000;

const server = app.listen(port, () => console.info(`CivicResolve API listening on http://localhost:${port}`));
async function shutdown() {
  server.close();
  await prisma.$disconnect();
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
