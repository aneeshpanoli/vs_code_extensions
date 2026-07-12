// locks.ts — ONE JOB: persist per-project "do-not-delete" locks (Photoshop-style layer lock).
// A locked role can NEVER be retired until explicitly unlocked — user-controlled protection on top of the
// structural boundary. Persisted per project so it survives reloads. Atomic, no-throw I/O.

import * as fs from "fs";
import * as os from "os";
import * as path from "path";

const LOOM_ROOT = path.join(os.homedir(), ".claude", "loom");
const fileFor = (repo: string) => path.join(LOOM_ROOT, repo, "session-locks.json");

export function listLocks(repo: string): Set<string> {
  try {
    const d = JSON.parse(fs.readFileSync(fileFor(repo), "utf8"));
    return new Set(Array.isArray(d && d.locked) ? d.locked : []);
  } catch { return new Set(); }
}

export function isLocked(repo: string, role: string): boolean {
  return listLocks(repo).has(role);
}

export function setLock(repo: string, role: string, locked: boolean): boolean {
  const s = listLocks(repo);
  if (locked) s.add(role); else s.delete(role);
  const f = fileFor(repo);
  try {
    const tmp = f + ".tmp." + process.pid;
    fs.writeFileSync(tmp, JSON.stringify({ locked: Array.from(s).sort() }, null, 2));
    fs.renameSync(tmp, f);
    return true;
  } catch { return false; }
}
