import { mkdir, open, stat } from "node:fs/promises";
import { dirname } from "node:path";
import { DatabaseSync, backup } from "node:sqlite";
import { requireSeparateMigrationPaths } from "./migration.ts";

/** Consistent SQLite online-backup API, not a copy of the main file without WAL.
 * The exclusive connection refuses a running owner. Never overwrite a backup. */
export const backupStoppedDatabase = async (source: string, destination: string): Promise<void> => {
  requireSeparateMigrationPaths(source, destination);
  if (!(await stat(source)).isFile()) throw Error("Source database is not a file");
  await mkdir(dirname(destination), { recursive: true });
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(source);
    db.exec("PRAGMA busy_timeout=250; PRAGMA locking_mode=EXCLUSIVE");
    db.exec("BEGIN IMMEDIATE");
    try { db.prepare("SELECT count(*) FROM sqlite_master").get(); } finally { db.exec("COMMIT"); }
    // Only reserve the destination after proving the source is not owned.
    // Never remove a failed artifact automatically: inspect or recycle manually.
    const marker = await open(destination, "wx");
    await marker.close();
    await backup(db, destination);
    const verify = new DatabaseSync(destination, { readOnly: true });
    try {
      if (verify.prepare("PRAGMA integrity_check").get()?.integrity_check !== "ok") throw Error("Backup integrity check failed");
    } finally { verify.close(); }
    // On failure the reserved path remains for inspection, not a claimed good backup.
  } finally { db?.close(); }
};

/** Restore to a *new* database path. The existing database must first be stopped
 * and deliberately moved aside by the operator; no automatic destructive swap. */
export const restoreDatabaseToNewPath = async (backupPath: string, newPath: string): Promise<void> => {
  requireSeparateMigrationPaths(backupPath, newPath);
  // Integrity check on the source before reserving destination.
  const verify = new DatabaseSync(backupPath, { readOnly: true });
  try {
    if (verify.prepare("PRAGMA integrity_check").get()?.integrity_check !== "ok") throw Error("Backup integrity check failed");
  } finally { verify.close(); }
  await backupStoppedDatabase(backupPath, newPath);
};
