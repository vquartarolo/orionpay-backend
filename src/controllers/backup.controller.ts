import { Request, Response } from "express";
import fs from "fs";
import { backupToFile, exportDatabase } from "../services/backup.service";
import { AuditLog } from "../models/auditLog.model";

export async function createBackup(req: Request, res: Response): Promise<void> {
  try {
    const filePath = await backupToFile();
    const stats    = fs.statSync(filePath);

    AuditLog.create({
      actorUserId: req.authUser?.id ?? null,
      actorRole:   req.authUser?.role ?? "system",
      action:      "backup_created",
      targetType:  "config",
      targetId:    null,
      metadata:    { filePath, sizeBytes: stats.size },
      ipAddress:   req.ip ?? "",
      userAgent:   req.headers["user-agent"] ?? "",
    }).catch((err) => console.error("Audit backup:", err));

    res.status(200).json({
      status:    true,
      msg:       "Backup criado com sucesso.",
      filePath,
      sizeBytes: stats.size,
      createdAt: new Date(),
    });
  } catch (error) {
    console.error("Erro ao criar backup:", error);
    res.status(500).json({ status: false, msg: "Erro ao criar backup." });
  }
}

export async function downloadBackup(req: Request, res: Response): Promise<void> {
  try {
    const data     = await exportDatabase();
    const json     = JSON.stringify(data);
    const filename = `backup-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;

    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    res.setHeader("Content-Type", "application/json");
    res.send(json);
  } catch (error) {
    console.error("Erro ao gerar download do backup:", error);
    res.status(500).json({ status: false, msg: "Erro ao gerar backup." });
  }
}
