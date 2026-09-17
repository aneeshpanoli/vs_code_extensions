// push.ts — ONE JOB: put ONE notification into the shwab_docker → FCM pipeline that already reaches
// the owner's phone, without owning any part of that pipeline.
//
// ── THE DOOR, and why this one ────────────────────────────────────────────────────────────────
//
// MEASURED 2026-09-17 across the whole shwab_docker backend. There is NO create/send route: the six
// `api/notifications/…` routes are all read-side, the websocket consumer accepts only auth/mark_read/
// dismiss, `NotificationService` is not in the RPC registry, no management command and no celery task
// sends an arbitrary push, and there is no `admin.py` or post_save signal for the notification models.
// So an HTTP door does not exist and would have to be BUILT — ~12 lines across two files in a repo
// that belongs to another team and was being actively worked when this was written.
//
// The door that needs nothing built is Django's own `shell -c`, executed in the already-running
// container, calling the same service method the internal emitters call:
//
//   docker exec -e … shwab_docker-backend-1 python manage.py shell -c "<emit_system_alert>"
//
// It composes only code that already exists, and `docker-compose.yml` bind-mounts `./backend:/backend`
// so the container runs the repo's live code rather than a baked copy. ZERO lines change in
// shwab_docker, and zero in the Android app — see the category note below.
//
// ── WHY `emit_system_alert` AND NOT A `loom_stop` CATEGORY ─────────────────────────────────────
//
// This is the difference between zero app work and five edits in a live repo, and it went the good
// way. The Android client has FOUR independent category filters, all hardcoded:
//   · TradingFCMService.kt:85  `showCategories = setOf("RPM_BUY_CANDIDATE","RPM_SELL_CANDIDATE","SYSTEM","MARKET_GATE")`
//     — a category outside this set is inserted into Room and NEVER shown. No else branch. The phone
//     simply stays dark.
//   · NotificationDao.kt:14,43,51  `AND category IN ('RPM_BUY_CANDIDATE','RPM_SELL_CANDIDATE','SYSTEM')`
//     — the list and both unread counters.
//   · NotificationDao.kt:117-118  `deleteNotLatestBatch`: `WHERE category != 'SYSTEM' AND category != 'MARKET_GATE'`
//     — runs on app open, so a custom category would be HARD-DELETED the next time he opened the app.
//
// `emit_system_alert` forces `category="SYSTEM"` (service.py:535), which is on the right side of all
// four. A `loom_stop` category would have needed five edits in shwab_docker AND would still have been
// deleted on next open. The correct amount of app work here is zero, and it is zero because of the
// category choice, not by luck.
//
// ── CREDENTIALS: THIS MODULE HANDLES NONE ─────────────────────────────────────────────────────
//
// It never reads, copies, caches, bundles or logs the service account JSON, and never touches a device
// token — both live inside the container and stay there. The extension's entire credential surface is
// "may I talk to the docker socket". The direct-FCM alternative was rejected for exactly this: it
// would have required the service account file AND a Postgres read for tokens (they are FCMDevice
// rows, not a file), and would drift the day his app changes.
//
// ── INJECTION SAFETY ──────────────────────────────────────────────────────────────────────────
//
// A project name and a `last_line` written by another role end up in this message, so they are
// UNTRUSTED INPUT crossing into a Python interpreter. They are never interpolated into the code:
// the Python is a FIXED string that reads `os.environ`, the values ride as `docker exec -e` argv
// entries, and the whole thing goes through execFile with an argv ARRAY — no shell anywhere. There
// is no quoting to get wrong because nothing is quoted.

import { execFile } from "child_process";

/** Result of one send attempt. `delivered` is the ONLY thing that may latch a notification. */
export interface PushResult {
  delivered: boolean;
  /** Short, human-readable, safe to show in the panel and to log. Never contains a secret. */
  note: string;
}

export interface PushConfig {
  container: string;
  /** Seconds before we give up on the container. A tick must never hang on this. */
  timeoutSec: number;
}

export const DEFAULT_CONTAINER = "shwab_docker-backend-1";
export const DEFAULT_TIMEOUT_SEC = 20;

/** Runs a command and resolves with its outcome. Injectable so tests NEVER reach docker or a phone. */
export type Runner = (file: string, args: string[], env: Record<string, string>, timeoutMs: number)
  => Promise<{ code: number; stdout: string; stderr: string }>;

export const realRunner: Runner = (file, args, env, timeoutMs) =>
  new Promise((resolve) => {
    execFile(file, args, { timeout: timeoutMs, env: { ...process.env, ...env } },
      (err: any, stdout: string, stderr: string) => {
        const code = err ? (typeof err.code === "number" ? err.code : 1) : 0;
        resolve({ code, stdout: String(stdout ?? ""), stderr: String(stderr ?? "") });
      });
  });

/** FIXED code. Reads its values from the environment — nothing is interpolated into it, ever. */
const EMIT_PY = [
  "import os",
  "from app.services.notification.service import NotificationService",
  "n = NotificationService.emit_system_alert(",
  "    severity='INFO', title=os.environ['LOOM_TITLE'], body=os.environ['LOOM_BODY'],",
  "    payload={'source': 'loom-session-tracker'}, dedup_key=os.environ['LOOM_KEY'])",
  // DEDUPED is not a delivery. emit_system_alert returns None when a row with this dedup_key is
  // already standing (service.py:542-544) and sends nothing — exit code 0 either way, so the return
  // value is the only thing that distinguishes them.
  "print('LOOMPUSH:' + ('SENT' if n else 'DEDUPED'))",
].join("\n");

/** Reads only WHETHER push is configured — never the file, never a token. */
const PREFLIGHT_PY = [
  "import os",
  "from django.conf import settings as s",
  "p = getattr(s, 'FCM_SERVICE_ACCOUNT_PATH', '')",
  "print('LOOMPUSH:READY:%s:%s' % (bool(getattr(s, 'FCM_ENABLED', False)), os.path.exists(p)))",
].join("\n");

function shellArgs(container: string, py: string): string[] {
  return ["exec", container, "python", "manage.py", "shell", "-c", py];
}

/**
 * Is the transport actually usable right now?
 *
 * WHY THIS EXISTS AS A SEPARATE CHECK, and it is not defensive padding. The pipeline FAILS SILENTLY
 * in the one way that matters: when the service account is missing, `firebase_push._get_app` logs and
 * returns None, `send_push_notification` returns without sending — but the DB row is still created and
 * `emit_system_alert` still returns a Notification (firebase_push.py:38-41, :66-68). The caller sees
 * success and the phone stays dark. A send alone therefore cannot tell "delivered" from "silently
 * dropped", so readiness is measured before the feature is allowed to claim it is on.
 */
export async function preflight(cfg: PushConfig, run: Runner = realRunner): Promise<PushResult> {
  const r = await run("docker", shellArgs(cfg.container, PREFLIGHT_PY), {}, cfg.timeoutSec * 1000);
  if (r.code !== 0) {
    const why = /is not running/i.test(r.stderr) ? "container is not running"
              : /No such container/i.test(r.stderr) ? "container not found"
              : /ENOENT|not found/i.test(r.stderr) ? "docker not available"
              : `docker exec failed (code ${r.code})`;
    return { delivered: false, note: `off — ${why}` };
  }
  const m = /LOOMPUSH:READY:(True|False):(True|False)/.exec(r.stdout);
  if (!m) return { delivered: false, note: "off — backend did not report push readiness" };
  if (m[1] !== "True") return { delivered: false, note: "off — FCM_ENABLED is false in the backend" };
  if (m[2] !== "True") return { delivered: false, note: "off — FCM service account not present in the backend" };
  return { delivered: true, note: "ready" };
}

/**
 * Send exactly one notification. Returns `delivered` only when the backend says it created and
 * broadcast a row — a dedupe, a dead container or a missing docker all return false, and a false
 * result must never latch.
 *
 * `key` must be unique per stop event. The column is UNIQUE and a repeat is silently swallowed as a
 * dedupe, so reusing a key is how a real stop would go unreported.
 *
 * NOTE what is deliberately NOT in the payload: `as_of_date`. The Android handler runs
 * `dismissOlderBatch(category, as_of_date)` whenever that key is present (TradingFCMService.kt:60-65),
 * which would dismiss the owner's existing on-device SYSTEM alerts. Sending it would make this
 * feature destroy his other notifications.
 */
export async function sendPush(cfg: PushConfig, title: string, body: string, key: string,
                               run: Runner = realRunner): Promise<PushResult> {
  const args = ["exec",
    "-e", `LOOM_TITLE=${title}`,
    "-e", `LOOM_BODY=${body}`,
    "-e", `LOOM_KEY=${key}`,
    cfg.container, "python", "manage.py", "shell", "-c", EMIT_PY];
  const r = await run("docker", args, {}, cfg.timeoutSec * 1000);
  if (r.code !== 0) {
    const why = /is not running/i.test(r.stderr) ? "container is not running"
              : /No such container/i.test(r.stderr) ? "container not found"
              : `docker exec failed (code ${r.code})`;
    return { delivered: false, note: why };
  }
  if (/LOOMPUSH:SENT/.test(r.stdout)) return { delivered: true, note: "sent" };
  if (/LOOMPUSH:DEDUPED/.test(r.stdout)) {
    return { delivered: false, note: "backend deduped it — an alert with this key is already standing" };
  }
  return { delivered: false, note: "backend did not confirm the send" };
}

/** Stable, unique per stop: the project plus the exact activity watermark it is reporting. */
export function pushKey(repo: string, stoppedAt: number): string {
  return `loom_stop_${repo}_${stoppedAt}`.slice(0, 200);   // dedup_key is varchar(200)
}
