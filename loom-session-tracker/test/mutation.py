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

 # ── RB-001: the session id is the ADDRESS, the webviewId is a cache ───────────────────────────
 # Every one of these restores the state the bus was actually in after the 2026-09-13 restart:
 # records pointing at dead frames, or — worse — at confidently wrong ones.

 ("the session id is read with a loose pattern, so the webviewId is mistaken for it",
  "src/cdp.ts",
  '  const m = SESSION_RE.exec(String(url || ""));',
  '  const m = /[?&]id=([0-9a-f-]{8,})/i.exec(String(url || ""));'),

 ("a malformed session id from the page is trusted verbatim instead of being refused",
  "src/cdp.ts",
  'sessionId: typeof o.s === "string" ? sessionIdFromUrl("?session=" + o.s) : null };',
  'sessionId: typeof o.s === "string" ? o.s : null };'),

 ("a session id seen on only ONE of the two passes is thrown away",
  "src/cdp.ts",
  "        if (cur.sessionId === null && read.sessionId !== null) text.set(sid, { ...cur, sessionId: read.sessionId });",
  "        void cur;"),

 ("the tracker ignores session ids entirely — back to hand-rebinding after every restart",
  "src/tracker.ts",
  "      const sessOwner = f.claudeSessionId ? bySession.get(f.claudeSessionId) : undefined;",
  '      const sessOwner = f.claudeSessionId ? bySession.get("no-such-session") : undefined;'),

 ("a session id claimed by TWO roles is resolved by luck instead of refused",
  "src/rebind.ts",
  "    out.delete(id); dropped.add(id);",
  "    void dropped;"),

 ("a directory listing outranks the board's own statement about a session id",
  "src/rebind.ts",
  "    if (prev.source === \"board\" && source === \"transcript\") return;   // a statement beats a listing",
  "    if (prev.source === \"board\" && source === \"transcript\") { out.set(id, { role, source }); return; }"),

 ("a stale bus declaration outranks the live session id it contradicts",
  "src/tracker.ts",
  "const P_SESSION = 2.5;",
  "const P_SESSION = 1;"),

 ("an id file's guard is dropped by a path that never read the frame",
  "src/rebind.ts",
  "    if (guard && frameText !== null && !frameText.includes(guard) && !busy) {",
  '    if (guard && !(frameText || "").includes(guard) && !busy) {'),

 ("an id file's guard is dropped off a BUSY frame, whose scrollback is virtualized",
  "src/rebind.ts",
  "    if (guard && frameText !== null && !frameText.includes(guard) && !busy) {",
  "    if (guard && frameText !== null && !frameText.includes(guard)) {"),

 ("the DEAD binding is left in place beside the new one, so the role answers twice",
  "src/rebind.ts",
  "    for (const k of Object.keys(map)) if (k !== webviewId && map[k] === role) { delete map[k]; changed = true; }",
  "    /* the stale entry is left behind */"),

 ("the rebind writer is not change-only, so every 15-second tick rewrites the bus",
  "src/rebind.ts",
  '  try { if (fs.readFileSync(file, "utf8") === next) return false; } catch { /* missing -> write */ }',
  '  try { fs.readFileSync(file, "utf8"); } catch { /* missing -> write */ }'),

 ("a roster row is INVENTED for a role the board never listed",
  "src/rebind.ts",
  "    } else if (b) { notes.push(`board.json has no ${role} entry — left alone`); }",
  "    } else if (b) { b.roles[role] = { webviewId }; writeAtomic(f, JSON.stringify(b.data, null, 2)); }"),

 ("an ambiguous open claims the first new frame it sees",
  "src/newframe.ts",
  "        return now.length === 1 ? now[0] : null;",
  "        return now[0] || null;"),

 ("frames from an ambiguous open are not absorbed, so the NEXT open is unreadable too",
  "src/newframe.ts",
  "        for (const w of now) seen.add(w);",
  "        if (now.length === 1) seen.add(now[0]);"),

 ("the restart path attributes a tab it could not tell apart",
  "src/newframe.ts",
  "    if (wid) sink.identified(m.role, wid); else sink.ambiguous(m.role);",
  '    sink.identified(m.role, wid || "unknown");'),

 ("only the camel spelling is healed, leaving the board's own stale `webview_id` beside it",
  "src/rebind.ts",
  "      const hasSnake = typeof cur.webview_id === \"string\";",
  "      const hasSnake = false;"),

 ("a worktree WINDOW looks for worktrees inside itself, so a role's transcripts are never found",
  "src/rebind.ts",
  '  return path.join(root, ".claude", "worktrees", role);',
  '  return path.join(windowCwd, ".claude", "worktrees", role);'),
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
  "            const pm = await premodel(role, wid);\n            noteModel(\"spawn\", pm); debugLog({ spawnModel: pm }); recordSpawnModel(pm);",
  "            const pm: PreModel = { role, webviewId: wid, want: null, typed: 0, acknowledged: null,\n                                   chip: null, onPremium: false, ok: true, note: \"deferred\" };\n            setTimeout(() => premodel(role, wid), 0);"),

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
  "      if (same(cur.pending, st.pending) && same(cur.escalations, st.escalations) && same(cur.ledger, st.ledger)\n          && same(cur.defaulted, st.defaulted) && same(cur.orchRefused, st.orchRefused)\n          && String(cur.selfShiftLogged || \"\") === String(st.selfShiftLogged || \"\")) return;",
  "      if (same(cur.pending, st.pending)) return;"),

 # ── CH-001, 2026-09-13: §19's chunking rules — the tracker ENFORCES disjointness and MEASURES size ─
 # Each of R1-R4 gets one, plus one per new ledger field, and each names the test that must die with it.

 # R1 — killed by "CH-001 R1: `files:` is read comma- OR space-separated, and normalised". §19's own
 # example writes commas; every handoff a human types writes spaces. Splitting on commas alone turns
 # `files: src/a.ts src/b.ts` into ONE declared path called "src/a.ts src/b.ts", which collides with
 # nothing that exists — so the guard silently has no opinion on exactly the briefs it should refuse.
 ("`files:` is comma-separated only — a space-separated line declares one impossible path",
  "src/models.ts",
  "  for (const piece of raw.split(/[,\\s]+/)) {",
  "  for (const piece of raw.split(/,/)) {"),

 # R2 — killed by "CH-001 R2: the suffix match is anchored on a path SEGMENT, not on characters".
 # Dropping the anchor makes the comparison a plain substring test, so `src/models.ts` collides with
 # `xsrc/models.ts` and `other/src/mymodels.ts`. A guard that refuses a disjoint package is worse than
 # none: the orchestrator is told its own plan is illegal and the lane sits empty.
 ("the path comparison is an unanchored substring — disjoint files read as the same file",
  "src/overlap.ts",
  "  return new RegExp(`(?:^|/)${body}$`);",
  "  return new RegExp(body);"),

 # R2 — killed by "CH-001 R2: a handoff that collides with a WORKING role's is refused, naming both"
 # (its final assertion). Without the self-deletion every working role with a `files:` line overlaps
 # ITSELF, so the moment a role starts work the tracker refuses to ever reopen it.
 ("a role is compared against itself — every working role blocks its own tab",
  "src/overlap.ts",
  "  others.delete(role);                               // a role never overlaps itself",
  "  void role;"),

 # R2 — killed by "CH-001 R2: ONE request naming two colliding briefs opens the first and refuses the
 # second". The bus-status half only sees roles that are ALREADY working, and a role being spawned in
 # this same breath is not working yet: one open-requests.json naming two colliding briefs would spawn
 # both and the disjointness rule would never be consulted at all — the exact case §19 is most about.
 ("roles opened in the same request are not counted as live — two colliding briefs spawn together",
  "src/requests.ts",
  "    const ov = overlapFor(repo, role, [...open.map((c) => c.role), ...spawn]);",
  "    const ov = overlapFor(repo, role, []);"),

 # R3 contextPctAtFinish — killed by "CH-001 R3: every new field is NULL rather than guessed when it
 # cannot be read". `Number(null)` is 0, so without the absence guard a role below ~50 % context —
 # where the panel renders no percentage at all — lands in the ledger as "finished at 0 % context".
 # §19 reads under-30 % as "that handoff was too small", so every unreadable block would be scored as
 # the smallest possible one. The same hole was open under `testsBefore`.
 ("an unreadable number is 0 rather than null — a role below 50% context is logged as 0%",
  "src/models.ts",
  '  if (v === null || v === undefined || v === "") return null;',
  "  void 0;"),

 # R3 wallMinutes — killed by "CH-001 R3: filesDeclared, statusUpdates, wallMinutes and
 # contextPctAtFinish are recorded" (its 72-minute assertion). A units slip is invisible in every
 # null-case test and in the shape test, and §19's calibration is stated in MINUTES ("about an hour
 # on Opus"): sixty times too large reads as every handoff being wildly oversized.
 ("wallMinutes is computed in seconds — every handoff reads 60x too long",
  "src/models.ts",
  "  return Math.round(((b - a) / 60_000) * 10) / 10;",
  "  return Math.round(((b - a) / 1_000) * 10) / 10;"),

 # R3 filesDeclared — killed by "CH-001 R3: filesDeclared, statusUpdates, wallMinutes and
 # contextPctAtFinish are recorded". A constant 0 is indistinguishable from the honest "declared
 # nothing", so the one field that could tell whether §19's split-at-file-boundaries rule is being
 # followed would read as "nobody has ever declared a file" for ever.
 ("filesDeclared is always zero — the size rule can never be scored",
  "src/models.ts",
  "                    filesDeclared: handoffFiles(this.repo, role).length,",
  "                    filesDeclared: 0,"),

 # R3 statusUpdates — killed by "CH-001 R3: statusUpdates counts REPORTS, not the ticks that re-read
 # them". status.json is re-read every 15 seconds, so counting reads makes this a measure of how long
 # the WINDOW was open rather than how many turns the block took — principle 19's "count reports, not
 # reads", which is the same defect R4's escalation counting had.
 ("statusUpdates counts every tick's re-read — it measures uptime, not turns",
  "src/models.ts",
  "      if (seen && seen !== cur.seenUpdatedAt) {",
  "      if (seen) {"),

 # R4 — killed by "CH-001 R4: a record whose ledger line could NOT be written SURVIVES". The prune is
 # safe ONLY because it is gated on the append having landed; the append is deliberately swallowed so
 # a full disk cannot break a tick. Swallowing it and pruning anyway destroys BOTH copies of "this
 # block was escalated after two loop-backs" — the durable record and the working one.
 ("the escalation record is pruned even when the ledger write FAILED — both copies are lost",
  "src/models.ts",
  "    } catch { return false; }                               // a ledger write must never break a tick",
  "    } catch { /* a ledger write must never break a tick */ }"),

 # FX-001 R1 — killed by "R1: an ack (`id: X-ack`) opens nothing". Acks are the orchestrator's own
 # replies written into the SAME inbox.md as the handoff; without the suffix check `handoffId()`
 # hands the ack's id to every caller as if it were a real block, and a ledger line + an escalation
 # record open for work nobody will ever do.
 ("the -ack suffix check is removed — an orchestrator's ack opens a ledger line and an escalation record",
  "src/models.ts",
  "function isAckId(id: string | null | undefined): boolean {\n  return /-ack\\s*$/i.test(String(id ?? \"\"));\n}",
  "function isAckId(id: string | null | undefined): boolean {\n  return false;\n}"),

 # FX-001 R1 — killed by "R1: a state file carrying -ack records loses them on save". Purging on
 # LOAD alone is not enough: `pending()` and other read-only callers never call `saveState`, so a
 # purge that only ran there would never reach disk. Pinning it at the save site is what makes "on
 # the next save" true regardless of which caller triggers it.
 ("the -ack purge is removed from saveState — a durable model-policy.json keeps growing ack entries",
  "src/models.ts",
  "    purgeAcks(st);\n    const f = stateFile(repo);",
  "    const f = stateFile(repo);"),

 # ── MS-001, 2026-09-14: absent tiers are loud, a refused switch is not "switched", the orchestrator shifts itself ─

 # R1 — killed by "MS-001 R1: a handoff with no `model:` line is noted ONCE per (role, id)". Without
 # the "already noted" check the note fires on every 15-second tick for as long as the handoff sits
 # in the inbox — a status bar that never stops is one nobody reads, and the SILENT default that
 # went unnoticed for a day is replaced by a loud one that gets switched off.
 ("the once-per-handoff guard is removed — the 'no model: line' note fires on every tick",
  "src/models.ts",
  "    if (seen.includes(key)) return null;\n    seen.push(key);",
  "    seen.push(key);"),

 # R2 — killed by "MS-001 R2: exit 0 with a printed 'ok': False is NOT a switch". loom_cdp.py exits
 # 0 and prints ok=False when it could not confirm the typed text; trusting the exit code recorded
 # that refusal as "switched" against the orchestrator's own frame on 2026-09-14.
 ("enforce() trusts the injector's exit code again — a printed 'ok': False is recorded as switched",
  "src/models.ts",
  "        const verdict = injectVerdict(err, stdout, stderr);\n        const ok = verdict.ok;",
  "        const verdict = injectVerdict(err, stdout, stderr);\n        const ok = !err;"),

 # R3 — killed by "MS-001 R3: orchestrator-model.json is honoured when it names an allowed id".
 # Ignoring the file returns the configured target for every request, so an orchestrator that asks
 # for Sonnet to bank a memory doc keeps paying the top tier — the exact spend the owner's directive
 # ("orchestrators self-shift up or down") exists to stop, and the tracker would say nothing.
 ("orchestrator-model.json is read but never honoured — the orchestrator can never shift itself",
  "src/models.ts",
  "    if (hit) return { target: hit, self: true, reason: req.reason, requestedAt: req.at, note: null };",
  "    if (hit) return def;"),

 # R4 — killed by "MS-001 R4: the fresh-context header tells every orchestrator both model rules".
 # The header is the one text every orchestrator on every project reads after a clear; drop the
 # rules from it and the `model:` line goes unwritten on every bus but this one, as measured.
 ("the restore header no longer tells the orchestrator the two model rules",
  "src/memory.ts",
  "    `MODELS: every handoff you write carries a model: line (§18: claude-opus-5 or claude-sonnet-5) — ` +",
  "    `MODELS: see the playbook. ` +"),
 # R2b — killed by "MS-001 R2b: a refused /model is RETRIED, and a tab still on premium is NOT
 # bound". Measured on pleodo 2026-09-14: three tabs were spawned onto Fable 5.1 and bound anyway,
 # and `/loom` makes the composer busy from that moment — so the idle tick, which refuses to type
 # into a busy composer, could never correct them. 71/55/70 premium turns before anyone noticed.
 ("the spawn binds a tab whose /model was refused — a handoff begins on the premium tier",
  "src/extension.ts",
  "            if (!pm.ok) {",
  "            if (Boolean(0)) {"),

 # R2b — killed by "MS-001 R2b: a fresh tab that comes up PREMIUM is typed into even though its
 # handoff wants the default tier". This is the ROOT CAUSE of that night: the handoffs all said
 # `model: claude-opus-5`, which IS the configured default, so the spawn assumed the fresh tab was
 # already on it and typed nothing at all. A tab's tier is what its FRAME says, never what the
 # setting says it ought to be.
 ("the spawn assumes a fresh tab starts on the pinned default — a premium tab is never typed into",
  "src/extension.ts",
  '      if (want.model === dflt && !premiumNow()) return { ...base, want: want.model, chip, note: "default tier — nothing to type" };',
  '      if (want.model === dflt) return { ...base, want: want.model, chip, note: "default tier — nothing to type" };'),

 # ── WL-001, 2026-09-15: what the agents PRODUCE, measured from git and the transcripts ─────────
 # The audit that caused this: 10.7 % of ReciEats' changed lines reached a user's screen over seven
 # days, 171 of 614 commits only updated the guide, 0 releases were ever cut — and every figure the
 # panel showed came from the agents' own account of themselves, by which the week was excellent.

 # R6 — THE ONE THE HANDOFF NAMED. Killed by "WL-001 R6: CACHE READS ARE COUNTED — omitting them
 # understates a week by ~100x". Cache reads run ~100x the other classes; dropping them turns a
 # 15-billion-token week into a 100-million-token one, and the cost-per-line figure with it.
 ("tokensSpent ignores cache reads — a 15-billion-token week reads as 100 million",
  "src/workledger.ts",
  "        t.cacheRead += n(u.cache_read_input_tokens);",
  "        t.cacheRead += 0;"),

 # R6 — killed by "WL-001 R6: netProductLines is a TWO-POINT DIFF — churn is not production".
 # Basing the denominator on the first commit in the window instead of the last one BEFORE it
 # silently drops that commit's work from "what exists now that did not exist then".
 ("the net-lines base is inside the window — the denominator counts churn as production",
  "src/workledger.ts",
  '  const before = (git(repoPath, ["rev-list", "-1", `--before=${since}`, "HEAD"]) || "").trim();',
  '  const before = (git(repoPath, ["rev-list", "-1", "HEAD"]) || "").trim();'),

 # R6 — killed by "WL-001 R6: an UNPRICED model contributes tokens but NOT dollars, and is named".
 # Silently folding an unknown id into the cheapest row is a cost figure nobody can audit.
 ("an unpriced model is silently priced as Haiku — the dollar figure stops being checkable",
  "src/workledger.ts",
  "    const p = priceFor(id, prices);\n    if (!p) {",
  "    const p = priceFor(id, prices) || [1, 5, 0.1, 2];\n    if (!p) {"),

 # R1 — killed by "WL-001 R1: a test file counted as PRODUCT is the defect this whole panel exists
 # to prevent". THE defect being prevented: with the rig counted as product, the audited week reads
 # GREEN and the panel goes back to saying everything is fine.
 ("the heuristic counts tests and tooling as PRODUCT — the audited week would read green",
  "src/workledger.ts",
  "  if (isDoc(file) || isRig(file) || LOCK_RE.test(file)) return false;",
  "  if (isDoc(file) || LOCK_RE.test(file)) return false;"),

 # R1 — killed by "WL-001 R1: a NEGATIVE or zero wall time is DROPPED, never shown as 0".
 # A 0 in this column is not a missing value but a measured one: "that handoff took no time".
 ("a non-positive wall time is averaged in as 0 — an unreadable value scored as a measurement",
  "src/workledger.ts",
  '  const v = values.filter((x): x is number => typeof x === "number" && Number.isFinite(x) && x > 0)',
  '  const v = values.filter((x): x is number => typeof x === "number" && Number.isFinite(x))'),

 # R1 — killed by "WL-001 R1: a repo with NO TAG reports never-released — a warning, not a blank".
 # ReciEats' real answer is 0 tags in 221 blocks; rendering it as an ordinary row is how it stayed
 # invisible for a week.
 ("never-released renders as an ordinary row, not a warning",
  "src/workledger.ts",
  '      band: w.tag === null ? "bad" : "unknown",',
  '      band: "unknown",'),

 # R2 — killed by "WL-001 R2: band boundaries are inclusive on the good side, both directions".
 ("the good-side boundary is exclusive — 40% shipping reads amber",
  "src/workledger.ts",
  '  if (highIsGood) return value >= good ? "good" : value < bad ? "bad" : "warn";',
  '  if (highIsGood) return value > good ? "good" : value < bad ? "bad" : "warn";'),

 # R2 — killed by "WL-001 R2: expanding lists each figure, and a RED row states its number".
 # A bare warning icon tells a reader something is wrong without telling them how wrong, which is
 # exactly the thing this panel replaces.
 ("a red row shows an icon but not the number",
  "src/statusView.ts",
  "      it.description = f.value;",
  '      it.description = "";'),

 # R4 — killed by "WL-001 R2: a HEURISTIC ledger says so on the row and in the tooltip" and by
 # "WL-001 R2: a HEURISTIC figure says so, everywhere it is shown". An unconfigured guess presented
 # as a measurement is the same lie in a new place.
 ("a guessed product path is reported as a configured measurement",
  "src/workledger.ts",
  "  return { isProduct: (f) => !isExcluded(f) && heuristicIsProduct(f), isExcluded, heuristic: true };",
  "  return { isProduct: (f) => !isExcluded(f) && heuristicIsProduct(f), isExcluded, heuristic: false };"),

 # R5 — killed by "WL-001 R5: a RED project's orchestrator is told ONCE, on an IDLE composer".
 # Every 15 s instead of once a day is how a true finding becomes noise nobody reads.
 ("the ledger nudge repeats every tick instead of once per project per day",
  "src/workledger.ts",
  "  if (notifiedOn === today) return null;",
  "  if (notifiedOn === today && Boolean(0)) return null;"),

 # R5 — killed by "WL-001 R5: a BUSY orchestrator composer is never typed into, and the day is not
 # spent". A line typed over a running turn queues as an ordinary message (dispatch.ts) — the same
 # discipline /model is held to.
 ("the ledger nudge is typed into a BUSY composer",
  "src/extension.ts",
  "      if (!frame || frame.busy) return;                    // not now; the day is still unspoken for",
  "      if (!frame) return;"),


 # R7a — killed by "WL-001 R7a: a test file under a product glob is NOT product — the defect this
 # panel exists to refute" and by the partition test. MEASURED: without the exclusions, 39,150 of
 # ReciEats' 63,225 "product" lines over the audited week were test files under src/, and the
 # shipping share read 56.8 % instead of 25.1 %. src/app/page.test.tsx alone was +10,782.
 ("a test file under a product glob counts as PRODUCT — the ledger reports the number it refutes",
  "src/workledger.ts",
  "    return { isProduct: (f) => !isExcluded(f) && matchesAny(f, globs), isExcluded, heuristic: false };",
  "    return { isProduct: (f) => matchesAny(f, globs), isExcluded, heuristic: false };"),

 # R7c — killed by "WL-001 R7c: product and rig PARTITION the week's lines — they must not overlap".
 ("what is subtracted from product falls out of rig too — the ratio understates by construction",
  "src/workledger.ts",
  "      if (isRig(l.file) || cls.isExcluded(l.file)) rigLines += n;",
  "      if (isRig(l.file)) rigLines += n;"),

 # ── WL-002 · the repo the panel could not see ───────────────────────────────────────
 # Nothing in the 149 mutants before these covered a repo name that was not already hyphen-clean,
 # which is why this shipped: ReciEats and pleodo are both hyphen-clean, and the ONE bus with an
 # underscore in its name was the one measuring itself.

 # R1 — killed by "WL-002 R1: an UNDERSCORE repo finds the hyphen-encoded directory the encoder
 # actually wrote" and by the dot test. MEASURED: /home/aneesh/vs_code_extensions is written
 # -home-aneesh-vs-code-extensions, so the raw name matched NOTHING and read as zero tokens.
 ("the repo name is matched RAW against an encoded directory — every underscore repo reads 0 tokens",
  "src/workledger.ts",
  "  const needle = canonProject(repo);",
  "  const needle = repo.toLowerCase();"),

 # R1 — killed by "WL-002 R1: canonicalizing does NOT relax the anchor — a sibling repo is still
 # not swallowed". `-pleodo-archive` contains `-pleodo-`; only the `--` (an encoded `/.`) separates
 # a worktree OF this repo from a DIFFERENT repo that merely starts with its name.
 ("the anchor is relaxed to a single hyphen to buy the match — a SIBLING repo's spend is billed here",
  "src/workledger.ts",
  '                     return l.endsWith("-" + needle) || l.includes("-" + needle + "--"); })',
  '                     return l.endsWith("-" + needle) || l.includes("-" + needle + "-"); })'),

 # R2 — killed by "WL-002 R2: no directory matched is UNMEASURED (null), not zero tokens at
 # $0.00/line". THE MORE IMPORTANT HALF: a repo with no matched directory reported the cheapest
 # possible week, and no threshold can ever catch it, because zero is under all of them.
 ("a repo whose transcripts were never found reports ZERO tokens instead of unmeasured",
  "src/workledger.ts",
  "    tokensSpent: unmeasured ? null : scan.total, tokensByModel: scan.byModel,",
  "    tokensSpent: scan.total, tokensByModel: scan.byModel,"),

 # R2 — killed by the same test and by "the unmeasured $/line cell is NOT GREEN". This is the
 # $0.00/line the owner was shown: a real denominator from git over a cost that does not exist.
 ("an unmeasured cost is divided by a real line count and printed as $0.00/line, GREEN",
  "src/workledger.ts",
  "    costPerProductLine: denom && !unmeasured ? Math.round((cost.dollars / denom) * 100) / 100 : null,",
  "    costPerProductLine: denom ? Math.round((cost.dollars / denom) * 100) / 100 : null,"),

 # ── WL-003 · the audit delivered to the orchestrator ────────────────────────────────
 # The add-on exists to make the ORCHESTRATOR see it is spending its blocks on bus mechanics rather
 # than on product. Every mutant here either hides that fact from it or turns it into a score.

 # R1 — killed by "WL-003 R1: a tool call is bucketed, and BUS WINS however it is spelled".
 # MEASURED on this bus 2026-09-15: the orchestrator's own session made 38 bus calls of 89. Calls
 # routinely name a product path AND a bus path in one command; whichever is tested first decides
 # the number, and testing product first is how bus work disappears into the product bucket.
 ("a call that touches BOTH the bus and a product path counts as PRODUCT — bus work vanishes",
  "src/workledger.ts",
  '  if (isBusMechanics(JSON.stringify(input ?? {}))) return "bus";',
  '  if (false && isBusMechanics(JSON.stringify(input ?? {}))) return "bus";'),

 # R1 — killed by "WL-003 R1: scoped to ONE session — a developer's calls are not the
 # orchestrator's time". Unscoped, this bus reports 2,129 calls instead of the orchestrator's 89,
 # and the developers' product work is credited to the orchestrator's allocation.
 ("the session filter is ignored — a developer's tool calls are reported as the orchestrator's own",
  "src/workledger.ts",
  "      if (only && !only.has(name.slice(0, -6).toLowerCase())) continue;",
  "      if (false) continue;"),

 # R1 — killed by "WL-003 R1: a session filter that matches NOTHING is unmeasured, not a perfect
 # week". WL-002's rule, in the new figure: an orchestrator whose transcript was not found must not
 # be told it made zero bus calls, which reads as the best possible week.
 ("an orchestrator whose transcript is missing is told it made ZERO bus calls",
  "src/workledger.ts",
  "  if (only && !a.sessions) return EMPTY_ALLOC(true);",
  "  if (false) return EMPTY_ALLOC(true);"),

 # R1 — killed by "WL-003 R1: the buckets are counted across a window and PARTITION the calls".
 # A tool_use block replayed on a USER line is not a turn the agent spent.
 ("tool calls replayed on user lines are counted as the agent's own turns",
  "src/workledger.ts",
  '        if (!o || o.type !== "assistant") continue;\n        const content = o.message && o.message.content;',
  '        if (!o) continue;\n        const content = o.message && o.message.content;'),

 # R3 — killed by "WL-003 R3: the briefing names what HAPPENED — never a score the orchestrator
 # could optimise". THE WL-001 FAILURE CLASS AIMED AT THE ONE READER WHO CAN ACT ON IT: a
 # percentage of its own conduct is a dial an agent can move without doing any of the work it
 # stands for. Counts of things that happened are not.
 ("the briefing hands the orchestrator a PERCENTAGE of its own conduct instead of a count",
  "src/workledger.ts",
  "    L.push(`${a.bus} of the last ${a.calls} tool call(s) ${scope} went to bus mechanics — tabs, ` +",
  "    L.push(`bus mechanics: ${Math.round((a.bus / a.calls) * 100)}% of tool call(s) — tabs, ` +"),

 # R2 — killed by "WL-003 R2: the briefing is APPENDED to the restore message". The delivery is the
 # whole handoff: a correct audit computed and then dropped is the panel behind the window again.
 ("the audit is computed and then dropped from the one message a fresh orchestrator reads",
  "src/memory.ts",
  "    briefing;",
  '    "";'),

 # ── WL-003-R5 · a release is what reached a user ────────────────────────────────────
 # MEASURED 2026-09-15: 42 deployed versions, 56 manifest bumps, 0 tags — and the panel said the
 # project had never cut a release. A line the reader can SEE is false costs the whole block its
 # credibility, including the one line that matters.

 # R5 source 1 — killed by "WL-003-R5: a DEPLOYED artifact is the release". Skipping the artifact
 # falls through to the manifest bump, which is a different and older answer.
 ("the deployed artifact is ignored — the release falls back to a manifest bump that shipped earlier",
  "src/workledger.ts",
  "  const deployed = deployedVersions(m, roots);",
  "  const deployed: string[] = [];"),

 # R5 source 2 — killed by "WL-003-R5: no artifact, but the manifest MOVED".
 ("a manifest that moved is not a release — a project with no deploy dir reads as unreleased",
  "src/workledger.ts",
  "  const bump = releaseCommit(repoPath, m.rel, null);",
  "  const bump = null as null | { sha: string; version: string };"),

 # R5 source 3 — killed by "WL-003-R5: no manifest and no deploy target is UNMEASURED". THE ONE THE
 # OWNER ASKED FOR BY NAME: an undetectable release reported as 0 blocks reads as "shipped just
 # now", which is the exact opposite of what is known, and is under every alarm.
 ("a release that cannot be detected reports 0 blocks — unseen is rendered as just-shipped",
  "src/workledger.ts",
  '  return { ...base, source: "unmeasured", releasedVersion: null, blocksSince: null };',
  '  return { ...base, source: "deployed", releasedVersion: base.version, blocksSince: 0 };'),

 # R5 — killed by "WL-003-R5: no manifest and no deploy target is UNMEASURED". The SAME defect on
 # the other unmeasured path, the one a missing manifest takes. The first version of the mutant above
 # aimed only at the untracked-manifest return, which NO test reached, and it SURVIVED: the gate
 # caught that the assertion and the code it named were not meeting.
 ("a project with no manifest at all reports 0 blocks instead of unmeasured",
  "src/workledger.ts",
  '  const none = (): ReleaseSignal => ({ source: "unmeasured", manifestPath: null, product: null,\n                                       version: null, releasedVersion: null, blocksSince: null,\n                                       lookedIn: roots });',
  '  const none = (): ReleaseSignal => ({ source: "unmeasured", manifestPath: null, product: null,\n                                       version: null, releasedVersion: null, blocksSince: 0,\n                                       lookedIn: roots });'),

 # R5 — killed by "WL-003-R5: a manifest that has never moved says so". The one case where 'no
 # release in N blocks' is honest must not be folded into unmeasured either.
 ("a manifest that has never changed version is reported as unmeasured rather than as unreleased",
  "src/workledger.ts",
  "             neverMoved: true };",
  "             neverMoved: false };"),

 # ── WL-005 · two numbers the bus stated without measuring ───────────────────────────
 # MEASURED 2026-09-15. `started` came from the worker's status.updated_at, which at the moment a
 # block opens still holds the stamp of the block BEFORE it: WL-001 read 2455 minutes against a
 # real ~90, ReciEats read -39.3, and not one record's start was its own. And live-check said
 # "deployed is 0.38.1" off the SOURCE manifest while the newest artifact on disk was 0.38.0 —
 # naming a build that existed nowhere and telling the reader to reload to reach it.

 ("the block's start is read back off the worker's status stamp — every duration spans the block before",
  "src/models.ts",
  '      const openedAt = now.toISOString();',
  '      const openedAt = String(status.updated_at || now.toISOString());'),

 ("the block's END is the worker's stamp again, so the two ends stop being one clock and can invert",
  "src/models.ts",
  '    const closedAt = now.toISOString();',
  '    const closedAt = String(status.updated_at || now.toISOString());'),

 ("a block whose start was never observed reports 0 minutes instead of unmeasured",
  "src/models.ts",
  '      wallMinutes: openedAt ? wallMinutes(openedAt, closedAt) : null,',
  '      wallMinutes: openedAt ? wallMinutes(openedAt, closedAt) : 0,'),

 ("an unmeasured duration is blanked as not-measured again, hiding a wrong value at render time",
  "src/workledger.ts",
  '               `${r.wallMinutes === null ? UNMEASURED : r.wallMinutes} | ` +',
  '               `${r.wallMinutes === null || r.wallMinutes <= 0 ? "—" : r.wallMinutes} | ` +'),

 ("live-check compares windows against the SOURCE manifest again — 'deployed' names a build nobody wrote",
  "live-check.js",
  '  const behind = fresh.filter(([, v]) => v.version !== deployed);',
  '  const behind = fresh.filter(([, v]) => v.version !== pkgV);'),

 ("no deployed artifact falls through to the manifest instead of saying unmeasured",
  "live-check.js",
  '  if (!deployed) {',
  '  if (false) {'),

 ("an undeployed build is reported as something to RELOAD rather than something to deploy",
  "live-check.js",
  '    ? `The source manifest is ${pkgV} but the newest deployed artifact is ${deployed} — that build is `',
  '    ? `` && `The source manifest is ${pkgV} but the newest deployed artifact is ${deployed} — that build is `'),

 ("version segments are compared as STRINGS — 0.38.9 reads as newer than 0.38.10",
  "live-check.js",
  '    if (typeof x === "number" && typeof y === "number") return x < y ? -1 : 1;',
  '    if (false) return x < y ? -1 : 1;'),

 # ── FX-002 · the suite must not leave its fixtures on the host ───────────────────────
 # MEASURED 2026-09-15: 892,449 directories in /tmp, 12,201,926 inodes, 97.6% of the filesystem,
 # 100% of the inode table with 74 GB of disk free. It killed a gate mid-run. A 168-mutant gate is
 # 168 suite runs, so this script was the amplifier, not the source.

 # Killed by "FX-002: a fixture directory is gone after the sweep" and the exhaustive-sweep test.
 ("the per-suite fixture sweep is removed — every suite leaves its fixtures on the host again",
  "test/run-tests.js",
  '    } finally {\n      // FX-002 · the owner. A suite that THREW still gives its fixture directories back; that is the\n      // whole reason this lives here rather than at the end of each suite body.\n      H.sweepFixtures();\n    }',
  '    }'),

 # Killed by "FX-002: a fixture whose test THREW is still swept". THE IMPORTANT ONE: the leak that
 # mattered was on the FAILING path, and a sweep that skips it looks correct on a green run.
 ("the sweep is skipped when the suite failed — the failing path leaks, which is the path that did",
  "test/run-tests.js",
  '      H.sweepFixtures();',
  '      if (!fail) H.sweepFixtures();'),

 # Killed by "a fixture with CONTENT is removed" and every count assertion.
 ("the registry registers directories but never deletes them",
  "test/harness.js",
  '    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort, never fatal */ }',
  '    void dir;'),

 # REMOVED: a mutant on test/mutation.py can never be caught, and this one SURVIVED for that
 # reason rather than because a test was missing. make_tree() copies test/ into the throwaway tree,
 # but the DRIVER that runs there is the original: the copy's mutation.py is never executed, and
 # nothing in the suite reads it (verified by grep). So mutating it changes a file no process opens.
 # A mutant that cannot fail is indistinguishable from a defect that is not covered, which makes the
 # whole score unauditable — the vacuous-baseline problem in a new place. The TMPDIR containment is
 # instead guarded by the run-time self-check below (see CONTAINMENT SELF-CHECK) and by the
 # run-tests.js sandbox mutant, which IS caught.

 # Killed by "FX-002: the temp root is redirectable" via LOOM_TEST_SANDBOX.
 ("the per-file sandbox stops redirecting TMPDIR — ./test.sh leaks for anyone who runs it",
  "test/run-tests.js",
  '  return { sandbox, env: { ...process.env, HOME: sandbox, LOOM_TEST_SANDBOX: sandbox,\n                           TMPDIR: tmp, ELECTRON_RUN_AS_NODE: "1" } };',
  '  return { sandbox, env: { ...process.env, HOME: sandbox, LOOM_TEST_SANDBOX: sandbox,\n                           ELECTRON_RUN_AS_NODE: "1" } };'),

 # ── WL-004 · the byte number the memory prompt must never name ──────────────────────
 # MEASURED 2026-09-15: 'Keep it under 12,000 bytes' made the orchestrator delete the section
 # recording the owner's stated product goal in order to fit, twice in one day. An imperative with
 # a measurable target, handed to an agent, about the one artifact that survives its own erasure.

 # R1 — killed by "WL-004 R3: no agent-facing memory prompt names a size, a cap, or the threshold".
 ("the byte cap is restored to the save prompt — an agent is told to hit a number again",
  "src/memory.ts",
  '    `Write it TIGHT — every line has to earn its place, because the whole file is re-read at the ` +',
  '    `Keep it under ${MAX_MEMORY_BYTES.toLocaleString()} bytes. Every line has to earn its place, because the whole file is re-read at the ` +'),

 # R2 — killed by the same assertion on the clear note. An oversized memory is worth OBSERVING;
 # 'trim it' is an order to cut content to reach a number, which is the defect, not the report.
 ("the clear note goes back to ordering a trim against a named cap",
  "src/memory.ts",
  '                 ? ` — large; every fresh context re-reads it in full` : ""}) — clearing`,',
  '                 ? ` — over the ${MAX_MEMORY_BYTES.toLocaleString()}-byte cap; every fresh context pays for it, trim it` : ""}) — clearing`,'),

 # R1/R4 — killed by "WL-004 R1: the save prompt asks for CONCISION" and the R4 split test. The
 # number is not the only way to order the trade: 'cut the least important section until it fits'
 # is the same instruction without a digit in it, and it must not pass either.
 ("the prompt orders sections cut until it fits — the same trade, spelled without a number",
  "src/memory.ts",
  '    `each cycle. If you find yourself about to delete something durable to make the working memory ` +',
  '    `each cycle. If it will not fit, cut the least important section until it does. ` +'),

 # R5 — killed by "WL-003-R5: a repo holding SEVERAL products answers for the ACTIVE one". Taking
 # the first manifest by name reported "111 blocks since 1.0.0" for a repo whose active product had
 # shipped that morning: the same confidently-wrong line, one layer down.
 ("a multi-product repo answers for the FIRST manifest by name, not the one being worked on",
  "src/workledger.ts",
  "    if (Number.isFinite(t) && t > bestAt) { bestAt = t; best = m; }",
  "    if (Number.isFinite(t) && t < bestAt) { bestAt = t; best = m; }"),

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
#
# FX-002 · TMPDIR IS SET PER MUTANT, in run_one(), to a directory INSIDE the throwaway tree, so the
# suite's own fixtures land somewhere the rmtree at the end of run_one() already takes. This script
# always deleted its copy of the project faithfully — which is exactly why the leak was invisible:
# the suite running INSIDE that copy wrote its fixtures to os.tmpdir(), i.e. the HOST's /tmp, outside
# the tree being reaped. A 168-mutant gate is 168 suite runs, so this script was the amplifier that
# turned a slow leak into 12.2 million inodes and a dead host.
#
# Belt and braces with the harness-level sweep on purpose: the sweep fixes ./test.sh for everyone,
# and this makes any fixture site added later unable to escape the gate even if it registers nothing.
MUT_ENV = dict(os.environ, ELECTRON_RUN_AS_NODE="1", LOOM_TEST_JOBS="1")


def _host_fixture_count():
    """`loom-*` entries in the HOST's temp root — the thing that overflowed."""
    try:
        return sum(1 for n in os.listdir(tempfile.gettempdir()) if n.startswith("loom-"))
    except OSError:
        return 0


HOST_FIXTURES_AT_START = _host_fixture_count()


def mut_env_for(work):
    """MUT_ENV with TMPDIR pointed inside `work`. Verified on this box that both node and
    codium (ELECTRON_RUN_AS_NODE) honour TMPDIR via os.tmpdir(); it was not assumed."""
    tmp = pathlib.Path(work) / "tmp"
    tmp.mkdir(parents=True, exist_ok=True)
    return dict(MUT_ENV, TMPDIR=str(tmp))

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
    # live-check.js: FX-001's live-check.test.js requires it by relative path (`../live-check.js`)
    # to reach `judgeRunningVersions` — omitting it here is not "one file missing", it is the whole
    # baseline crashing (MODULE_NOT_FOUND), which used to read as a suite-wide false red before this.
    for item in ("src", "test", "package.json", "tsconfig.json", "test.sh", "live-check.js"):
        srcp = ROOT / item
        if srcp.is_dir():
            shutil.copytree(srcp, work / item)
        else:
            shutil.copy2(srcp, work / item)
    (work / "node_modules").symlink_to(ROOT / "node_modules")
    return work


def build_and_run(work):
    """-> (returncode, passed, failed) or (None, reason, None) if the tree does not compile."""
    # FX-002 · ONE CHOKE POINT. Both the baseline run and every mutant run come through here, so
    # pointing TMPDIR at the throwaway tree once contains every suite this script will ever start.
    env = mut_env_for(work)
    r = subprocess.run([CODIUM, TSC_REL, "-p", "./"], cwd=work, capture_output=True, text=True, env=env)
    if r.returncode != 0:
        return (None, "does not compile", None)
    r = subprocess.run(["./test.sh"], cwd=work, capture_output=True, text=True, env=env)
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
# ── FX-002 · CONTAINMENT SELF-CHECK ───────────────────────────────────────────────────────────────
# A 173-mutant gate is 173 suite runs. Before FX-002 each one left every fixture it created on the
# host, and 892,449 of them took the filesystem to 100% of its inode table with 74 GB free. TMPDIR is
# now pointed inside each throwaway tree, but a mutant on THIS file can never be caught (the copy's
# driver is never executed), so the containment is asserted here at run time instead: if the host's
# temp root gained `loom-*` entries across the run, the fixtures escaped and the gate says so.
host_leak = _host_fixture_count() - HOST_FIXTURES_AT_START
if host_leak > 0:
    print(f"CONTAINMENT FAILED: the run left {host_leak} loom-* director(ies) in {tempfile.gettempdir()} "
          f"— TMPDIR is no longer inside the throwaway trees, and a full gate now costs the host inodes.")
else:
    print(f"containment: 0 loom-* left in {tempfile.gettempdir()} across {len(MUTATIONS)} suite run(s).")

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
