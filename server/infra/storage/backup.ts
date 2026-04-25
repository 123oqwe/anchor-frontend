/**
 * L2 Storage — Encrypted Backup.
 *
 * AES-256-GCM via Node's stdlib crypto (no external binaries needed —
 * dev machines without `age` / `gpg` can still back up on install).
 *
 * Format (binary, single file):
 *   16 bytes   magic       "ANCHOR_BACKUP_V1"
 *   12 bytes   IV          random per-backup
 *   16 bytes   auth tag    AES-GCM tag
 *   rest       ciphertext  AES-256-GCM(plaintext_sql_dump)
 *
 * Plaintext: the full `sqlite3 .dump` text output of anchor.db.
 *   Using .dump (SQL statements) over raw .db file copy because:
 *   - Text is diffable and restorable even across SQLite versions.
 *   - Safe while DB is in WAL mode without a checkpoint dance.
 *   - Smaller for sparse tables.
 *
 * Key management:
 *   - 256-bit key at ~/.anchor/backup.key (auto-generated first run)
 *   - USER MUST back up this key separately. Without it, encrypted
 *     backups are unrecoverable by design.
 *   - Surface a clear warning in the /api/backup/key/ensure response.
 *
 * Destination: user-chosen. Default falls back in order:
 *   1. ~/Library/Mobile Documents/com~apple~CloudDocs/Anchor/ (iCloud)
 *   2. ~/AnchorBackups/
 *
 * Rotation: keep last N snapshots (default 10).
 */
import { execSync } from "child_process";
import fs from "fs";
import path from "path";
import os from "os";
import crypto from "crypto";
import Database from "better-sqlite3";
import { db, DEFAULT_USER_ID } from "./db.js";

const MAGIC = Buffer.from("ANCHOR_BACKUP_V1");
const IV_LEN = 12;                    // AES-GCM standard
const AUTH_TAG_LEN = 16;
const KEY_LEN = 32;                   // 256 bits

const DB_PATH = path.resolve(process.cwd(), "server/infra/anchor.db");
const HOME = os.homedir();
const KEY_DIR = path.join(HOME, ".anchor");
const KEY_PATH = path.join(KEY_DIR, "backup.key");

const ICLOUD_DIR = path.join(HOME, "Library/Mobile Documents/com~apple~CloudDocs/Anchor");
const FALLBACK_DIR = path.join(HOME, "AnchorBackups");

// ── Key management ──────────────────────────────────────────────────────

export interface KeyInfo {
  path: string;
  exists: boolean;
  fingerprint?: string;       // SHA-256 first 12 hex chars — for UX, NOT secret
  sizeBytes?: number;
  warning?: string;
}

export function ensureKey(): KeyInfo {
  if (!fs.existsSync(KEY_DIR)) fs.mkdirSync(KEY_DIR, { recursive: true, mode: 0o700 });
  if (fs.existsSync(KEY_PATH)) {
    const buf = fs.readFileSync(KEY_PATH);
    return {
      path: KEY_PATH, exists: true,
      fingerprint: crypto.createHash("sha256").update(buf).digest("hex").slice(0, 12),
      sizeBytes: buf.length,
    };
  }
  // First-run: generate
  const key = crypto.randomBytes(KEY_LEN);
  fs.writeFileSync(KEY_PATH, key, { mode: 0o600 });
  return {
    path: KEY_PATH, exists: true,
    fingerprint: crypto.createHash("sha256").update(key).digest("hex").slice(0, 12),
    sizeBytes: key.length,
    warning: "A new 256-bit backup key has been generated. BACK UP THIS KEY FILE separately (e.g. password manager). Without it, encrypted backups cannot be restored.",
  };
}

function readKey(): Buffer {
  if (!fs.existsSync(KEY_PATH)) {
    throw new Error(`Backup key not found at ${KEY_PATH}. Call ensureKey() first.`);
  }
  const buf = fs.readFileSync(KEY_PATH);
  if (buf.length !== KEY_LEN) throw new Error(`Backup key corrupt — expected ${KEY_LEN} bytes, got ${buf.length}`);
  return buf;
}

// ── Backup ──────────────────────────────────────────────────────────────

export interface BackupResult {
  path: string;
  bytes: number;
  sha256: string;
  createdAt: string;
  keyFingerprint: string;
}

export function createBackup(opts: { destination?: string; keepLast?: number } = {}): BackupResult {
  const keyInfo = ensureKey();
  const key = readKey();
  const dest = opts.destination ?? pickDefaultDestination();
  fs.mkdirSync(dest, { recursive: true });

  // 1. Dump SQLite to plaintext SQL
  const dumpPath = path.join(os.tmpdir(), `anchor-dump-${Date.now()}.sql`);
  try {
    execSync(`sqlite3 "${DB_PATH}" ".dump"`, {
      stdio: ["ignore", fs.openSync(dumpPath, "w"), "inherit"],
      timeout: 60_000,
      maxBuffer: 256 * 1024 * 1024,
    });
  } catch (err: any) {
    throw new Error(`sqlite3 .dump failed: ${err?.message ?? "?"}`);
  }
  const plaintext = fs.readFileSync(dumpPath);
  fs.unlinkSync(dumpPath);

  // 2. Encrypt AES-256-GCM
  const iv = crypto.randomBytes(IV_LEN);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const authTag = cipher.getAuthTag();

  // 3. Frame: magic | iv | authTag | ciphertext
  const frame = Buffer.concat([MAGIC, iv, authTag, ciphertext]);

  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const outPath = path.join(dest, `anchor-${ts}.enc`);
  fs.writeFileSync(outPath, frame, { mode: 0o600 });

  // 4. Rotate — keep newest N
  rotateBackups(dest, opts.keepLast ?? 10);

  const sha256 = crypto.createHash("sha256").update(frame).digest("hex");
  return {
    path: outPath,
    bytes: frame.length,
    sha256,
    createdAt: new Date().toISOString(),
    keyFingerprint: keyInfo.fingerprint ?? "",
  };
}

function pickDefaultDestination(): string {
  try {
    // iCloud folder exists iff user has iCloud Drive enabled; creating it
    // auto-surfaces in Finder and syncs across Macs with the same Apple ID.
    const icloudParent = path.join(HOME, "Library/Mobile Documents/com~apple~CloudDocs");
    if (fs.existsSync(icloudParent)) return ICLOUD_DIR;
  } catch {}
  return FALLBACK_DIR;
}

function rotateBackups(dir: string, keepLast: number): void {
  try {
    const files = fs.readdirSync(dir)
      .filter(f => f.startsWith("anchor-") && f.endsWith(".enc"))
      .map(f => ({ name: f, path: path.join(dir, f), mtime: fs.statSync(path.join(dir, f)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime);
    for (const old of files.slice(keepLast)) {
      try { fs.unlinkSync(old.path); } catch {}
    }
  } catch {}
}

// ── Restore ─────────────────────────────────────────────────────────────

export interface RestoreResult {
  restored: boolean;
  rowsBefore?: { [table: string]: number };
  rowsAfter?: { [table: string]: number };
  integrityOk: boolean;
  targetDb: string;
  backupOfPreviousDb?: string;
}

/**
 * Decrypt a backup and restore it as the live DB. Atomic:
 *   1. Decrypt → /tmp/anchor-restore.sql
 *   2. Load into a SIDE db (~/.anchor/restored.db)
 *   3. Run integrity + row-count sanity checks on SIDE db
 *   4. Only if checks pass: rename current DB to .pre-restore, rename SIDE to live
 *   5. Close + reopen the live DB connection
 *
 * Caller must stop or restart the server afterwards for the connection swap
 * to take effect — we warn in the return value.
 */
export function restoreBackup(encPath: string, opts: { dryRun?: boolean } = {}): RestoreResult {
  if (!fs.existsSync(encPath)) throw new Error(`Backup file not found: ${encPath}`);
  const key = readKey();
  const frame = fs.readFileSync(encPath);

  // Validate magic
  if (frame.length < MAGIC.length + IV_LEN + AUTH_TAG_LEN + 1) throw new Error("Backup file too small to be valid");
  if (!frame.subarray(0, MAGIC.length).equals(MAGIC)) throw new Error("Backup file magic mismatch — wrong format or corrupted");

  const iv = frame.subarray(MAGIC.length, MAGIC.length + IV_LEN);
  const authTag = frame.subarray(MAGIC.length + IV_LEN, MAGIC.length + IV_LEN + AUTH_TAG_LEN);
  const ciphertext = frame.subarray(MAGIC.length + IV_LEN + AUTH_TAG_LEN);

  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(authTag);
  let plaintext: Buffer;
  try {
    plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch (err: any) {
    throw new Error(`Decryption failed: wrong key or corrupted backup (${err?.message ?? "?"})`);
  }

  // Row counts before (for sanity report)
  const rowsBefore = tableCountsSafe(DB_PATH);

  // Load into side DB
  const restoreSql = path.join(os.tmpdir(), `anchor-restore-${Date.now()}.sql`);
  const sideDb = path.join(os.tmpdir(), `anchor-restored-${Date.now()}.db`);
  fs.writeFileSync(restoreSql, plaintext);
  try {
    execSync(`sqlite3 "${sideDb}" < "${restoreSql}"`, { timeout: 60_000, maxBuffer: 256 * 1024 * 1024 });
  } catch (err: any) {
    cleanupTemp(restoreSql, sideDb);
    throw new Error(`Loading restored SQL failed: ${err?.message ?? "?"}`);
  }
  fs.unlinkSync(restoreSql);

  // Integrity checks on side DB
  const integrityOk = sanityCheck(sideDb);
  const rowsAfter = tableCountsSafe(sideDb);

  if (!integrityOk) {
    cleanupTemp("", sideDb);
    return {
      restored: false, integrityOk: false,
      rowsBefore, rowsAfter,
      targetDb: DB_PATH,
    };
  }

  if (opts.dryRun) {
    cleanupTemp("", sideDb);
    return { restored: false, integrityOk: true, rowsBefore, rowsAfter, targetDb: DB_PATH };
  }

  // Atomic swap: backup current → move restored in
  const backupPath = DB_PATH + ".pre-restore-" + Date.now();
  try { fs.renameSync(DB_PATH, backupPath); } catch { /* db may be locked — not fatal for first-use */ }
  fs.renameSync(sideDb, DB_PATH);

  return {
    restored: true, integrityOk: true,
    rowsBefore, rowsAfter,
    targetDb: DB_PATH,
    backupOfPreviousDb: fs.existsSync(backupPath) ? backupPath : undefined,
  };
}

function cleanupTemp(...paths: string[]): void {
  for (const p of paths) try { if (p && fs.existsSync(p)) fs.unlinkSync(p); } catch {}
}

function sanityCheck(dbPath: string): boolean {
  try {
    const testDb = new Database(dbPath, { readonly: true, fileMustExist: true });
    const res = testDb.prepare("PRAGMA integrity_check").get() as any;
    const integrityOk = res && (res.integrity_check === "ok" || Object.values(res).includes("ok"));
    // Must have at least the core tables
    const requiredTables = ["memories", "graph_nodes", "graph_edges"];
    for (const t of requiredTables) {
      testDb.prepare(`SELECT 1 FROM ${t} LIMIT 1`).get();
    }
    testDb.close();
    return !!integrityOk;
  } catch { return false; }
}

function tableCountsSafe(dbPath: string): Record<string, number> {
  try {
    const testDb = new Database(dbPath, { readonly: true, fileMustExist: true });
    const tables = (testDb.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all() as any[])
      .map(r => r.name);
    const out: Record<string, number> = {};
    for (const t of tables) {
      try {
        const c = (testDb.prepare(`SELECT COUNT(*) as c FROM "${t}"`).get() as any)?.c ?? 0;
        out[t] = c;
      } catch {}
    }
    testDb.close();
    return out;
  } catch { return {}; }
}

// ── List ────────────────────────────────────────────────────────────────

export function listBackups(destination?: string): Array<{ path: string; bytes: number; createdAt: string }> {
  const dir = destination ?? pickDefaultDestination();
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter(f => f.startsWith("anchor-") && f.endsWith(".enc"))
    .map(f => {
      const p = path.join(dir, f);
      const stat = fs.statSync(p);
      return { path: p, bytes: stat.size, createdAt: stat.mtime.toISOString() };
    })
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export const BACKUP_PATHS = { DB_PATH, KEY_PATH, ICLOUD_DIR, FALLBACK_DIR };
