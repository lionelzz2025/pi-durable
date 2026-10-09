import { mkdir, chmod } from "node:fs/promises";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Credentials } from "./types.ts";
import { validateCredentials } from "./identity.ts";

/** Separate secret DB, never implicitly imports the legacy plugin's credentials.
 * Transactions make replacement crash-atomic without rename/unlink on Windows.
 * chmod is best-effort POSIX protection, NOT a Windows ACL/encryption guarantee.
 */
export const openCredentialStore = async (path: string) => {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(path);
  try {
    db.exec("PRAGMA busy_timeout = 250; PRAGMA journal_mode = DELETE; CREATE TABLE IF NOT EXISTS credential (id INTEGER PRIMARY KEY CHECK(id=1), value TEXT NOT NULL)");
    await chmod(path, 0o600);
  } catch (error) { db.close(); throw error; }
  let closed = false;
  return {
    load(): Credentials | undefined {
      const row = db.prepare("SELECT value FROM credential WHERE id=1").get();
      if (!row) return undefined;
      try { return validateCredentials(JSON.parse(String(row.value))); }
      catch { throw new Error("Invalid stored WeChat credentials; explicit login required"); }
    },
    save(value: Credentials): void {
      const credentials = validateCredentials(value);
      // Refuse implicit account/user switching; use a separate configured store.
      db.exec("BEGIN IMMEDIATE");
      try {
        const row = db.prepare("SELECT value FROM credential WHERE id=1").get();
        if (row) {
          const prior = validateCredentials(JSON.parse(String(row.value)));
          if (prior.accountId !== credentials.accountId || prior.userId !== credentials.userId) throw new Error("Credential identity change requires a separate store");
        }
        db.prepare("INSERT INTO credential(id,value) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value").run(JSON.stringify(credentials));
        db.exec("COMMIT");
      } catch (error) { db.exec("ROLLBACK"); throw error; }
    },
    close(): void { if (!closed) { closed = true; db.close(); } },
  };
};
