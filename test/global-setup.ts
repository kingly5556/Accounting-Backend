import { execSync } from "node:child_process";
import { PrismaClient } from "@prisma/client";

// Creates <db>_test if needed and applies every migration (incl. the hand-written
// CHECK constraint and immutability triggers) before any test runs.
export default async function setup() {
  const url = process.env.DATABASE_URL;
  if (!url || !/_test(\?|$)/.test(url)) {
    throw new Error("Refusing to run: DATABASE_URL must point at a *_test database");
  }
  const dbName = url.match(/\/([^/?]+)(\?|$)/)![1];
  const admin = new PrismaClient({ datasources: { db: { url: url.replace(`/${dbName}`, "/postgres") } } });
  try {
    const exists = await admin.$queryRawUnsafe<{ n: number }[]>(
      `SELECT 1 AS n FROM pg_database WHERE datname = '${dbName}'`
    );
    if (exists.length === 0) await admin.$executeRawUnsafe(`CREATE DATABASE "${dbName}"`);
  } finally {
    await admin.$disconnect();
  }
  execSync("npx prisma migrate deploy", { stdio: "pipe", env: { ...process.env, DATABASE_URL: url } });
}
