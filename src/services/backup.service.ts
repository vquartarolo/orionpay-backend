import mongoose from "mongoose";
import fs from "fs";
import path from "path";

export async function exportDatabase(): Promise<Record<string, unknown[]>> {
  const db = mongoose.connection.db;
  if (!db) throw new Error("Banco de dados não conectado.");

  const collections = await db.listCollections().toArray();
  const result: Record<string, unknown[]> = {};

  for (const col of collections) {
    const name = col.name;
    if (name.startsWith("system.")) continue;
    result[name] = await db.collection(name).find({}).limit(10_000).toArray();
  }

  return result;
}

export async function backupToFile(): Promise<string> {
  const data      = await exportDatabase();
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const filename  = `backup-${timestamp}.json`;
  const backupDir = path.join(process.cwd(), "backups");

  if (!fs.existsSync(backupDir)) fs.mkdirSync(backupDir, { recursive: true });

  const filePath = path.join(backupDir, filename);
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), "utf-8");

  return filePath;
}
