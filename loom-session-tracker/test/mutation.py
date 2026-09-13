#!/usr/bin/env python3
"""mutation.py — REINTRODUCE each defect this suite exists to catch, and require the suite to FAIL.

A green suite proves nothing on its own. On 2026-09-09 this project's suite went 349 -> 388 passing
across a night in which the LIVE system misrouted six different ways: it typed /model 38 times into a
diagnostic session, sent one project's resume into another project's tab, tagged a developer as the
orchestrator, let three usage limits sit expired for hours, and classified the Gita PO as a developer.
Every one of those passed the suite of the moment.

What separates a test that describes REALITY from one that merely describes the code is whether it
breaks when reality does. Each mutation below restores a defect that was actually live that night; a
mutation that SURVIVES means that defect could return unnoticed, and this script fails.

HOW A MUTANT IS GRADED — and why it is not the exit code (rewritten 2026-09-13). This script used to
call a mutant "caught" whenever `./test.sh` exited non-zero. That is only evidence if the suite is
GREEN without the mutation, and it was not: under LOOM_TEST_JOBS=1 — the mode every mutant runs in —
the suite was red at HEAD c0804c8, so every mutant inherited that one failure and every mutant was
scored caught. A no-op mutant would have been too. So the run now measures an unmutated BASELINE
first, REFUSES to grade anything against a red one (exit 2), and counts a mutant as caught only when
a test that PASSED on the baseline FAILS on the mutant — naming the tests. A no-op mutant is included
as a self-check and must be reported SURVIVED.

    ELECTRON_RUN_AS_NODE=1 codium ... -- run via: python3 test/mutation.py
"""
import subprocess, sys, os, pathlib, tempfile

ROOT = pathlib.Path(__file__).resolve().parent.parent
CODIUM = os.environ.get("CODIUM", "/usr/share/codium/codium")
TSC = f'ELECTRON_RUN_AS_NODE=1 {CODIUM} node_modules/typescript/bin/tsc -p ./'

# (name, file, find, replace) — `find` must be unique in the file, or the mutation is reported stale.
MUTATIONS = [
 ("`po` is not an owner role — the Gita PO could not be found at all",
  "src/naming.ts",
  'OWNER_CANONICAL, "productowner", "product_owner", "po", "owner", "orchestrator", "pm",',
  'OWNER_CANONICAL, "productowner",'),

 ("path evidence needs no corroboration — a stranger printing paths took the developer role",
  "src/tracker.ts",
  'const uncorroborated = c.source === "path" && owned !== this.repoFilter;',
  "const uncorroborated = false;"),

 ("a marker names the project too — one frame claimed by two windows at once",
  "src/tracker.ts",
  "const conflicts = owned !== null && owned !== this.repoFilter;",
  "const conflicts = false;"),

 ("path evidence ties with a sign-off — the longest frame wins the role",
  "src/tracker.ts",
  'let priority = c.source === "marker" ? 1.2 : c.purity;',
  "let priority = c.purity;"),

 ("the board no longer identifies the orchestrator's frame",
  "src/tracker.ts",
  "if (ownerFrames.has(f.webviewId)) {",
  'if (ownerFrames.has("no-such-frame")) {'),

 ("commands are typed into busy composers — /model reported success and never executed",
  "src/dispatch.ts",
  '.filter((a) => purpose === "message" || !busyRoles.has(a.role))',
  ".filter((a) => Boolean(a))"),

 ("a worker-named tag may be addressed as the orchestrator",
  "src/dispatch.ts",
  "if (!isOwnerRole(tag.role)) {",
  "if (!isOwnerRole(tag.role) && Boolean(0)) {"),

 ("the context cycle accepts a worker-named tag — one tick from /clear-ing a developer mid-task",
  "src/memory.ts",
  "if (!isOwnerRole(input.role)) {",
  "if (!isOwnerRole(input.role) && Boolean(0)) {"),

 ("a limit banner never expires — three sessions sat blocked for hours after their reset",
  "src/limits.ts",
  "const expired = !!(rec.notBefore && nowMs > rec.notBefore + RESET_GRACE_MS);",
  "const expired = false;"),

 ("the reset deadline slides forward on every tick",
  "src/limits.ts",
  "notBefore: (prev && prev.notBefore && info.notBefore) ? Math.min(prev.notBefore, info.notBefore)",
  "notBefore: (prev && prev.notBefore && info.notBefore) ? Math.max(prev.notBefore, info.notBefore)"),

 ("the bus's `<role>.id` files are not read — ReciEats' running orchestrator was invisible",
  "src/registry.ts",
  'if (!n.endsWith(".id")) continue;',
  "if (true) continue;"),

 ("a mixed marker set hides an owner sign-off — the PO classified as its own developer",
  "src/roles.ts",
  "if (markers.some((r) => isOwnerRole(r))) return { role: null, purity: 1, source: null };",
  "if (false) return { role: null, purity: 1, source: null };"),

 ("a declaration is honoured even when another bus makes the same one",
  "src/tracker.ts",
  "if (this.repoFilter && rivalDeclarers(this.repoFilter, d.webviewId).length) {",
  "if (this.repoFilter && 0) {"),

 ("a contested declaration ignores which mailbox is still being written",
  "src/registry.ts",
  "if (at > bestAt) { bestAt = at; best = r; }",
  "if (best === null) { bestAt = at; best = r; }"),

 ("a declared WORKER frame loses its role to a bystander printing its paths",
  "src/tracker.ts",
  "} else if (decl && !isOwnerRole(decl.role) && this.repoFilter) {",
  "} else if (decl && !isOwnerRole(decl.role) && this.repoFilter && Boolean(0)) {"),

 ("the model policy switches an owner-named role when the project is untagged",
  "src/models.ts",
  "      if (isOwnerRole(role)) continue;",
  "      if (isOwnerRole(role) && Boolean(0)) continue;"),

 ("the model policy types into the orchestrator's own frame",
  "src/models.ts",
  "      if (wid && orchestratorFrame && wid === orchestratorFrame) continue;",
  "      if (wid && orchestratorFrame && wid === orchestratorFrame && Boolean(0)) continue;"),

 ("/clear is sent on a single idle reading, not a confirmed run",
  "src/memory.ts",
  "      if (idleTicks < IDLE_TICKS_REQUIRED) {",
  "      if (idleTicks < 1) {"),

 ("a busy orchestrator does not reset the idle run",
  "src/memory.ts",
  "                    { ...state, idleTicks: 0 });",
  "                    { ...state });"),

 ("a blank shell is closed even though it is no longer blank (the reopen reused it)",
  "src/blanks.ts",
  "  return before.filter((w) => present.has(w) && stillBlank.has(w)).slice(0, limit);",
  "  return before.filter((w) => present.has(w)).slice(0, limit);"),

 ("a panel with identity in it counts as a blank shell",
  "src/blanks.ts",
  "  return !IDENTITY.test(t);",
  "  return true;"),

 ("an open request may name an orchestrator",
  "src/requests.ts",
  '    if (isOwnerRole(role)) { refused.push({ role: raw, reason: "an orchestrator is never opened this way" }); continue; }',
  "    if (false) { continue; }"),

 ("an open request ignores the active-session cap",
  "src/requests.ts",
  '    if (open.length + spawn.length >= slots) { refused.push({ role: raw, reason: "active-session cap reached" }); continue; }',
  '    if (open.length + spawn.length >= slots && Boolean(0)) { refused.push({ role: raw, reason: "active-session cap reached" }); continue; }'),

 ("a stale open request is served anyway",
  "src/requests.ts",
  "  if (req.requestedAt && (!Number.isFinite(age) || age > REQUEST_TTL_MS)) {",
  "  if (req.requestedAt && Boolean(0)) {"),

 ("closeWebview closes windows again (the 2026-09-12 three-window loss)",
  "src/cdp.ts",
  '  if (process.env.LOOM_ALLOW_WINDOW_CLOSE !== "1") {',
  '  if (process.env.LOOM_ALLOW_WINDOW_CLOSE === "never-set") {'),

 ("the restart path imports the window-closing call",
  "src/extension.ts",
  'import { readFrames } from "./cdp";',
  'import { readFrames, closeWebview } from "./cdp";\nvoid closeWebview;'),

 ("clicking a role opens a stale transcript in a NEW tab (a duplicate)",
  "src/focus.ts",
  "  if (ageMs > FRESH_MS) {",
  "  if (ageMs > FRESH_MS && Boolean(0)) {"),

 ("a dead declared frame hides the live orchestrator candidate",
  "src/statusView.ts",
  '        !all.some((x) => x.declared && x.liveness === "live" && x.repo === o.repo))',
  "        !all.some((x) => x.declared && x.repo === o.repo))"),

 ("a role with no transcript is refused instead of spawned",
  "src/requests.ts",
  "    spawn.push(role);",
  '    refused.push({ role: raw, reason: "no transcript" });'),

 ("a transcript written under another cwd is treated as resumable from this window (the blank-tab bug, 2026-09-13)",
  "src/reopen.ts",
  "  if (!windowCwd) return true;",
  "  if (!windowCwd || Boolean(1)) return true;"),

 ("a stranded spawn is not reported back to the orchestrator",
  "src/requests.ts",
  "    if (st) stranded.push(st);",
  "    if (st && Boolean(0)) stranded.push(st);"),

 ("the model policy retypes /model while the chip is still catching up with an acknowledged switch",
  "src/models.ts",
  "      if (info.acknowledged && wantChip.toLowerCase() === info.acknowledged.toLowerCase()) continue;",
  "      if (info.acknowledged && wantChip.toLowerCase() === info.acknowledged.toLowerCase() && Boolean(0)) continue;"),

 ("the orchestrator is promoted while it is mid-turn (the command would queue as a message)",
  "src/models.ts",
  "    if (!this.repo || !orchestratorRole || !orchestratorFrame || !info || busy) return null;",
  "    if (!this.repo || !orchestratorRole || !orchestratorFrame || !info) return null;"),

 ("a panel with no compact button no longer vetoes the transcript estimate (the fourteen-clear night, 2026-09-13)",
  "src/memory.ts",
  "  if (!fromPanel && input.frameSeen && input.panelChars !== null && input.panelChars >= CLEARED_PANEL_CHARS &&",
  "  if (!fromPanel && input.frameSeen && input.panelChars !== null && input.panelChars >= CLEARED_PANEL_CHARS && Boolean(0) &&"),

 ("a transcript that stopped before the last clear is still read as the session",
  "src/memory.ts",
  "    if (mtime < state.lastCycleAt) {",
  "    if (mtime < state.lastCycleAt && Boolean(0)) {"),

 ("a session id present in two project directories is read from whichever copy is found first",
  "src/context.ts",
  "      if (st.isFile() && (!best || st.mtimeMs > best.mtime)) best = { file: f, mtime: st.mtimeMs };",
  "      if (st.isFile() && !best) best = { file: f, mtime: st.mtimeMs };"),

 ("the board is not rebound to the fresh session after /clear (the dead-id loop can start again)",
  "src/extension.ts",
  '      if (step.kind === "restore" && step.next.sessionId && step.next.sessionId !== state.sessionId &&',
  '      if (step.kind === "restore" && Boolean(0) && step.next.sessionId && step.next.sessionId !== state.sessionId &&'),

 ("the context threshold silently back at 50% — the context is re-read every turn, so its length is the cost",
  "src/memory.ts",
  "enabled: true, thresholdPct: 30, saveTimeoutMinutes: 10",
  "enabled: true, thresholdPct: 50, saveTimeoutMinutes: 10"),

 ("the restore prompt no longer forbids watchers — a wake loop that costs the whole context each time",
  "src/memory.ts",
  """    `Do NOT arm watchers, Monitors or /loop in this session: the session-tracker wakes you when a role ` +
    `finishes, stalls or is resumed, and every wake costs your whole context (playbook \u00a717). ` +
""",
  "    `` +\n"),

 ("an oversize memory is banked without a word — every fresh context pays for it forever",
  "src/memory.ts",
  "input.memorySize > MAX_MEMORY_BYTES",
  "input.memorySize > MAX_MEMORY_BYTES && Boolean(0)"),

 ("a switch acknowledged before a later turn still counts as fresh (the chip has had its chance)",
  "src/models.ts",
  '  if (before.includes("You:") || since.includes("You:")) return null;',
  '  if (before.includes("You:")) return null;'),

 ("the post-/clear restore no longer tells the orchestrator it can open its own roles",
  "src/memory.ts",
  "    ` If any role's tab is missing, do not ask a person and do not park its work: write ` +",
  "    ` ` +"),

 ("the restart wake no longer tells the orchestrator it can open its own roles",
  "src/extension.ts",
  '        "If a role\'s tab did NOT come back, do not wait for a person and do not hold its lane: write " +',
  '        "" +'),

 ("a frame from another window is claimed as this project's worker (the Lumen/ReciEats developer1)",
  "src/tracker.ts",
  "      if (!this.inMyWindow(f, validRoles)) continue;",
  "      if (!this.inMyWindow(f, validRoles) && Boolean(0)) continue;"),

 ("the extension's notifications carry no return address",
  "src/inject.ts",
  '                ...senderArgs(debugName, target.repo ?? null)];',
  "                ];"),

 ("the clock form of the banner is unparseable — `resets 9:50pm` yielded no deadline",
  "src/limits.ts",
  "const c = RESETS_AT_RE.exec(tail);",
  'const c = RESETS_AT_RE.exec("");'),
 # ── garbage collection (0.33.0). Each safeguard below is a way a collector could destroy something
 # the machine still needs; a mutant that survives means that particular loss could happen unnoticed.
 ("a transcript a bus still references is collected anyway (the wrong-lookup hazard, restored)",
  "src/gc.ts",
  "    if (referenced.has(sid)) continue;                        // something on the bus points at it",
  "    if (referenced.has(sid) && Boolean(0)) continue;"),

 ("the newest transcript in a project dir is collectable — the session a /clear would resume from",
  "src/gc.ts",
  "    if (newestPerDir.get(t.projectDir) === t.file) continue;  // the freshest in its dir IS that dir's session",
  "    if (newestPerDir.get(t.projectDir) === t.file && Boolean(0)) continue;"),

 ("an ORCHESTRATOR's board entry may be marked dead — the entry that re-finds it after a /clear",
  "src/gc.ts",
  "  if (isOwnerRole(role)) return null;",
  "  if (isOwnerRole(role) && Boolean(0)) return null;"),

 ("a LIVE role's board entry may be marked dead — a fresh session's id lags its transcript",
  "src/gc.ts",
  "  if (liveRoles.has(`${repo}/${role}`)) return null;",
  "  if (liveRoles.has(`${repo}/${role}`) && Boolean(0)) return null;"),

 ("a DIRTY orphan worktree is offered for removal — uncommitted work is not garbage",
  "src/gc.ts",
  '        w.dirty ? "uncommitted work" : "",',
  '        false ? "uncommitted work" : "",'),

 ("an orphan worktree backing a LIVE session is offered for removal",
  "src/gc.ts",
  '        w.live ? "a LIVE session" : "",',
  '        false ? "a LIVE session" : "",'),

 ("an UNMERGED orphan worktree is offered for removal — its commits are on no other branch",
  "src/gc.ts",
  '        merged === false ? `unmerged (${w.ahead ?? "?"} commit(s) ahead)` : "",',
  '        false ? `unmerged (${w.ahead ?? "?"} commit(s) ahead)` : "",'),

 ("a build is archived without knowing which one the editor loads (uninstall from under it)",
  "src/gc.ts",
  '    plan.notes.push("extensions.json unreadable — no deployed build is collectable this run");\n    return;',
  '    plan.notes.push("extensions.json unreadable — no deployed build is collectable this run");'),

 ("the collector's cross-window lease is gone — seven windows collect the same files at once",
  "src/gc.ts",
  "  const heldByOther = !!state.owner && state.owner !== windowId && leaseAge >= 0 && leaseAge < LEASE_MS;",
  "  const heldByOther = false;"),

 ("the automatic pass ignores its own interval and runs on every activation",
  "src/gc.ts",
  "  if (state.lastRunAt && sinceLast >= 0 && sinceLast < every) {",
  "  if (state.lastRunAt && sinceLast >= 0 && sinceLast < every && Boolean(0)) {"),
 # ── GC-002 hardening (0.33.0). Each of these was a real hole in the first version of gc.ts, found
 # by adversarial review before it was banked; a survivor means that hole is open again.
 ("a build nine windows are still RUNNING is archived (the registry is not the runtime)",
  "src/gc.ts",
  "  for (const v of running.versions) keep.add(`${EXT_PREFIX}${v}`);",
  "  for (const v of running.versions) { void v; }"),

 ("a non-semver current version no longer refuses the extension tier (VERSION=unknown)",
  "src/gc.ts",
  "  if (!SEMVER_RE.test(input.currentVersion)) {",
  "  if (!SEMVER_RE.test(input.currentVersion) && Boolean(0)) {"),

 ("only the LAST registration in extensions.json is honoured",
  "src/gc.ts",
  "    if (typeof loc === \"string\" && loc) registered.add(path.basename(loc));",
  "    if (typeof loc === \"string\" && loc) { registered.clear(); registered.add(path.basename(loc)); }"),

 ("a LIVE role's transcript is archived when its bus is not one loomDirs() scans",
  "src/gc.ts",
  "    if (liveSessions.has(sid)) continue;",
  "    if (liveSessions.has(sid) && Boolean(0)) continue;"),

 ("a session id present only in a role's status.json is not a reference",
  "src/gc.ts",
  "      if (st && typeof st === \"object\") { add(st.session_id); add(st.sessionId); }",
  "      if (st && typeof st === \"object\" && Boolean(0)) { add(st.session_id); add(st.sessionId); }"),

 ("the applier hands scanWorktrees an EMPTY live set — removeWorktree's live refusal can never fire",
  "src/gc.ts",
  """          const live = new Set(Array.from(liveRoles)
            .filter((k) => k.startsWith(item.repo + "/")).map((k) => k.slice(item.repo!.length + 1)));""",
  "          const live = new Set<string>();"),

 ("a transcript whose session went LIVE between the plan and the click is archived anyway",
  "src/gc.ts",
  '        if (item.sessionId && liveSessionIds.has(item.sessionId)) reason = "its session is LIVE now";',
  '        if (item.sessionId && liveSessionIds.has(item.sessionId) && Boolean(0)) reason = "its session is LIVE now";'),

 ("a board entry is marked dead without re-asking whether it still is",
  "src/gc.ts",
  "  if (!deadEntryReason(repo, role, liveRoles, entry)) {",
  "  if (!deadEntryReason(repo, role, liveRoles, entry) && Boolean(0)) {"),

 ("a board entry rebound by a /clear since the plan is marked dead on its OLD id",
  "src/gc.ts",
  '  if (item.sessionId && sid !== item.sessionId) return "the entry was rebound since the plan was made";',
  '  if (item.sessionId && sid !== item.sessionId && Boolean(0)) return "the entry was rebound since the plan was made";'),

 ("a lease stamped in the FUTURE can never be broken (clock skew locks out every window)",
  "src/gc.ts",
  "  const heldByOther = !!state.owner && state.owner !== windowId && leaseAge >= 0 && leaseAge < LEASE_MS;",
  "  const heldByOther = !!state.owner && state.owner !== windowId && leaseAge < LEASE_MS;"),

 ("a lastRunAt in the FUTURE means the interval never elapses again",
  "src/gc.ts",
  "  if (state.lastRunAt && sinceLast >= 0 && sinceLast < every) {",
  "  if (state.lastRunAt && sinceLast < every) {"),

 ("a window refreshes a lease that belongs to another window",
  "src/gc.ts",
  "  if (state.owner !== windowId) return null;",
  "  if (state.owner !== windowId && Boolean(0)) return null;"),

 ("a DANGLING SYMLINK at the archive destination is overwritten instead of refused",
  "src/gc.ts",
  '  if (existsAny(dest)) return "destination already exists — left alone";',
  '  if (statOf(dest)) return "destination already exists — left alone";'),

 ("a copy verified against a TRUNCATED measurement counts as verified",
  "src/gc.ts",
  '  if (before.truncated || after.truncated) return "copy failed, source left in place (too large to verify)";',
  '  if ((before.truncated || after.truncated) && Boolean(0)) return "copy failed, source left in place (too large to verify)";'),

 ("a worktree named by a bus ALIAS of a live role reads as an orphan",
  "src/gc.ts",
  "      if (!w.orphaned || canon.has(canonical)) continue;",
  "      if (!w.orphaned) continue;"),

 ("a worktree one typo away from a real role is offered for removal (Gaming/protyping)",
  "src/gc.ts",
  '        near ? `its name is one typo away from the role "${near}"` : "",',
  '        false ? `its name is one typo away from the role "${near}"` : "",'),
 # ── GC-004: the DATA the collector is fed (second review). Each of these is a read that could not
 # answer, returning "nothing" where every guard downstream reads "nothing" as permission.
 ("an unreadable running-versions.json fails OPEN — a torn file archives the build nine windows run",
  "src/gc.ts",
  "  if (!running.readable) {",
  "  if (!running.readable && Boolean(0)) {"),

 ("the version stamp is keyed by PROJECT again — two windows on one project share a slot",
  "src/extension.ts",
  "          all[windowId] = { version: VERSION, at: new Date().toISOString(), repo: repo || null };",
  '          all[repo || "(no project)"] = { version: VERSION, at: new Date().toISOString(), repo: repo || null };'),

 ("the version stamp is written non-atomically — ten windows every 15s produce the torn file above",
  "src/extension.ts",
  """            const tmp = stamp + ".tmp." + process.pid;
            fs.writeFileSync(tmp, JSON.stringify(all, null, 2));
            fs.renameSync(tmp, stamp);""",
  "            fs.writeFileSync(stamp, JSON.stringify(all, null, 2));"),

 ("a TRUNCATED reference sweep reads as 'nothing references this'",
  "src/gc.ts",
  "  if (sweep.truncated) {",
  "  if (sweep.truncated && Boolean(0)) {"),

 ("a file over the size bound is skipped silently instead of truncating the sweep",
  "src/gc.ts",
  "      if (st.size > SCAN_MAX_FILE_BYTES) { truncated = true; continue; }",
  "      if (st.size > SCAN_MAX_FILE_BYTES) { continue; }"),

 ("the sweep's file budget runs out without saying so",
  "src/gc.ts",
  "      if (budget <= 0) { truncated = true; return; }",
  "      if (budget <= 0) { return; }"),

 ("a role that stopped writing status hours ago still counts as LIVE",
  "src/gc.ts",
  "      if (!st || !st.isFile() || now - st.mtimeMs > withinMs) continue;",
  "      if (!st || !st.isFile()) continue;"),

 ("the collector is handed only THIS window's live roles (the automatic pass is machine-wide)",
  "src/extension.ts",
  "      const roles = new Set<string>([...bus.roles, ...mine]);",
  "      const roles = new Set<string>([...mine]);"),

 ("a long pass never refreshes its claim — 700 MB of moves under a five-minute lease",
  "src/gc.ts",
  "    if (!opts.refresh || now() - lastWrite < refreshEvery) return;",
  "    if (!opts.refresh || now() - lastWrite < refreshEvery || Boolean(1)) return;"),

 ("finishing a pass clobbers a claim another window has taken over",
  "src/gc.ts",
  "  const ours = windowId === undefined || state.owner === undefined || state.owner === windowId;",
  "  const ours = true;"),

 ("a registration's `version` is ignored whenever it also carries a `location`",
  "src/gc.ts",
  "    if (e.version) registered.add(`${EXT_PREFIX}${e.version}`);",
  "    else if (e.version) registered.add(`${EXT_PREFIX}${e.version}`);"),

 ("the typo radius ignores how short the role name is (`po` shields `qa`)",
  "src/gc.ts",
  "        return r.length >= 5 ? d <= 2 : d <= 1 && d > 0;",
  "        return r.length >= 5 && d <= 2;"),

 ("session ids are compared case-sensitively — an uppercase board id protects nothing",
  "src/gc.ts",
  "    const sid = t.sid.toLowerCase();",
  "    const sid = t.sid;"),

 # ── GC-006 ────────────────────────────────────────────────────────────────────────────────────

 ("the version stamp WRITER fails open — any unreadable file starts from {} and erases the rest",
  "src/extension.ts",
  '            if (!e || e.code !== "ENOENT") stampNote = `read failed (${String(e && e.code || e)}) — not rewritten`;',
  "            void e;"),

 ("a stamp file that will not PARSE is replaced with this window's entry alone",
  "src/extension.ts",
  '            if (broke) stampNote = "unparseable — not rewritten";',
  '            if (broke) parsed = {};'),

 ("a stamp entry with an unparseable timestamp is never pruned, so the file grows for ever",
  "src/extension.ts",
  "              if (!Number.isFinite(at) || at < weekAgo) delete all[k];",
  "              if (Number.isFinite(at) && at < weekAgo) delete all[k];"),

 ("a stamp entry with an unparseable timestamp pins its build in the keep-set for ever",
  "src/gc.ts",
  "    if (!Number.isFinite(at) || now - at > withinMs) continue;",
  "    if (Number.isFinite(at) && now - at > withinMs) continue;"),

 ("a worktree whose role owns a mailbox but no board entry is collectable",
  "src/health.ts",
  "    return { role, path: p, orphaned: !roster.has(role), dirty, risky, ahead, live: liveRoles.has(role), branch };",
  "    return { role, path: p, orphaned: true, dirty, risky, ahead, live: liveRoles.has(role), branch };"),

 ("a long pass is never followed by a refresh — only preceded by one",
  "src/gc.ts",
  "    tryRefresh();\n  }\n  logGc(result);",
  "  }\n  logGc(result);"),

 ("the refresh throttle resets on an attempt that wrote nothing",
  "src/gc.ts",
  "    if (wrote !== false) lastWrite = now();",
  "    lastWrite = now();"),

 # ── MP-001, 2026-09-13: the handoff chooses the worker's tier, the tracker enforces it ──────────
 # Each of R1-R5 gets one, and each names the test that must die with it.

 # R1 — killed by "R1: a PREMIUM id is ignored and SAYS SO" and by the extension-level
 # "MP-001 R2: a PREMIUM id in a handoff types nothing". The premium FLOOR is checked on the table,
 # not on the allowlist, precisely so widening a setting cannot open the orchestrator's tier; making
 # it allowlist-only is the whole bug, and it looks like a harmless simplification.
 ("a premium id in a handoff is enforceable as soon as someone widens workerModels",
  "src/models.ts",
  "  if (idIsPremium(id)) {\n    return { ...def, note: `${role}: handoff asks for '${raw}' — the premium tier is orchestrator-only; ignored` };\n  }",
  "  if (false) {\n    return { ...def, note: `${role}: handoff asks for '${raw}' — the premium tier is orchestrator-only; ignored` };\n  }"),

 # R1 — killed by "R1: a `model:` line in the BODY is not frontmatter". A brief that merely
 # DISCUSSES a model would otherwise set the worker's tier.
 ("a `model:` line anywhere in a handoff's body sets the tier, not just its frontmatter",
  "src/models.ts",
  '  const m = /^\\uFEFF?[ \\t]*---[ \\t]*\\r?\\n([\\s\\S]*?)\\r?\\n[ \\t]*---[ \\t]*(?:\\r?\\n|$)/.exec(String(text || ""));',
  '  const m = /[ \\t]*---[ \\t]*\\r?\\n([\\s\\S]*?)\\r?\\n[ \\t]*---[ \\t]*(?:\\r?\\n|$)/.exec(String(text || ""));'),

 # R2 — killed by "policy: the desired tier is enforced in BOTH directions" and by
 # "MP-001 R2: a worker on Sonnet owed Opus is switched UP". Reverting to the premium-only test
 # restores exactly the pre-MP-001 behaviour: a handoff asking for Sonnet is silently ignored, and a
 # worker left on Sonnet is never brought back up. The suite would go green on a dead feature.
 ("the policy only forbids the premium tier again — the handoff's choice is never enforced",
  "src/models.ts",
  "      if (!onPremium && wantChip.toLowerCase() === String(info.model).toLowerCase()) {",
  "      if (!onPremium) {"),

 # R2 — killed by "policy: a target CHANGE restarts the backoff". A role that had backed off to the
 # 15-minute step on its old target would sit unswitched for a quarter of an hour after its handoff
 # asked for a new one — the slowest possible failure, and invisible.
 ("a changed target inherits the OLD target's backoff instead of restarting it",
  "src/models.ts",
  "      const sameGoal = !!rec && rec.model.toLowerCase() === info.model.toLowerCase()\n                            && normalizeId(rec.target || \"\") === normalizeId(want.model);",
  "      const sameGoal = !!rec && rec.model.toLowerCase() === info.model.toLowerCase();"),

 # R3 — killed by "MP-001 R3: the spawn path types /model BEFORE /loom". After the bind the composer
 # is busy, so a /model typed second queues as an ordinary message and NEVER runs (dispatch.ts): the
 # tab binds and silently stays on the wrong tier. Both commands are still sent, so every
 # count-based assertion still passes; only the ORDER catches it.
 ("the spawn path binds first and sets the tier afterwards, into a composer that is now busy",
  "src/extension.ts",
  "            const pm = { role, webviewId: wid, result: await premodel(role, wid) };\n            noteModel(\"spawn\", pm); debugLog({ spawnModel: pm });\n            const st = plan.stranded.find((x) => x.role === role);",
  "            const st = plan.stranded.find((x) => x.role === role);\n            setTimeout(() => premodel(role, wid), 0);"),

 # R4 — killed by "R4: two loop-backs on ONE handoff raise it to Opus; the third does not rewrite
 # again" (its "re-reading an unchanged status.json counts nothing" assertion). status.json is
 # re-read every tick, so counting per READ rather than per REPORT escalates on the first loop-back
 # within seconds — the judgement the rubric is supposed to be measuring never gets made.
 ("a loop-back is counted once per TICK rather than once per report",
  "src/models.ts",
  '    if (String(status.status || "") === "blocked" && seenAt !== rec.lastSeen) {',
  '    if (String(status.status || "") === "blocked") {'),

 # R4 — killed by "R4: escalation refuses once the inbox holds a DIFFERENT handoff". Between the
 # decision and the write the orchestrator may have written the NEXT brief over it; raising the tier
 # of a handoff nobody looped back on is worse than never escalating.
 ("escalation rewrites whatever handoff is in the inbox now, not the one that looped back",
  "src/models.ts",
  '    if (frontmatter(text)["id"] !== expectId) return false;            // a different handoff now',
  "    if (false) return false;            // a different handoff now"),

 # R5 — killed by "R5: a line is appended when the role reports idle … and it is not appended again
 # on every later tick". The inbox still holds the finished id and status.json still says idle, so
 # deleting the closed record has the next tick re-open and re-close the same block: one ledger line
 # per tick for as long as the worker sits idle, and every average computed from it is wrong.
 ("a closed ledger line is re-opened and re-appended on every tick the role stays idle",
  "src/models.ts",
  "    if (cur && cur.closed) return;",
  "    if (cur && cur.closed) delete led[role];"),

 # R5 — killed by "R5: the ledger is APPEND-only — an existing file is never rewritten".
 ("the ledger is rewritten rather than appended — every earlier block is lost",
  "src/models.ts",
  "      fs.appendFileSync(f, JSON.stringify(line) + \"\\n\");    // append-only: never read, never rewritten",
  "      fs.writeFileSync(f, JSON.stringify(line) + \"\\n\");"),

 # R5/R4 — killed by "R5/R4: state survives alongside pending — no section clobbers another".
 # saveState is change-only; comparing `pending` alone drops an escalation count or a ledger line
 # whose tick happened not to move a pending record — the counts silently reset to zero.
 ("the change-only state write compares `pending` alone, dropping escalation and ledger state",
  "src/models.ts",
  "      if (same(cur.pending, st.pending) && same(cur.escalations, st.escalations) && same(cur.ledger, st.ledger)) return;",
  "      if (same(cur.pending, st.pending)) return;"),
]

def sh(cmd):
    return subprocess.run(cmd, shell=True, cwd=ROOT, capture_output=True, text=True)

# REFUSE TO RUN OVER UNCOMMITTED WORK. This script used to restore each mutant with `git checkout -- src/`,
# which cannot tell a mutation from work in progress: on 2026-09-09 it silently destroyed an hour of
# uncommitted changes to registry.ts, roles.ts, tracker.ts and statusView.ts. Commit (or stash) first;
# the whole point of the tool is to run against the code you are about to trust.
dirty = sh("git status --porcelain -- src/").stdout.strip()
if dirty:
    print("REFUSING: src/ has uncommitted changes — mutants are copies of what is committed-and-built,\n"
          "          and a run over a dirty tree would report on code that is not what you will ship.\n")
    print(dirty)
    sys.exit(2)

# ── PARALLEL. A serial run is ~4 minutes per dozen mutants: each one recompiles and runs the whole
# suite, and the suite is the slow part. Every mutant works in its OWN copy of src/test/config
# (node_modules symlinked), so nothing shares a working tree and the real src/ is never touched —
# which also removes the hazard that made the first version of this file destroy uncommitted work.
import shutil, concurrent.futures, multiprocessing, re
PARALLEL = max(1, int(os.environ.get("MUTATION_JOBS", "0")) or min(multiprocessing.cpu_count(), len(MUTATIONS)))
TSC_REL = "node_modules/typescript/bin/tsc"

# Each mutant copy runs the suite with LOOM_TEST_JOBS=1 (no fork bomb: 46 mutants x 36 files).
MUT_ENV = dict(os.environ, ELECTRON_RUN_AS_NODE="1", LOOM_TEST_JOBS="1")

# ── THE BASELINE GATE ────────────────────────────────────────────────────────────────────────────
# WHY THIS EXISTS, measured 2026-09-13. `run_one()` graded a mutant purely on `./test.sh`'s EXIT
# CODE. But the suite that each mutant runs is the LOOM_TEST_JOBS=1 one, and in that mode the suite
# was already RED at HEAD c0804c8 (448/449 — `naming: coordinator refuses to spawn/retire/delete
# 'po'`, an order-dependent failure that only appears when all 36 files share one sandbox HOME).
# A red baseline makes the exit code a constant: EVERY mutant "failed the suite", so every mutant was
# reported caught — a no-op mutant would have been too. Every mutation score this project reported
# that day was meaningless, including "46/46 caught".
#
# So: a mutant is caught only if a test that PASSES on the unmutated baseline FAILS on the mutant,
# and the run names those tests. Exit codes are no longer evidence of anything on their own.
ANSI_RE = re.compile(r"\x1b\[[0-9;]*m")
PASS_RE = re.compile(r"^\s*✓\s+(\S.*?)\s*$")
FAIL_RE = re.compile(r"^\s*✗\s+(\S.*?)\s*$")


def parse_results(out):
    """-> (set of test names that PASSED, set that FAILED), from run-tests.js's per-test lines."""
    passed, failed = set(), set()
    for line in ANSI_RE.sub("", out).splitlines():
        m = FAIL_RE.match(line)
        if m:
            failed.add(m.group(1))
            continue
        m = PASS_RE.match(line)
        if m:
            passed.add(m.group(1))
    return passed, failed


def make_tree(idx):
    """A throwaway copy of the project; node_modules is symlinked, never copied."""
    work = pathlib.Path(tempfile.mkdtemp(prefix=f"mut{idx}-"))
    for item in ("src", "test", "package.json", "tsconfig.json", "test.sh"):
        srcp = ROOT / item
        if srcp.is_dir():
            shutil.copytree(srcp, work / item)
        else:
            shutil.copy2(srcp, work / item)
    (work / "node_modules").symlink_to(ROOT / "node_modules")
    return work


def build_and_run(work):
    """-> (returncode, passed, failed) or (None, reason, None) if the tree does not compile."""
    r = subprocess.run([CODIUM, TSC_REL, "-p", "./"], cwd=work, capture_output=True, text=True, env=MUT_ENV)
    if r.returncode != 0:
        return (None, "does not compile", None)
    r = subprocess.run(["./test.sh"], cwd=work, capture_output=True, text=True, env=MUT_ENV)
    passed, failed = parse_results(r.stdout + r.stderr)
    return (r.returncode, passed, failed)


print("measuring the baseline (unmutated, LOOM_TEST_JOBS=1) — nothing can be graded against a red suite...")
_base = make_tree("base")
try:
    base_rc, base_pass, base_fail = build_and_run(_base)
finally:
    shutil.rmtree(_base, ignore_errors=True)

if base_rc is None:
    print(f"\nREFUSING: the unmutated tree {base_pass}.")
    sys.exit(2)
if base_rc != 0 or base_fail:
    print(f"\nREFUSING: the BASELINE suite is red ({len(base_pass)} passed, {len(base_fail)} failed, "
          f"exit {base_rc}) — a red baseline cannot grade anything.\n"
          f"Every mutant would inherit these failures and be scored 'caught' on the exit code alone.\n"
          f"Fix these first, then re-run:\n")
    for n in sorted(base_fail):
        print(f"  - {n}")
    if not base_fail:
        print("  (non-zero exit with no named failure — the suite crashed; run ./test.sh to see it)")
    sys.exit(2)
print(f"baseline is green: {len(base_pass)} tests pass, and a mutant is 'caught' only by breaking one of them.\n")

# A deliberate NO-OP mutant (find and replace are semantically identical). It MUST be reported
# SURVIVED: if the harness calls it caught, the harness is broken and no score below is worth
# reading — which is exactly the failure this whole baseline rewrite exists to make impossible.
#
# It inserts a free-standing `void Boolean(1);` STATEMENT rather than wrapping a condition. The first
# attempt did the latter — `if (!role)` -> `if (Boolean(1) && !role)` in inVocabulary() — and it does
# not compile under `strict`: that `if` is a narrowing guard, so burying it in a `&&` costs TypeScript
# the control-flow narrowing and the `role.trim()` below it becomes TS18049 'role' is possibly 'null'.
# A "no-op" that changes what the type-checker knows is not a no-op. Keep this one a plain statement.
NOOP_SELFCHECK = ("SELF-CHECK: a no-op mutant must SURVIVE",
                  "src/naming.ts",
                  "  if (!r || ROLE_VOCABULARY.includes(r)) return r;",
                  "  void Boolean(1);\n  if (!r || ROLE_VOCABULARY.includes(r)) return r;")

survived, stale, ungraded = [], [], []
print(f"reintroducing {len(MUTATIONS)} defects that were live on 2026-09-09:\n")


def run_one(idx, name, rel, find, repl):
    work = make_tree(idx)
    try:
        p = work / rel
        src = p.read_text()
        n = src.count(find)
        if n != 1:
            return ("STALE", name, f"({rel}: pattern occurs {n} times, expected 1)")
        p.write_text(src.replace(find, repl))
        rc, passed, failed = build_and_run(work)
        if rc is None:
            return ("STALE", name, "(mutant does not compile)")
        # THE GRADE: only a test that passed on the baseline and fails here counts.
        broke = sorted(failed & base_pass)
        if broke:
            shown = "; ".join(broke[:3]) + (f"; +{len(broke) - 3} more" if len(broke) > 3 else "")
            return ("caught", name, f"({len(broke)} baseline-passing test(s) now fail: {shown})")
        if rc != 0:
            # Non-zero exit, but no test that was green on the baseline went red — so the exit code
            # is telling us something other than "the suite noticed this defect". Not a catch.
            return ("UNGRADED", name,
                    f"(exit {rc} but no baseline-passing test failed; {len(failed)} failure(s) reported)")
        return ("SURVIVED", name, "")
    finally:
        shutil.rmtree(work, ignore_errors=True)


def report(status, name, detail):
    if status == "caught":
        print(f"  caught    {name}\n            {detail}")
    elif status == "SURVIVED":
        print(f"  SURVIVED  {name}")
        survived.append(name)
    elif status == "UNGRADED":
        print(f"  UNGRADED  {name}\n            {detail}")
        ungraded.append(f"{name} {detail}")
    else:
        print(f"  STALE     {name}\n            {detail}")
        stale.append(name)


with concurrent.futures.ThreadPoolExecutor(max_workers=PARALLEL) as pool:
    futures = [pool.submit(run_one, i, *m) for i, m in enumerate(MUTATIONS)]
    selfcheck = pool.submit(run_one, "noop", *NOOP_SELFCHECK)
    for fut in concurrent.futures.as_completed(futures):
        report(*fut.result())
    sc_status, sc_name, sc_detail = selfcheck.result()

print()
sc_ok = sc_status == "SURVIVED"
if sc_ok:
    print("self-check: the no-op mutant SURVIVED — the harness can tell a real defect from a no-op.")
else:
    print(f"SELF-CHECK FAILED: the no-op mutant was reported {sc_status} {sc_detail}\n"
          f"  A mutation that changes NOTHING must survive. Until that holds, every score above is\n"
          f"  unreadable — this is the 2026-09-13 defect (a red baseline made every mutant 'caught').")

if survived or stale or ungraded or not sc_ok:
    print()
    for s in survived:
        print(f"SURVIVED: {s}")
    for s in stale:
        print(f"STALE:    {s}")
    for s in ungraded:
        print(f"UNGRADED: {s}")
    parts = [f"{len(survived)} survived", f"{len(stale)} stale", f"{len(ungraded)} ungraded"]
    line = (f"\n{len(MUTATIONS) - len(survived) - len(stale) - len(ungraded)}/{len(MUTATIONS)} caught, "
            + ", ".join(parts))
    # Only claim a defect could return when one actually can. A failing SELF-CHECK with a clean
    # scoreboard means the opposite: the scoreboard cannot be trusted to tell us either way.
    if survived or stale or ungraded:
        line += " — those defects could return unnoticed"
    else:
        line += " — but the SELF-CHECK above failed, so this scoreboard is not evidence of anything"
    print(line)
    sys.exit(1)
print(f"all {len(MUTATIONS)} mutations caught — every defect of that night now breaks the suite")
