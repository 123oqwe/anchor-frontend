/**
 * Encrypted Backup routes. Mount at /api/backup.
 *
 * Security note: these endpoints are gated by the server already running
 * on localhost — there's no auth layer here because Anchor is local-first.
 * The key file at ~/.anchor/backup.key is 0600 and only readable by the
 * user's shell process.
 */
import { Router } from "express";
import {
  createBackup, restoreBackup, listBackups,
  ensureKey, BACKUP_PATHS,
} from "../infra/storage/backup.js";

const router = Router();

router.get("/key", (_req, res) => {
  res.json(ensureKey());
});

router.get("/list", (req, res) => {
  const destination = typeof req.query.destination === "string" ? req.query.destination : undefined;
  res.json({ backups: listBackups(destination), destination: destination ?? null, paths: BACKUP_PATHS });
});

router.post("/create", (req, res) => {
  try {
    const result = createBackup({
      destination: req.body?.destination,
      keepLast: req.body?.keepLast,
    });
    res.json(result);
  } catch (err: any) {
    res.status(500).json({ error: err?.message ?? "backup failed" });
  }
});

router.post("/restore", (req, res) => {
  const { path, dryRun } = req.body ?? {};
  if (typeof path !== "string") return res.status(400).json({ error: "path required" });
  try {
    const result = restoreBackup(path, { dryRun: !!dryRun });
    res.json(result);
  } catch (err: any) {
    res.status(500).json({ error: err?.message ?? "restore failed" });
  }
});

router.post("/restore/dry-run", (req, res) => {
  const { path } = req.body ?? {};
  if (typeof path !== "string") return res.status(400).json({ error: "path required" });
  try {
    res.json(restoreBackup(path, { dryRun: true }));
  } catch (err: any) {
    res.status(500).json({ error: err?.message ?? "dry-run failed" });
  }
});

export default router;
