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
 # ── NT-001 · the stop notifier ────────────────────────────────────────────────────────────────
 ("the latch re-arms on the CONDITION, not the event — the stall alarm's four-fires-a-day bug",
  "src/quiet.ts",
  "if (at !== false && at > st.lastActivityAt) {",
  "if (at !== false) {"),

 ("the notification reports when we NOTICED instead of when the work stopped",
  "src/quiet.ts",
  "stoppedAt: st.lastActivityAt,",
  "stoppedAt: now,"),

 ("a project never seen working is reported anyway — every dormant repo announces itself",
  "src/quiet.ts",
  "if (!st.seenActive) {",
  "if (false) {"),

 ("a live mutation gate stops counting as work — an 18-minute gate reads as a dead project",
  "src/quiet.ts",
  "if (s.gateRunning) return now;",
  "if (false) return now;"),

 ("a backend dedupe is counted as a delivery — a stop is latched that never reached the phone",
  "src/push.ts",
  "if (/LOOMPUSH:DEDUPED/.test(r.stdout)) {",
  "if (false) {"),

 ("push claims ready with no service account — the silent failure the preflight exists to catch",
  "src/push.ts",
  'if (m[2] !== "True") return { delivered: false, note: "off — FCM service account not present in the backend" };',
  'if (false) return { delivered: false, note: "off — FCM service account not present in the backend" };'),

 # ── NT-001-R1 · only a project whose window is OPEN ───────────────────────────────────────────
 # The first of these IS the block: it deletes the open-window requirement outright. A requirement
 # with no mutant is an unfalsifiable claim, so if this one ever survives, the feature is decoration.
 ("THE WHOLE BLOCK REMOVED — every project is reported whether or not its window is open",
  "src/quiet.ts",
  '    if (state === "open") g.send.push(f);',
  '    if (state === state) g.send.push(f);'),

 ("a CLOSED window is treated as doubt — he closes a window to be left alone and is told anyway",
  "src/quiet.ts",
  '  return "closed";\n}',
  '  return "unknown";\n}'),

 ("AN UNREADABLE WINDOW LIST READS AS CLOSED — real notifications lost with no symptom",
  "src/quiet.ts",
  '  if (!read || !Array.isArray(read.roots)) return "unknown";',
  '  if (!read || !Array.isArray(read.roots)) return "closed";'),

 ("a read that lists ZERO windows is believed — one partial /json/list silences the machine",
  "src/quiet.ts",
  '  if (!Number.isFinite(read.pages) || read.pages <= 0) return "unknown";',
  "  if (false) return \"unknown\";"),

 ("a worktree window no longer counts as its project's window — worker-only projects go unreported",
  "src/quiet.ts",
  "  const names = new Set<string>([repo, ...roles]);",
  "  const names = new Set<string>([repo]);"),

 ("a dropped stop is DEFERRED instead — reopening a window backfills a stop hours stale",
  "src/quiet.ts",
  "export function markDropped(st: ProjectQuiet): ProjectQuiet {\n  return markNotified(st);",
  "export function markDropped(st: ProjectQuiet): ProjectQuiet {\n  return st;"),

 ("withholding latches too — one unreadable tick permanently erases a notification he was owed",
  "src/extension.ts",
  "        if (gate.withheld.length > 0) {",
  "        for (const f of gate.withheld) { const c = loadQuiet(); if (c.projects[f.repo]) { c.projects[f.repo] = markDropped(c.projects[f.repo]); saveQuiet(c); } }\n        if (gate.withheld.length > 0) {"),

 ("openness is read at STOP time, before preflight — a window closed in between is told anyway",
  "src/extension.ts",
  "        const gate = gateByOpenWindow(findings, await openWindowRoots());",
  "        const gate = { send: findings, dropped: [] as typeof findings, withheld: [] as typeof findings };"),

 ("an iframe counts as a window — a panel of any project makes every window look open",
  "src/cdp.ts",
  '    if (!t || t.type !== "page") continue;',
  "    if (!t) continue;"),

 ("a failed /json/list becomes an EMPTY window list — the machine reads as all-closed",
  "src/cdp.ts",
  "    return null;                                    // endpoint down / timeout -> UNKNOWN, never \"closed\"",
  "    return { pages: 0, roots: [] };"),

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

 # CX-001 REMOVED TWO MUTANTS HERE, and they are not re-anchored because there is nothing left to
 # anchor them to. Both restored a defect in the IDLE GATE ("/clear is sent on a single idle
 # reading"; "a busy orchestrator does not reset the idle run"), which existed for one reason: a
 # /clear typed into a working composer interrupts the turn. The extension sends no clear now, so
 # the gate is gone (memory.ts), and a mutant that reintroduces a flaw in deleted code grades
 # nothing. The property they protected is covered by a stronger claim: that no clear is produced
 # from ANY state, busy or idle — see the two CX-001 mutants at the end of this table.

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
  'import { readFrames, openWindowRoots } from "./cdp";',
  'import { readFrames, openWindowRoots, closeWebview } from "./cdp";\nvoid closeWebview;'),

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

 # PD-001 RE-ANCHORED: the senderArgs argument is now the local `kind`, so the old spelling of this
 # line no longer exists. Same defect — the return address is stripped from every injection.
 ("the extension's notifications carry no return address",
  "src/inject.ts",
  "                ...senderArgs(kind, target.repo ?? null)];",
  "                ];"),

 ("the clock form of the banner is unparseable — `resets 9:50pm` yielded no deadline",
  "src/limits.ts",
  "const c = RESETS_AT_RE.exec(tail);",
  'const c = RESETS_AT_RE.exec("");'),
 # ── NT-001-R2 · the orchestrator's closing summary rides along ─────────────────────────────────
 # He asked for "that summary to come along with the notification", and he is away from his desk when
 # he reads it. The first TWO of these are the WIRING, deliberately: `orchestratorSaid` can be
 # perfect and `quietMessage` can compose perfectly, and if `runQuiet` never attaches the result he
 # gets the old two lines and no test notices. A feature whose delivery has no mutant is decoration.
 ("THE WHOLE BLOCK REMOVED — the summary is composed and never attached to the notification",
  "src/extension.ts",
  "          const m = quietMessage(r.finding, orchestratorSaid(sig.repo));",
  "          const m = quietMessage(r.finding);"),

 ("a STALE session id is trusted — the phone quotes a session that died hours ago as today's news",
  "src/quiet.ts",
  "    return sessionAgreement(boardSid, statusSid).agree ? (boardSid || statusSid) : null;",
  "    return boardSid || statusSid;"),

 ("the summary REPLACES the notification instead of riding along — when and what-last are lost",
  "src/quiet.ts",
  "    body += `\\n\\nWhat ${said.role} last said:\\n${truncateHonestly(said.text)}`;",
  "    body = `What ${said.role} last said:\\n${truncateHonestly(said.text)}`;"),

 # ── which message it is. Each of these puts something on his phone that he did not ask for.
 ("THINKING and tool calls leak into the notification — private reasoning sent to his phone",
  "src/watchers.ts",
  "      if (b.type !== \"text\") continue;",
  "      if (b.type === \"tool_use\") continue;"),

 ("a SUBAGENT's last line is reported as the orchestrator's summary",
  "src/watchers.ts",
  "  if (rec.isSidechain) return null;\n  const content = rec.message && rec.message.content;\n  let text = \"\";",
  "  const content = rec.message && rec.message.content;\n  let text = \"\";"),

 # Anchored on the SUMMARY reader's copy of the line, not the arming detector's identical one.
 ("a USER record counts as the session speaking — his own typing read back to him as a summary",
  "src/watchers.ts",
  "  if (rec.type !== \"assistant\") return null;\n  if (rec.isSidechain) return null;\n  const content",
  "  if (rec.type !== \"assistant\" && rec.type !== \"user\") return null;\n  if (rec.isSidechain) return null;\n  const content"),

 ("OUR OWN INJECTED LINE IS QUOTED BACK AT HIM — the [loom-ledger] absurdity, restored",
  "src/watchers.ts",
  "  if (INJECTED_MARK.test(text)) return null;\n  return { text,",
  "  return { text,"),

 ("the injected-line guard is keyed on the MARKER NAMES, so a marker added later leaks through",
  "src/watchers.ts",
  "const INJECTED_MARK = /^\\s*\\[loom-[a-z-]+\\]/;",
  "const INJECTED_MARK = /^\\s*\\[loom-(ledger|watch)\\]/;"),

 # ── reading it: the last word, from a bounded tail
 ("the FIRST message is reported instead of the last — he is told how the block STARTED",
  "src/watchers.ts",
  "  for (let i = lines.length - 1; i >= 0; i--) {\n    const line = lines[i];",
  "  for (let i = 0; i < lines.length; i++) {\n    const line = lines[i];"),

 ("the tail bound is gone — every stop whole-file-reads a transcript that reaches 171 MB here",
  "src/watchers.ts",
  "  const start = size > maxTailBytes ? size - maxTailBytes : 0;",
  "  const start = 0;"),

 # ── the size budget, and the honesty of a cut
 ("A CUT BECOMES SILENT — a summary ending mid-sentence reads to him as a crashed agent",
  "src/push.ts",
  "  return cut + mark(cut.length);",
  "  return cut;"),

 ("the budget counts CHARACTERS, not bytes — a 1500-char summary ships at 4500 bytes and is REJECTED",
  "src/push.ts",
  "  if (Buffer.byteLength(text, \"utf8\") <= budget) return text;",
  "  if (text.length <= budget) return text;"),

 # A SECOND, INDEPENDENT way the same overrun happens, and the reason one mutant was not enough: the
 # early-return guard above decides whether to cut AT ALL, this loop decides HOW FAR. `slice` cuts by
 # UTF-16 code unit, so without the re-measure a cut multi-byte summary still overruns.
 ("the byte-shaving loop is gone — a CUT multi-byte summary still overruns the payload",
  "src/push.ts",
  "  while (cut.length > 0 && Buffer.byteLength(cut, \"utf8\") > room) cut = cut.slice(0, -1);\n",
  ""),

 ("the cut marker is added ON TOP of the budget — the enforcer becomes the thing that overruns it",
  "src/push.ts",
  "  const room = budget - Buffer.byteLength(mark(total), \"utf8\");",
  "  const room = budget;"),

 ("a BLANK summary staples an empty section onto the body instead of falling back",
  "src/quiet.ts",
  "    if (!said || !said.text || !said.text.trim()) return null;",
  "    if (!said) return null;"),

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
  'export function frontmatter(text: string | null | undefined): Record<string, string> {\n'
  '  const m = /^\\uFEFF?[ \\t]*---[ \\t]*\\r?\\n([\\s\\S]*?)\\r?\\n[ \\t]*---[ \\t]*(?:\\r?\\n|$)/.exec(String(text || ""));',
  'export function frontmatter(text: string | null | undefined): Record<string, string> {\n'
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
  "      if (same(cur.pending, st.pending) && same(cur.escalations, st.escalations) && same(cur.ledger, st.ledger)\n          && same(cur.defaulted, st.defaulted)) return;",
  "      if (same(cur.pending, st.pending)) return;"),

 # ── CH-001, 2026-09-13: §19's chunking rules — the tracker ENFORCES disjointness and MEASURES size ─
 # Each of R1-R4 gets one, plus one per new ledger field, and each names the test that must die with it.

 # R1 — killed by "CH-001 R1: `files:` is read comma- OR space-separated, and normalised". §19's own
 # example writes commas; every handoff a human types writes spaces. Splitting on commas alone turns
 # `files: src/a.ts src/b.ts` into ONE declared path called "src/a.ts src/b.ts", which collides with
 # nothing that exists — so the guard silently has no opinion on exactly the briefs it should refuse.
 ("`files:` is comma-separated only — a space-separated line declares one impossible path",
  "src/models.ts",
  "  for (const piece of stripSpacedAnnotations(raw).split(/[,\\s]+/)) {",
  "  for (const piece of stripSpacedAnnotations(raw).split(/,/)) {"),

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
  "    const ov = overlapFor(repo, role, alsoLive);",
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

 # MS-001 R4 / MP-002 — killed by "MP-002: the fresh-context header keeps the WORKER model rule and
 # no longer tells orchestrators to shift themselves". The header is the one text every orchestrator
 # on every project reads after a clear; drop the rule from it and the `model:` line goes unwritten
 # on every bus but this one, as measured 2026-09-14 (10/10 `chosenBy: default` on ReciEats).
 ("the restore header no longer tells the orchestrator to put a model: line on its handoffs",
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

 # WL-007 — the mutant this slot used to carry aimed at `band: w.tag === null ? "bad" : "unknown"`,
 # which WL-007 DELETED: that hard-coded red WAS the defect, not the guard. Left in place it would be
 # reported STALE — a mutant whose target no longer exists grades nothing, and a gate accumulating
 # them quietly stops testing while still printing a number. REPLACED rather than removed, because
 # the contract it protected (a release state is never a blank cell) is still law; only its key
 # changed. Killed by "WL-001 R1 / WL-007: NO TAG is not a verdict".
 ("the release row goes RED whenever the repo has no git tag — permanent red on a bus that ships daily",
  "src/workledger.ts",
  "  const rel = releaseReading(w, t);",
  '  const rel = { ...releaseReading(w, t), band: (w.tag === null ? "bad" : "unknown") as Band };'),

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
  # WL-011 re-anchored: the return gained `anchor: "none"` on a second line.
  '  return { ...base, source: "unmeasured", releasedVersion: null, blocksSince: null,\n           anchor: "none" };',
  '  return { ...base, source: "deployed", releasedVersion: base.version, blocksSince: 0,\n           anchor: "none" };'),

 # R5 — killed by "WL-003-R5: no manifest and no deploy target is UNMEASURED". The SAME defect on
 # the other unmeasured path, the one a missing manifest takes. The first version of the mutant above
 # aimed only at the untracked-manifest return, which NO test reached, and it SURVIVED: the gate
 # caught that the assertion and the code it named were not meeting.
 ("a project with no manifest at all reports 0 blocks instead of unmeasured",
  "src/workledger.ts",
  # WL-007 re-anchored: this signature gained `commit` and `unshippedProduct`, which left the old
  # three-line match STALE — found by validating every anchor against source, not by the gate, which
  # had not been run since. An anchor that spans a line unrelated to the defect is an anchor that
  # rots on the next edit, so it now names only the field under test.
  '                                       version: null, releasedVersion: null, blocksSince: null,',
  '                                       version: null, releasedVersion: null, blocksSince: 0,'),

 # R5 — killed by "WL-003-R5: a manifest that has never moved says so". The one case where 'no
 # release in N blocks' is honest must not be folded into unmeasured either.
 ("a manifest that has never changed version is reported as unmeasured rather than as unreleased",
  "src/workledger.ts",
  # WL-007 re-anchored: the line gained `commit: firstSha,` before it.
  # WL-011 re-anchored again: and `anchor: "manifest-bump"` after it.
  '             commit: firstSha, neverMoved: true, anchor: "manifest-bump" };',
  '             commit: firstSha, neverMoved: false, anchor: "manifest-bump" };'),

 # ── WL-006 · a background gate that finishes after the turn ends ─────────────────────
 # MEASURED THREE TIMES (WL-002, WL-004+FX-002, WL-005). On WL-005 the gate ran ~18 minutes past
 # the turn; throughout, outbox.md line 1 named the PREVIOUS handoff and status.json's current did
 # too — indistinguishable from a worker that had done nothing. The orchestrator's workaround was
 # reading /proc/<pid>/fd/1 by hand.

 ("a dead gate's pid is trusted because /proc has an entry — a recycled pid reads as a running gate",
  "src/health.ts",
  '  if (!/mutation\\.py/.test(cmd)) return "exited";          // pid reused by something else',
  '  if (false) return "exited";          // pid reused by something else'),

 ("the declared launch time is not checked, so any long-lived process holding the pid reads as running",
  "src/health.ts",
  '  if (Math.abs(started - declared) > GATE_START_TOLERANCE_MS) return "exited";',
  '  if (false) return "exited";'),

 ("an unreadable start time is assumed to be a RUNNING gate — the alarm is suppressed for ever",
  "src/health.ts",
  '  if (started === null) return "exited";                   // cannot identify => do not claim running',
  '  if (started === null) return "running";                  // cannot identify => do not claim running'),

 ("a live gate no longer suppresses the stall alarm — a busy worker is rung and burns its context",
  "src/health.ts",
  '  return started <= now + GATE_START_TOLERANCE_MS ? "running" : "exited";',
  '  return started <= now + GATE_START_TOLERANCE_MS ? "exited" : "exited";'),

 ("a finished block's leftover declaration wakes the role again for a block that is over",
  "src/health.ts",
  '    const answered = !!(decl && decl.handoff && decl.handoff === String(s.obj.last_handled || ""));',
  '    const answered = false;'),

 ("the wake is recorded on every SCAN, so a role whose composer was busy is marked woken untold",
  "src/health.ts",
  '      if (woken[g.role] === key) continue;                  // already told this role about THIS gate',
  '      if (woken[g.role] === key) continue;\n      this.markWoken(g.role, key);'),

 ("the once-only record is keyed by ROLE, so the next gate is suppressed for ever by the last one",
  "src/health.ts",
  'export function gateKey(log: string, launchedAt: string): string {\n  return `${log}@${launchedAt}`;\n}',
  'export function gateKey(log: string, launchedAt: string): string {\n  void log; void launchedAt; return "role";\n}'),

 ("a BUSY composer is typed into anyway, so the wake queues as a message and never runs",
  "src/health.ts",
  # WL-008 re-anchored: the single guard this aimed at is now TWO, one per state. The defect it
  # protects (a busy composer is typed into, and the wake queues as an ordinary message that never
  # runs) is unchanged, so only the anchor moves.
  '    if (frame.busy) { if (done) done(false, "composer busy (mid-turn) — not typed into; retrying next tick"); return; }',
  # TWO attempts at this replacement did not compile, both refused by the WL-007-R1 pre-flight in
  # ~60s rather than by a 20-minute run reporting a hole: `if (false)` and `if (frame.busy && false)`
  # BOTH type as the literal `false`, which makes the block unreachable — and TypeScript performs no
  # control-flow narrowing in unreachable code, so the `if (done)` guard stops narrowing `done` and
  # the call fails TS2722. INVERTING the guard is the honest mutant anyway: it refuses when the
  # composer is FREE and proceeds when it is BUSY, which is exactly the defect being protected
  # against — the wake typed into a mid-turn composer, where it queues as an ordinary message and
  # never runs.
  '    if (!frame.busy) { if (done) done(false, "composer busy (mid-turn) — not typed into; retrying next tick"); return; }'),

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

 # ── TI-001 · a green run that ran nothing, and sandboxes that outlive a kill ────────
 # MEASURED 2026-09-17: `./test.sh duties.test.js` printed `0/0 passed (1071 filtered out)` and
 # EXITED 0 — the eighth costume of the vacuous baseline in this repo, and the first one sitting
 # underneath a standing rule: playbook §23 makes a targeted run a worker's ONLY verification
 # before it answers. And killing a 6-second parallel run left 3 sandboxes on the host; two killed
 # gates the same day left 42 trees holding 79,741 inodes.
 #
 # VERIFY THESE WITH `--file fixtures.test.js`, NEVER WITH A NAME FILTER. Two of them mutate the
 # filter itself, so a name-filtered run would exit non-zero because the runner REFUSED, and a
 # refusal reads exactly like a kill. That is the trap this block was written inside.

 # Killed by "TI-001: a filter that matches NOTHING exits non-zero".
 ("the zero-test guard is gone — a filter matching nothing reports success again",
  "test/run-tests.js",
  "  if (pass + fail === 0) {",
  "  if (Boolean(0)) {"),

 # Killed by "TI-001: a TEST FILE name runs that file's suites". The ORIGINAL defect, restored: a
 # file name falls through to the suite-name filter and selects nothing.
 ("a filter is a suite NAME only — the file spelling §23 tells workers to use matches nothing",
  "test/run-tests.js",
  'function looksLikeFile(arg) { return /\\.js$/i.test(path.basename(String(arg))); }',
  'function looksLikeFile(arg) { return Boolean(0); }'),

 # R1 — killed by "TI-001: a suite-NAME filter is NOT narrowed to a file of the same name". THE
 # DEFECT THE FIRST VERSION OF THIS BLOCK SHIPPED, found by an adversarial pass: trying the file
 # name first for ANY argument made `./test.sh notifier` run notifier.test.js alone and silently
 # drop the "notifier" suites in extension.test.js — non-zero count, exit 0, invisible to the
 # zero-test guard. A subset reported as the whole is the same lie in a new place.
 ("any filter is tried as a FILE first — a name filter is silently narrowed to one file",
  "test/run-tests.js",
  'function looksLikeFile(arg) { return /\\.js$/i.test(path.basename(String(arg))); }',
  'function looksLikeFile(arg) { return Boolean(arg); }'),

 # R1 — killed by "TI-001: the SINGLE-PROCESS path is interruptible…". The occupant stamps itself;
 # without it the directory keeps the PARENT's pid, and a SIGKILLed parent leaves a live orphan
 # whose HOME the next run's reaper deletes out from under it. Reproduced on this host.
 ("the process inside the sandbox never claims it — the stamp stays the parent's",
  "test/run-tests.js",
  'stampOwner(process.env.LOOM_TEST_SANDBOX, process.pid);',
  'void stampOwner;'),

 # R1 — killed by the SAME test's promptness assertion. spawnSync blocks the event loop, so with
 # handlers installed a SIGTERM cannot be delivered until the run ENDS: the handlers swallow the
 # signal and an outer `timeout` or a reap stops stopping the run. Measured: still running 13s
 # after SIGTERM, where the default disposition had killed it at once.
 ("the single-process path blocks the event loop again — the handlers swallow the signal",
  "test/run-tests.js",
  '    const child = spawn(process.execPath, [__filename, ...process.argv.slice(2)], { stdio: "inherit", env });\n    LIVE_CHILDREN.add(child);\n    child.on("close", (code, signal) => {\n      LIVE_CHILDREN.delete(child);\n      reclaim(sandbox);\n      process.exit(signal ? 1 : code === null ? 1 : code);\n    });\n    return;',
  '    const r = require("child_process").spawnSync(process.execPath, [__filename, ...process.argv.slice(2)], { stdio: "inherit", env });\n    reclaim(sandbox);\n    process.exit(r.status === null ? 1 : r.status);'),

 # R1 — killed by "…an OLD unstamped one outlived every possible run". Ignoring unstamped
 # directories for ever turns the mkdtemp/stamp window, and every pre-0.56.0 leftover, into a
 # PERMANENT leak — the thing this block exists to end.
 ("an unstamped sandbox is never collectable, however old — the leak just moves",
  "test/run-tests.js",
  'const UNSTAMPED_GRACE_MS = 24 * 60 * 60 * 1000;',
  'const UNSTAMPED_GRACE_MS = Number.POSITIVE_INFINITY;'),

 # R1 — killed by "…a RECENT unstamped directory could still be in use". THE DANGEROUS DIRECTION:
 # no grace at all means the reaper deletes a sandbox created microseconds ago by a live run.
 ("the unstamped grace is zero — a sandbox opened a moment ago is reaped from under a live run",
  "test/run-tests.js",
  '      if (age < UNSTAMPED_GRACE_MS) continue;                 // could still be in use — leave it',
  '      if (Boolean(0)) continue;'),

 # Killed by "TI-001: an INTERRUPTED run leaves NO sandbox behind". The `exit` handler alone does
 # NOT cover this: default signal disposition terminates without running exit handlers.
 ("the signal handlers are gone — a killed run leaks every sandbox in flight, as it did",
  "test/run-tests.js",
  '  for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) {',
  "  for (const sig of []) {"),

 # Killed by "TI-001: the next run reaps what a SIGKILL abandoned".
 ("the reaper never runs — what a SIGKILL abandoned stays on the host for ever",
  "test/run-tests.js",
  "  const reaped = reapAbandonedSandboxes();",
  "  const reaped = 0;"),

 # Killed by the SAME test's other half. THE DANGEROUS DIRECTION: a reaper that ignores whether the
 # owner is alive deletes the HOME of a running job — worse than the leak it fixes.
 ("the reaper ignores whether the sandbox's owner is still alive",
  "test/run-tests.js",
  '    try { process.kill(pid, 0); continue; } catch (e) { if (e.code !== "ESRCH") continue; }',
  '    try { process.kill(pid, 0); } catch (e) { if (e.code !== "ESRCH") continue; }'),

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
  # CX-001 RE-ANCHORED: the note this lands on is now the BANKED note, not the clear note — the step
  # was renamed, the sentence WL-004 fought for was not, and the claim is unchanged.
  '                 ? ` — large; every fresh context re-reads it in full` : ""}) — ` +',
  '                 ? ` — over the ${MAX_MEMORY_BYTES.toLocaleString()}-byte cap; every fresh context pays for it, trim it` : ""}) — ` +'),

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


 # ── WL-007 · ONE answer to "did this reach a user", for every reader ──────────────────────────
 #
 # WL-003-R5 rekeyed the COLLECTOR off git tags and exactly ONE of four readers. The other three went
 # on reading `w.tag` — null for ever on a repo with no tags — so on 2026-09-15, a day this bus
 # deployed five builds, the panel tile, the summary line and the orchestrator's own nudge all said
 # "no release in 88 blocks". A GREEN SUITE DID NOT FIND THAT; a grep did. These are the mutants that
 # would have.

 # Killed by "WL-007: ALL FOUR readers take the release line from w.release, not from w.tag".
 ("a reader is pointed back at the TAG PROXY — the exact defect WL-007 removes, in the summary line",
  "src/workledger.ts",
  "    releaseReading(w).text,",
  '    w.tag === null ? `no release in ${w.commits} blocks` : `${w.blocksSinceRelease ?? "?"} since ${w.tag}`,'),

 # Killed by "WL-007: unmeasured gets its OWN band -- never a colour that means 'you are failing'".
 # The WL-002 lie-with-a-number-on-it in a new place. The statement and the colour are separate
 # wrongs, so they are separate mutants: one claims a measurement never made, the other calls a
 # missing measurement a failure.
 ("an UNMEASURED release renders as 'never shipped' — a measurement claimed where none was made",
  "src/workledger.ts",
  # WL-010 re-anchored: the unmeasured branch gained a REASON and an optional newest-tag suffix.
  # The defect it protects — a missing measurement stated as a fact about the product — is unchanged.
  '    return { text: r.newestTag ? `release ${UNMEASURED} — newest tag ${r.newestTag}`',
  '    return { text: r.newestTag ? `no release in ${w.commits} blocks`'),

 ("an UNMEASURED release is coloured a FAILURE — and that band drives the whole ledger node's icon",
  "src/workledger.ts",
  # WL-010 re-anchored onto the band line, which is now its own line.
  '             band: "unknown",',
  '             band: "bad",'),

 # Killed by "WL-007: the band is a SHARE of the window, not a line count". Found by RUNNING the
 # first version of this band rather than reasoning about it: as a flat count it fired on THIRTEEN
 # unshipped lines and put the aggregate icon back to red on a bus that ships daily — this block's
 # own defect, reintroduced by this block's own fix.
 ("unshipped product is judged as a flat COUNT, not a share of the window — 13 lines reads as failure",
  "src/workledger.ts",
  # WL-007-R1: the first version of this mutant replaced ONE line of the ternary chain and left the
  # next `: share <= ...` dangling — a syntax error. It was graded STALE "(mutant does not compile)"
  # and so guarded nothing, on the newest code in the block, which is exactly where a bad anchor
  # lands. The replacement takes the whole chain, so the text it produces is a valid expression.
  '''    : share === null ? "warn"
    : share >= t.unshippedShareBad ? "bad"
    : share <= t.unshippedShareGood ? "good" : "warn";''',
  '    : "bad";'),

 # Killed by "WL-007: unshipped product is a two-point PRODUCT diff, not a commit count".
 # The measurement half of this block had NO test until the review pass — a mutant here would have
 # SURVIVED as UNCOVERED, the plain hole among the three species rather than an argument about the gate.
 ("docs and tests count as unshipped PRODUCT — a HANDOVER commit reads as work a user is missing",
  "src/workledger.ts",
  "    const file = renamedTo(m[3]);\n    if (!cls.isProduct(file)) continue;",
  "    const file = renamedTo(m[3]);"),

 # Killed by "WL-007: with no release commit to measure from, unshipped product is null, NEVER 0".
 ("no release commit to measure from reports ZERO unshipped — 'cannot tell' told as 'all shipped'",
  "src/workledger.ts",
  "  if (!repoPath || !commit) return null;",
  "  if (!repoPath || !commit) return 0;"),


 # ── WL-007-R1 · an interrupting message states ITS OWN cause ─────────────────────────────────
 # Killed by "WL-007-R1: the release clause renders ONLY when the release is why the alert fired".
 ("the release clause rides along on someone else's alarm again — the 00:05Z interrupt, restored",
  "src/workledger.ts",
  '         `${releaseBad ? `${releaseReading(w, t).text}. ` : ""}` +',
  '         `${releaseReading(w, t).text}. ` +'),

 ("a release state that IS an alarm cannot raise one — only heard when another figure is already red",
  "src/workledger.ts",
  "  if (!shipsBad && !costBad && !nothingShipped && !unmeasured && !releaseBad) return null;",
  "  if (!shipsBad && !costBad && !nothingShipped && !unmeasured) return null;"),


 # ── WL-008 · a mechanism that fails silently is the worst kind ────────────────────────────────
 #
 # MEASURED IN THE FIELD 2026-09-16: the WL-006 gate wake shipped in 0.38.3 behind a 188/188 gate
 # and NEVER FIRED ONCE, across two real gates. `busyRoles` was a Set only ever added to, so the
 # first tick that saw a role mid-turn latched it busy for ever — and since a worker MUST be mid-turn
 # to launch a gate, the feature could never have fired at all. Every existing test drove the pure
 # isBusy() helper, which was correct the whole time. Nothing drove the STATE BUILT FROM IT.

 # Killed by "WL-008: a role that STOPS being busy stops being in busyRoles".
 ("busyRoles latches: the Set is never rebuilt, so one mid-turn tick marks a role busy for ever",
  "src/tracker.ts",
  "    this.busyRoles = new Set();",
  "    // busyRoles deliberately not rebuilt"),

 # Killed by "WL-008: the two refusal states are two SENTENCES, not one word".
 ("the two refusal states wear ONE note again — the line that made the field failure undiagnosable",
  "src/health.ts",
  '    if (!frame) { if (done) done(false, "no live frame for this role — its tab is gone or unattributed"); return; }',
  '    if (!frame) { if (done) done(false, "composer busy or frame not found"); return; }'),

 # Killed by "WL-008: a refused wake is RECORDED, with its reason and when it started".
 ("the pending clock restarts on every refusal — a wake refused for hours always looks one tick old",
  "src/health.ts",
  "    pend[role] = prev && prev.key === key\n      ? { ...prev, attempts: prev.attempts + 1, note }\n      : { key, since: new Date(now).toISOString(), attempts: 1, note };",
  "    pend[role] = { key, since: new Date(now).toISOString(), attempts: 1, note };"),

 # Killed by "WL-008: delivery CLEARS the pending record — it is waiting, not history".
 ("a delivered wake stays on the pending list — the alarm then reports a wake that already landed",
  "src/health.ts",
  "    const pend = { ...(st.gatesPending || {}) };\n    delete pend[role];                      // delivered: it is no longer waiting on anything",
  "    const pend = { ...(st.gatesPending || {}) };"),

 # Killed by "WL-008: THE THIRD STATE — a stall says whether a gate was ever declared".
 ("a stall no longer says whether a gate was ever declared — two situations, one word again",
  "src/health.ts",
  '      out.stalled.push({ role, status, staleHours: (now - s.mtimeMs) / HOUR_MS,\n                         gate: answered && decl ? "spent" : "none" });',
  "      out.stalled.push({ role, status, staleHours: (now - s.mtimeMs) / HOUR_MS });"),


 # ── WL-009 · a grade produced by chance ────────────────────────────────────────────────────────
 #
 # A test that fails at RANDOM can mark a mutant "caught" with no relation to the mutant, because a
 # mutant is scored caught when a baseline-passing test now fails. The direction seen on 2026-09-16
 # was the safe one — the flake hit the BASELINE and the gate refused — but the dangerous direction
 # is silent. `workledger.test.js` banned the bare substring `/999/` across reader text that echoes a
 # RANDOM base-36 fixture name: p = 1.9e-4 per suite run, 3.8% per 203-run gate, about one gate in 26.
 # The suite now renders every reader TWICE off one ledger and requires them byte-identical, so the
 # random name appears in both renders and cancels. These mutants prove that assertion still bites.

 # Killed by "WL-007: ALL FOUR readers take the release line from w.release, not from w.tag"
 # (rewritten in WL-009 — the differential form, which names WHICH reader drifted).
 ("a reader appends blocksSinceRelease — the demoted field back in the product, by a spelling no ban would catch",
  "src/workledger.ts",
  "    releaseReading(w).text,",
  "    releaseReading(w).text + ` [${w.blocksSinceRelease} since ${w.tag}]`,"),

 # Killed by "WL-003-R5: no manifest and no deploy target is UNMEASURED — never '0 blocks', never
 # 'never'". WL-009 ANCHORED that ban (`\b0 block`) because the bare form also matched "10 block(s)"
 # in the same briefing — the same class as the /999/ flake, latent rather than firing. The anchor
 # must still ban what it was written to ban, which is what this reintroduces.
 ("an UNMEASURED release is briefed as '0 block(s)' — unseen rendered as just-shipped",
  "src/workledger.ts",
  # WL-010 re-anchored: the briefing's unmeasured line now carries the same reason the tile gives.
  "    L.push(`Whether anything has been released is ${UNMEASURED}: ` +",
  "    L.push(`0 block(s) since release. Whether anything has been released is ${UNMEASURED}: ` +"),


 # ── WL-010 · one manifest speaking for a whole repo ────────────────────────────────────────────
 #
 # MEASURED across all 12 buses. findManifest recognises NODE manifests only, and its state was then
 # rendered as a claim about the entire project: Lumen (40 tags, ships iOS/Android from Gradle and
 # Xcode) read "never released" RED off a JS corner that never moved; livegita (36 tags, newest three
 # days old) measured unshipped product from a MAY manifest bump and announced "44476 product line(s)
 # not in front of a user ... and no build is queued" about a project that shipped that week.

 # Killed by "WL-010: THE LUMEN CASE — a manifest that never moved, in a repo that tags".
 ("a manifest that never moved still says 'never released' even where the repo's tags contradict it",
  "src/workledger.ts",
  "    const auth = manifestAuthority(repoPath, m.rel, null);\n    if (!auth.ok) return fromAuthority(auth);",
  "    const auth = manifestAuthority(repoPath, m.rel, null);"),

 # Killed by "WL-010: a tag NEWER than anything the manifest records takes the answer from it".
 ("a STALE manifest bump still anchors the measurement — livegita's 44,476 restored",
  "src/workledger.ts",
  "    const auth = manifestAuthority(repoPath, m.rel, bump.sha);\n    if (!auth.ok) return fromAuthority(auth);",
  "    const auth = manifestAuthority(repoPath, m.rel, bump.sha);"),

 # Killed by "WL-010: a tag OLDER than the manifest bump CORROBORATES — it must not veto".
 # A tag that AGREES with the manifest must leave it in charge; vetoing on any tag at all would
 # replace a true verdict with a shrug, which is the other way to be useless.
 ("ANY tag vetoes the manifest, even one older than its own release commit",
  "src/workledger.ts",
  "    tagWins = Number.isFinite(tagAt) && (!Number.isFinite(relAt) || tagAt > relAt);",
  "    tagWins = Number.isFinite(tagAt);"),

 # Killed by "WL-010: a repo that also builds with another ecosystem is UNMEASURED, not judged".
 # The first version of this list used bare `build.gradle`, which as a git pathspec matches only the
 # repo ROOT — so android/build.gradle was invisible and the rule matched nothing. A guard that looks
 # right and matches nothing is indistinguishable from no guard at all.
 ("the foreign-build scan only looks at the repo ROOT, so a nested android/ build is invisible",
  "src/workledger.ts",
  '  ["*build.gradle", "Gradle"], ["*build.gradle.kts", "Gradle"], ["*settings.gradle", "Gradle"],',
  '  ["build.gradle", "Gradle"], ["build.gradle.kts", "Gradle"], ["settings.gradle", "Gradle"],'),

 # Killed by "WL-010: a MANIFEST BUMP does not claim a user has it".
 ("a manifest bump claims the version is in front of a user — a confident green with no artifact",
  "src/workledger.ts",
  '                : "was cut (manifest bump — not seen in front of a user)";',
  '                : "is in front of a user";'),

 # Killed by "WL-010: 'pending a build' is never computed against a TAG NAME".
 ("'pending a build' is computed against a tag NAME, which is never equal to a manifest version",
  "src/workledger.ts",
  '  const pending = r.source !== "tag" && r.version !== null && r.releasedVersion !== null\n                  && r.version !== r.releasedVersion;',
  "  const pending = r.version !== null && r.releasedVersion !== null\n                  && r.version !== r.releasedVersion;"),


 # ── MP-002, 2026-09-16: the model policy applies to NON-ORCHESTRATORS ONLY ───────────────────────
 # Owner: "The extension changing orchestrators model version. Must stop. It only applies to
 # non-orchestrators." Two paths used to type /model into the orchestrator's own frame and both are
 # gone; what remains is the refusal in `enforce()`, the ONE method every injection passes through.
 # Each clause of that refusal gets a mutant, because each one is a different way in.

 # Killed by "MP-002: enforce() REFUSES the tagged orchestrator's own frame". This is the 2026-09-10
 # misroute exactly: four buses carry a `developer1`, the tracker resolved one to the PO's own frame,
 # and 16 `/model claude-opus-5` messages landed in tfg_ua's orchestrator, which replied that it
 # could not switch models from inside the session. The frame clause is what makes that impossible.
 ("the enforce() frame guard is removed — a role resolved to the orchestrator's frame is typed into",
  "src/models.ts",
  "    const ownFrame = !!(v.webviewId && tagged && tagged.webviewId && v.webviewId === tagged.webviewId);",
  "    const ownFrame = false;"),

 # Killed by "MP-002: enforce() refuses an OWNER-NAMED role and the TAGGED role by name, tagged or
 # not". shwab_docker's `productowner` sat pending because the policy ran 30 seconds before its
 # orchestrator.json was written — an UNTAGGED project exempts nothing by tag, so the NAME is the
 # only thing that can refuse it in that window.
 ("the enforce() owner-name guard is removed — an untagged project types into its own orchestrator",
  "src/models.ts",
  "    const owner = isOwnerRole(v.role);",
  "    const owner = false;"),

 # Killed by "MP-002: enforce() refuses an OWNER-NAMED role and the TAGGED role by name" (its final
 # assertion). A project may tag any name it likes — the tag is the human's statement of which tab is
 # the orchestrator, and it binds even when that tab is called `developer1` and sits in another frame.
 ("the enforce() tagged-role guard is removed — a worker-named orchestrator is switched",
  "src/models.ts",
  "    const taggedRole = !!(tagged && tagged.role && tagged.role === v.role);",
  "    const taggedRole = false;"),

 # Killed by "MP-002: the tag is re-read per injection". Caching the tag on the policy object means a
 # tab tagged between ticks is typed into until the window reloads — and the tag is set by a human
 # clicking, which is exactly when the next tick is seconds away.
 ("the orchestrator tag is read once and cached — a tab tagged between ticks is still typed into",
  "src/models.ts",
  "    const tagged = getOrchestrator(v.repo || null);",
  "    const tagged = null as ReturnType<typeof getOrchestrator>;"),

 # Killed by "MP-002: an orchestrator-model.json asking for another tier is inert". The refusal must
 # RETURN, not merely report: without the early return the note reaches the caller and the injection
 # is made anyway — the worst shape of this defect, because the debug log would say "refused".
 ("the refusal reports but does not return — the /model is typed anyway, and the log says refused",
  "src/models.ts",
  "      done?.(false, `refused: ${v.role} is ${why} — the model policy applies to non-orchestrators only`);\n      return;",
  "      done?.(false, `refused: ${v.role} is ${why} — the model policy applies to non-orchestrators only`);"),


 # ── CL-001, 2026-09-16: a block dispatched into a session that was never cleared ─────────────────
 # Playbook §12 (2026-09-08) requires a clear-and-re-bind between every handoff. Measured across
 # every bus 2026-09-16: 18 of the 24 roles whose transcript could be read were carrying more than
 # one block in one session — shwab_docker/trader held 22 in 64.3 MB. The detection is one
 # comparison (a new handoff id under an unchanged session id) and every way of loosening it is here.

 # Killed by "CL-001 scanClears: a CHANGED session id is a /clear and raises NOTHING". Without the
 # session comparison the guard can only ever accuse: the orchestrator that DID clear is reported
 # exactly like the one that did not, which is the fastest way to make a reminder ignored.
 ("the session id is never compared — a role that WAS cleared is reported anyway",
  "src/health.ts",
  "      if (!prev || prev.session !== snap.sessionId) {",
  "      if (!prev || prev.session !== prev.session) {"),

 # Killed by "CL-001 scanClears: a NEW handoff id under an UNCHANGED session id raises one event".
 # The opposite loosening, and the one that fails SILENTLY: re-baselining every tick means nothing is
 # ever an arrival and the guard reports nothing, for ever, while every test of the message passes.
 ("every tick re-baselines — nothing is ever an arrival and nothing is ever reported",
  "src/health.ts",
  "      const prev = cl[snap.role];",
  "      const prev = undefined as (typeof cl)[string] | undefined;"),

 # Killed by "CL-001 checkHealth: a role it cannot judge is never counted as clean". WL-002's rule,
 # and the vacuous-baseline shape a fourth time: a role with no session_id on the board is not a role
 # with zero blocks, and rendering it as judgeable is one state standing in for another.
 ("a role that cannot be judged is marked judgeable — 'cannot tell' renders as clean",
  "src/health.ts",
  # PB-001 re-anchored: the ternary gained an identity-agreement arm, so the old literal no longer
  # matched and this mutant was silently unbuildable. The claim is unchanged — every "cannot tell"
  # arm collapses to a clean bill of health.
  '        unknown: !sessionId ? "board.json declares no session_id for this role — a clear is undetectable"\n'
  "               : !agree.agree ? agree.note\n"
  '               : ids.length === 0 ? "status.json names no handoff id (no `current`, no `last_handled`)"\n'
  "               : null,",
  "        unknown: null,"),

 # Killed by "CL-001 scanClears: a CHANGED session id is a /clear and raises NOTHING" (its `ids`
 # assertion). `last_handled` SURVIVES a clear — the worker rewrites its status file, it does not
 # start one — so seeding the new session with everything present carries a finished block across the
 # boundary, and the next reminder names a block from the session that was cleared.
 ("the new session's baseline keeps what the old one carried — a cleared block is named later",
  "src/health.ts",
  "        const carried = prev\n          ? [...prev.ids, ...(prev.reported || []), ...(prev.seen || []), ...(prev.dropped || [])] : [];",
  "        const carried: string[] = [];"),

 # Killed by "CL-001 scanClears: an UNDELIVERED arrival does not cross a /clear boundary". FOUND IN
 # THE FIELD, not by the suite: every unit test had delivered the arrivals it raised, so an arrival
 # raised on a tick with a busy composer — in neither the baseline nor `reported` — was invisible to
 # the boundary rule and followed the role into its next session.
 ("an arrival is remembered only once DELIVERED — an undelivered one crosses a /clear",
  "src/health.ts",
  "        cl[snap.role] = { ...prev, seen: [...new Set([...(prev.seen || []), ...arrived])] };",
  "        cl[snap.role] = { ...prev, seen: [...(prev.seen || [])] };"),

 # Killed by "CL-001 markClearReported: an event repeats until it is DELIVERED, then stops". Marking
 # on ATTEMPT is the asserted-is-not-reached shape that has now cost this project six findings: the
 # state would say the orchestrator was told, for a message a busy composer never took.
 ("a raised arrival is treated as told — a reminder refused by a busy composer is never re-sent",
  "src/health.ts",
  "      const known = [...prev.ids, ...(prev.reported || [])];",
  "      const known = [...prev.ids, ...(prev.reported || []), ...(prev.seen || [])];"),

 # Killed by "CL-001 scanClears: an UNDELIVERED arrival does not cross a /clear boundary" (through
 # the state file). saveStall's early return compares field by field; leaving `clears` out of it
 # means a tick that changed ONLY the clear state reaches no disk at all — and the state file looks
 # exactly as it does when nothing ever happened.
 ("the clear state is left out of the change test — it never reaches disk",
  "src/health.ts",
  "          && JSON.stringify(cur.clears || {}) === JSON.stringify(st.clears || {})) return;",
  "          ) return;"),

 # Killed by "CL-001 clearReminder: a reminder naming the next action, never a gate". The count is a
 # FLOOR — only blocks seen to arrive since `since` are in it — and stating a floor as a total invites
 # an orchestrator to argue with a number instead of doing the one thing the message asks.
 ("the floor is stated as a total — a number that can be wrong replaces one that cannot",
  "src/health.ts",
  "    return `[loom-clears] ${ev.role} has now carried at least ${ev.blocks} handoff ids in ONE session ` +",
  "    return `[loom-clears] ${ev.role} has now carried ${ev.blocks} handoff ids in ONE session ` +"),

 # Killed by "CL-001 on the real tick: the reminder is delivered by runTick, and a /clear silences
 # it". THE WL-008 MUTANT. 188/188 green shipped a mechanism that could never fire because every test
 # drove scanGates and nothing drove the thing that CALLS it. This mutant severs exactly that wire:
 # the guard still works, is still fully tested, and never runs.
 ("the tick never calls the clear watcher — the whole guard is dead code in the field",
  "src/extension.ts",
  "        for (const ev of healthWatcher.scanClears(report)) {",
  "        for (const ev of [] as ReturnType<typeof healthWatcher.scanClears>) {"),

 # Killed by the same real-tick suite. A guard that ships switched off is a guard nobody has.
 ("the reminder defaults to off — a project that never sets the flag gets nothing",
  "src/extension.ts",
  '      if (cfg().get<boolean>("clearReminders", true) === true) {',
  '      if (cfg().get<boolean>("clearReminders", false) === true) {'),
 # ── WL-011 · the ANCHOR, not the arithmetic ──────────────────────────────────────────────────
 # Measured 2026-09-16 over this repo's own 49 deployed artifacts: the anchor lands on the wrong
 # COMMIT in 22 of 48 and renders a wrong NUMBER in 4 (+216, +152, +13, -412). Every mutant below
 # restores one of those wrongs, and each is killed by a test that asserts the CLAIM, not a spelling.

 # Killed by "WL-011: TWO BLOCKS UNDER ONE VERSION". Skipping the content match falls back to the
 # version bump, which cannot see a second block shipped under an existing version number — the
 # defect exactly: 0.40.0 announced 152 deployed lines as "not in front of a user".
 ("the deployed commit is inferred from the version bump, not read from the artifact's content",
  "src/workledger.ts",
  "    const byContent = art ? deployedCommit(repoPath, m.rel, art.dir) : null;",
  "    const byContent = null as null | { sha: string; matched: number };"),

 # Killed by the same test's STALE half. Matching only the FIRST file is a plausible optimisation
 # and is wrong: package.json alone is identical across every commit under one version, which is
 # how the anchor became the bump in the first place.
 ("the content match accepts the first shipped file instead of all of them",
  "src/workledger.ts",
  "    for (const [p, h] of want) if (at.get(p) !== h) { all = false; break; }",
  "    for (const [p, h] of want) { all = at.get(p) === h; break; }"),

 # Killed by "WL-011: A DISTANCE IS ONLY MEASURABLE FROM AN ANCHOR ON THIS HISTORY". This is the
 # Lumen defect restored: a tag on an abandoned train counts 189 of 189 commits and diffs two
 # branches against each other for a five-figure negative that bands GOOD.
 ("an anchor off this history is measured anyway — two branches diffed against each other",
  "src/workledger.ts",
  "export function onThisHistory(repoPath: string | null, sha: string | null): boolean {\n  if (!repoPath || !sha) return false;\n  return git(repoPath, [\"merge-base\", \"--is-ancestor\", sha, \"HEAD\"]) !== null;\n}",
  "export function onThisHistory(repoPath: string | null, sha: string | null): boolean {\n  return !!repoPath && !!sha;\n}"),

 # Killed by the same test, at the netProductSince half. The chokepoint is the point: a caller that
 # forgets the guard must still be refused.
 ("netProductSince measures from an off-history anchor — the guard moves back to the caller",
  "src/workledger.ts",
  "  if (!onThisHistory(repoPath, commit)) return null;",
  "  if (false) return null;"),

 # Killed by "WL-011: the off-history release is NAMED, its distance is unmeasured". THE WL-010-R1
 # CLASS: the READER trusting an upstream invariant instead of holding it. Found by the test, not by
 # review — with this in place the tile rendered "3468.8% of this window's net product".
 ("a reader takes the distance straight off the field instead of through its own chokepoint",
  "src/workledger.ts",
  # RE-ANCHORED BY WL-012, which added `netShrank` to this chokepoint's return. The pre-flight
  # caught it as STALE and refused to grade the whole run rather than scoring it — a mutant that
  # never ran is not evidence that a defect would be caught.
  "  if (r.anchorOffHistory) return { blocksSince: null, unshippedProduct: null, netShrank: null };",
  "  if (false) return { blocksSince: null, unshippedProduct: null, netShrank: null };"),

 # Killed by "WL-011: the briefing names the basis it ACTUALLY has". A tag reported under a basis it
 # does not have, in the one reader an orchestrator reads before choosing the next block.
 ("the briefing calls every non-deployed release a manifest bump, including a tag",
  "src/workledger.ts",
  # Anchored with the line above it: the 6-space form is a SUBSTRING of `basis`'s 14-space line in
  # releaseReading, so on its own it matches twice and the pre-flight refuses it.
  '    const how = r.source === "deployed"\n      ? (r.anchor === "content" ? "deployed artifact, anchored on its content"\n                                : "deployed artifact, anchored on the version bump")\n      : r.source === "tag" ? "git tag" : "manifest bump";',
  '    const how = r.source === "deployed" ? "deployed artifact" : "manifest bump";'),

 # Killed by "WL-011-R1: a release object carrying its OWN DOUBT says so in every reader". The
 # reason is COMPUTED whenever a manifest is refused authority and was rendered only on the
 # `unmeasured` branch — so a tag reading named a tag and never said why the manifest was set aside.
 # A demoted signal that nothing consults is deleted data with extra steps (WL-010, one layer in).
 ("the tile names a tag without saying why the manifest it contradicts was set aside",
  "src/workledger.ts",
  '            `${r.unmeasuredReason ? ` Measured against a tag rather than the manifest: ` +\n               `${r.unmeasuredReason}.` : ""}` };',
  '            `` };'),

 # Killed by the same suite's briefing half — the reader an orchestrator sees before dispatching.
 ("the briefing carries the release claim but drops the doubt recorded beside it",
  "src/workledger.ts",
  '           `${r.unmeasuredReason ? `; ${r.unmeasuredReason}` : ""}.`);\n  }\n  if (w.handoffs > 0',
  '           `.`);\n  }\n  if (w.handoffs > 0'),

 # Killed by "WL-003 R3" and "WL-003 R2" (the briefing wording). The PO's own briefing carried this
 # beside a correct release line: two disagreeing claims about reaching a user in one message.
 ("the block count claims product REACHED A USER when it counts commits that CHANGED product",
  "src/workledger.ts",
  "    L.push(`${w.blocksSinceProduct} block(s) since product code last changed` +",
  "    L.push(`${w.blocksSinceProduct} block(s) since anything reached a user` +"),

 # MC-001 · THE EXACT DEFECT the block was written to fix, reintroduced: a freshly-restored session,
 # whose whole job is to READ its memory file, is told again to WRITE it. Killed by
 # "context memory: the fresh session is restored from the memory doc" (extension.test.js), which
 # asserts the delivered --reply line is context-restore's, never context-save's.
 ("the restore step's reply hint reverts to the save one — a fresh session is told to write, not read",
  "src/extension.ts",
  # CX-001 RE-ANCHORED onto the two-arm ternary the clear step left behind. MC-001's claim is
  # untouched: whatever else changes, a RESTORE must not carry the SAVE's reply hint.
  '      const replyKind = step.kind === "save" ? "context-save" : "context-restore";',
  '      const replyKind = step.kind === "save" ? "context-save" : "context-save";'),

 # CX-001 REMOVED THE CLEAR-STEP REPLY-KEY MUTANT. It swapped the `clear` arm of the replyKind
 # ternary for the restore one; that arm no longer exists, because no clear step is ever produced or
 # injected. `REPLY_FOR["context-clear"]` is kept in inject.ts as documentation of a message this
 # subsystem once sent — it is unreachable, so there is nothing about it left to mutate.

 # MC-001 · the whole point of injectTo's new `replyKind` parameter is that it can differ from the
 # debug-log file name; dropping it collapses save/clear/restore back onto ONE reply line again (via
 # the "context-debug.json" fallback, which no longer even has a REPLY_FOR entry — every context-
 # memory message would get the generic "none — this is a tool" line). Killed by the save-step
 # assertion in extension.test.js, which requires the SAVE-specific line, not the generic fallback.
 # PD-001 RE-ANCHORED. This mutant used to cut `replyKind ?? ` out of the senderArgs call directly;
 # that argument is now the local `kind`, computed one line up and used by BOTH the reply hint and
 # the reporting contract, so the old anchor no longer matches any line in the file. Same defect,
 # current shape — and it now also collapses the contract's keying, which is the stronger kill.
 ("injectTo ignores replyKind — every context-memory message collapses back onto one debug-log key",
  "src/inject.ts",
  "const kind = replyKind ?? debugName;",
  "const kind = debugName;"),

 # ── MOD-001 §5 · WHICH BUILD SAID THIS ─────────────────────────────────────────────────────────
 # The defect these restore is not a crash: it is an alarm that cannot be checked against the tree.
 # A live [loom-clears] was once read as a statement about main, and establishing that it had come
 # from a stale 0.44.0 window cost a block's attention. A stamp that is absent, or that names a
 # version nobody can act on, puts that cost straight back.

 ("no injected message names its build — every alarm is unfalsifiable evidence again",
  "src/inject.ts",
  "  const stamped = `${msg}\\n\\n${buildStamp()}`;",
  "  const stamped = msg;"),

 ("a blank version stamps an empty build instead of saying 'unknown' — the reminder looks stamped "
  "and names nothing",
  "src/inject.ts",
  'buildVersion = String(v || "").trim() || "unknown";',
  'buildVersion = String(v || "");'),

 ("the extension stops telling inject.ts which build it is — every message reports 'unknown' from a "
  "window that knows its own version",
  "src/extension.ts",
  "    setBuildVersion(VERSION);",
  "    void setBuildVersion;"),

 # ── PD-001 · the reporting contract (owner: orchestrators talk PRODUCT, not statistics) ────────
 # Each of these is a way the boundary can silently stop being a boundary. The two that matter most
 # are the second and third: they do not remove the feature, they point it at the WRONG session, and
 # a worker told to report "product, not figures" would stop sending the counts a block is banked on.

 ("the contract is never attached — the feature is inert and every orchestrator message is unchanged",
  "src/inject.ts",
  "  if (!ORCHESTRATOR_KINDS.has(kind)) return stamped;\n  return `${stamped}\\n\\n${REPORTING_CONTRACT}`;",
  "  if (!ORCHESTRATOR_KINDS.has(kind)) return stamped;\n  return stamped;"),

 ("the contract goes to EVERYONE — a worker is told to drop the counts its orchestrator banks on",
  "src/inject.ts",
  "  if (!ORCHESTRATOR_KINDS.has(kind)) return stamped;",
  "  if (false) return stamped;"),

 ("the gate wake is reclassified as orchestrator-facing — the one message that ASKS for grade counts "
  "is told not to report figures",
  "src/inject.ts",
  '  "gate-debug.json",     // health.ts  — YOUR gate exited; read its log and write your grade counts',
  '  "unused-gate-debug.json",'),

 ("a command carries the contract — '/clear' is typed with a paragraph after it and stops being a command",
  "src/inject.ts",
  '  if (!msg.trim() || msg.trimStart().startsWith("/")) return msg;',
  "  if (!msg.trim()) return msg;"),

 ("the contract is computed but never typed — it appears in no composer, only in the code",
  "src/inject.ts",
  '"--message", outgoing, "--submit",',
  '"--message", message, "--submit",'),

 ("the debug log claims a contract was attached whichever way it went — the record stops being evidence",
  "src/inject.ts",
  "        contract: outgoing.includes(REPORTING_CONTRACT),",
  "        contract: true,"),

 # §2(b) · the briefing's purpose line. Reverting it to the bare header is exactly the state the
 # owner complained about: figures handed to an orchestrator with nothing saying what they are for,
 # which is how they came to be recited upward in the first place.
 ("the briefing stops saying what its numbers are FOR — the reminder against drift is gone",
  "src/workledger.ts",
  "  return [`[loom-ledger] ${w.repo}, last ${w.windowDays} days — yours, for choosing the next ` +\n"
  "          `block; nothing here is a mark on you, and none of it is for repeating upward:`,",
  "  return [`[loom-ledger] ${w.repo}, last ${w.windowDays} days:`,"),
 # ── CX-001 · the extension never clears an orchestrator ───────────────────────────────────────
 # Owner, 2026-09-16: "Do not ever clear the orchestrator's context." The removal is in memory.ts
 # (no clear step is produced); the GUARANTEE is the refusal at the injector, which is what a future
 # caller inherits. Both are mutated below, because either alone would let the behaviour back.

 # THE WHOLE BLOCK, REVERTED IN ONE LINE: the chokepoint stops refusing and the clear is typed.
 # Killed by "CX-001: injectTo REFUSES a /clear at the orchestrator" (inject.test.js), which asserts
 # loom_cdp.py was never even spawned.
 ("the chokepoint stops refusing — a /clear aimed at an orchestrator is typed again",
  "src/inject.ts",
  # `&& Boolean(0)` rather than `false &&`: a literal false makes the branch unreachable, and
  # TypeScript does not narrow in unreachable code, so `refusal` read as `string | null` inside and
  # the mutant would be refused at pre-flight for not compiling. (Measured 2026-09-17, same shape as
  # the WL-012 finder mutant.) This keeps the branch typed and simply never taken.
  "  const refusal = refuseClear(target, message);\n  if (refusal) {",
  "  const refusal = refuseClear(target, message);\n  if (refusal && Boolean(0)) {"),

 # The refusal keyed on the message only, dropping the ROLE half — which is the half that keeps
 # playbook §12 alive. This mutant makes the extension refuse a WORKER's /clear too, silently
 # undoing a standing owner directive from 2026-09-08. Killed by "CX-001: a WORKER's /clear still
 # goes through, BYTE-IDENTICAL to before the guard".
 ("the refusal stops looking at WHO the target is — worker clearing (playbook §12) dies with it",
  "src/inject.ts",
  "  if (!isClearCommand(message)) return null;\n  if (!isOrchestratorTarget(role, taggedRole)) return null;",
  "  if (!isClearCommand(message)) return null;"),

 # The TAG half of "who is an orchestrator" removed. Names alone cannot catch a project whose
 # orchestrator is called something OWNER_ALIASES has never heard of — measured 2026-09-09,
 # livegita's is named `po` and its tag once read `{"role":"gitadeveloper"}`. Killed by "CX-001: the
 # refusal is by ROLE, so it holds for a tagged orchestrator with a worker-ish name".
 ("only owner-NAMED roles are protected — a tagged orchestrator with an ordinary name is cleared",
  "src/inject.ts",
  "  if (isOwnerRole(r)) return true;\n  return !!taggedRole && taggedRole === r;",
  "  return isOwnerRole(r);"),

 # …and the NAME half removed, which is the one that works on a bus with no tag at all — the state
 # every project starts in. Killed by the same suite's `isOrchestratorTarget("product-owner", null)`.
 ("an untagged bus protects nobody — the owner-named role is treated as a worker",
  "src/inject.ts",
  "  if (isOwnerRole(r)) return true;\n  return !!taggedRole && taggedRole === r;",
  "  return !!taggedRole && taggedRole === r;"),

 # The command test loses its anchor, so PROSE about clearing reads as a command. This is the mutant
 # that expresses the trap the block was warned about: health.ts's clearReminder says "clear
 # <role> and re-bind it" in a sentence, and a guard that matched it would stop the §12 reminder
 # reaching the orchestrator at all. Killed by "CX-001: what counts as a clear COMMAND".
 ("a slash anywhere in a sentence counts as a command — the §12 clear reminder is swallowed",
  "src/inject.ts",
  'return /^\\/clear\\b/i.test(String(message || "").trimStart());',
  'return /\\/clear\\b/i.test(String(message || ""));'),

 # THE PATH THAT GOES AROUND THE CHOKEPOINT. limits.ts calls loom_cdp.py directly and types a USER
 # SETTING (`loomSessionTracker.resumeMessage`), so without this guard the extension will type
 # whatever that setting holds — `/clear` included — at whatever role is being resumed. Killed by
 # "CX-001: a resume message set to /clear is refused when the target is an orchestrator".
 ("the resume path drops its guard — a user setting can type /clear at an orchestrator again",
  "src/limits.ts",
  "    const refusal = refuseClear({ role: ev.role, repo: ev.repo }, message);\n    if (refusal) { done?.(false, refusal); return; }",
  ""),

 # The decision half: a verified save goes back to producing a clear step, which is precisely the
 # threshold-triggered behaviour the owner asked to have removed. Killed by "CX-001: decide() never
 # returns a clear step, from ANY state it can be in" and by the §5.3 regression walk.
 ("a verified save produces a clear step again — the removed trigger, restored",
  "src/memory.ts",
  '      return {\n        kind: "none",\n        // WL-004 R2 · AN OBSERVATION FOR THE PANEL',
  '      return {\n        kind: "clear", message: "/clear",\n        // WL-004 R2 · AN OBSERVATION FOR THE PANEL'),

 # CX-001 R1 · the emptied-panel witness stops requiring a FALL. The phase it reads in now lasts
 # indefinitely rather than seconds, so a panel that merely reads small — a partial CDP read — is
 # taken for a clear and a restore prompt is injected into a session that is mid-work and was never
 # cleared. Killed by "CX-001 R1: an empty panel only witnesses a clear if the panel was FULL".
 ("a small panel is read as a cleared one — a working session is interrupted with a restore prompt",
  "src/memory.ts",
  "    const wasFull = state.bankedChars === undefined ||\n      (state.bankedChars !== null && state.bankedChars >= CLEARED_PANEL_CHARS);",
  "    const wasFull = true;"),


 # ── PB-001 · the delegation detector, the reach-back supply, and two false alarms ──────────────

 # (a) THE FIRST FALSE-POSITIVE EXCLUSION. A bus with no workers bound has nobody to delegate to,
 # and nudging a solo orchestrator is the noise that makes a reminder ignorable. Killed by
 # "delegation: A BUS WITH NO WORKERS BOUND NEVER FIRES, however long the orchestrator works".
 ("a solo orchestrator with no roles on its board is nudged to delegate",
  "src/delegation.ts",
  '  if (input.workers.length === 0) {',
  "  if (false) {"),

 # (b) THE SECOND, AND THE ONE THAT DECIDES WHETHER THE REMINDER IS BELIEVED. An orchestrator
 # waiting on running workers is obeying §8's concurrency cap; nudging it punishes correct
 # behaviour. Killed by "delegation: AN ORCHESTRATOR WAITING ON BUSY WORKERS IS NEVER NUDGED".
 ("an orchestrator waiting on three running workers is told it has not delegated",
  "src/delegation.ts",
  "  if (idle.length === 0) {",
  "  if (false) {"),

 # The suppression latch. Without it the reminder repeats every tick for as long as the stretch
 # runs, which is how a reminder becomes a thing people turn off — the stall alarm's own defect,
 # four alerts in one day. Killed by "delegation: reminded ONCE per undelegated stretch".
 ("the delegation reminder repeats every tick instead of once per undelegated stretch",
  "src/delegation.ts",
  "  if (st.reminded) {",
  "  if (false) {"),

 # DG-001, THE LIVE DEFECT ITSELF: make the latch express the WATERMARK rather than the delivery, so
 # that a delivered reminder records nothing on a bus which has never dispatched. That is what the
 # shipped code did by storing `since ?? null` — the same `null` that means "nothing has been
 # delivered" — so the suppression check could never hold and the reminder fired on every qualifying
 # tick for ever. Measured at livegita's orchestrator: busyTicks 133, since null, 33 minutes of
 # reminders, ending with the feature switched off for every bus. Note the mutant leaves a bus WITH a
 # watermark behaving correctly, exactly as the defect did — which is why it went unnoticed here.
 # Killed by "delegation: A BUS THAT HAS NEVER DISPATCHED IS REMINDED AT MOST ONCE — the DG-001 spam".
 ("the delegation latch is keyed on the watermark, so a null one can never suppress — DG-001",
  "src/delegation.ts",
  "  return { ...st, reminded: true, deliveredAt: new Date().toISOString() };",
  "  return { ...st, reminded: st.since !== null, deliveredAt: new Date().toISOString() };"),

 # The other half of the same shape, and the WRONG FIX for it: silence the spam by making a bus with
 # no watermark permanently unremindable. The stretch then never reports, and a first-ever dispatch
 # cannot re-arm what was never armed. Killed by "delegation: A BUS THAT HAS NEVER DISPATCHED IS
 # REMINDED AT MOST ONCE" (it never fires at all, so the first reminder goes missing).
 ("a never-dispatched bus is silenced instead of latched — the wrong fix for DG-001",
  "src/delegation.ts",
  "  if (st.reminded) {\n    return",
  "  if (st.reminded || st.since === null) {\n    return"),

 # DELIVERY IS WHAT LATCHES. Mark the latch from the state the TICK produced rather than from the
 # delivery callback's success, and a reminder refused because the composer was mid-turn silences the
 # stretch anyway — the asserted-is-not-reached shape that has cost this project six findings.
 # Killed by "delegation: ONLY DELIVERY LATCHES — a reminder refused by a busy composer is not one".
 ("a reminder that was never received latches the stretch anyway",
  "src/delegation.ts",
  "  const workedMinutes = Math.round",
  "  st.reminded = true;\n  const workedMinutes = Math.round"),

 # MIGRATION. Default the new flag to `true` for a file written before DG-001 instead of replaying
 # the old suppression condition, and every affected bus is silenced for its current stretch — the
 # 133-reminder bus included, which is the one that still has something to say. Killed by
 # "delegation: AN OLD STATE FILE MIGRATES WITHOUT A BURST AND WITHOUT A CRASH".
 ("an old state file loads as already-reminded, silencing the stretch it never reported",
  "src/delegation.ts",
  "        reminded: typeof st.reminded === \"boolean\" ? st.reminded : legacyLatched,",
  "        reminded: typeof st.reminded === \"boolean\" ? st.reminded : true,"),

 # The OTHER half of the migration, and the one a refutation pass found unasserted: replay only
 # "remindedAt is a string" and drop the equality, and a bus whose watermark MOVED after its reminder
 # migrates as latched — its legitimately due reminder swallowed for ever, silently, suite green.
 # A swallow is the quieter cousin of the spam and the wrong fix for it. Killed by "delegation: AN
 # OLD STATE FILE MIGRATES WITHOUT A BURST AND WITHOUT A CRASH".
 ("migration replays only HALF the old condition, latching a bus whose watermark had moved",
  "src/delegation.ts",
  "      const legacyLatched = typeof st.remindedAt === \"string\" && st.remindedAt === since;",
  "      const legacyLatched = typeof st.remindedAt === \"string\";"),

 # The re-arm. Keyed on the dispatch watermark so that ONLY delegating clears it; leave the latch
 # set and no dispatch can ever re-arm the reminder, so it fires exactly once in the life of a bus.
 # Killed by "delegation: ONLY A NEW DISPATCH RE-ARMS IT — and it resets the stretch too".
 ("a dispatch no longer re-arms the delegation reminder",
  "src/delegation.ts",
  "    st.busyTicks = 0;\n    st.reminded = false;",
  "    st.busyTicks = 0;"),

 # UNKNOWN IS NOT IDLE. A tick that could not see the orchestrator's frame must neither count work
 # nor reset the stretch; counting it credits work to a session that may have been closed. Killed
 # by "delegation: a frame not seen this tick is UNKNOWN — it neither counts nor resets".
 ("a frame that was not seen this tick is counted as working",
  "src/delegation.ts",
  "  if (input.busy === null) {",
  "  if (false) {"),

 # WALL-CLOCK, the signal delegation.ts rejects by name: an orchestrator whose human went to bed
 # would be reminded at breakfast for having done nothing. Killed by "delegation: IDLE TICKS ARE
 # NOT WORK — a quiet orchestrator never accumulates".
 # DG-001-R1 moved this anchor: the increment is no longer one line, because it is now gated on the
 # observation's instant as well as on busy-ness. The MUTANT is unchanged in meaning — every tick
 # counts, whether the orchestrator was working or not.
 ("idle ticks count as work — the rejected wall-clock signal, restored",
  "src/delegation.ts",
  "  if (input.busy) {\n    const at =",
  "  if (true) {\n    const at ="),

 # ── DG-001-R1 · THE PRODUCT'S "ONCE PER STRETCH", NOT THE FUNCTION'S ───────────────────────────
 # Every mutant below survives delegation.test.js's pure suites by construction: the pure function
 # is handed the same unlatched state each time and is RIGHT to return a finding each time. They are
 # here because that is the shape this repo keeps shipping — 22 green tests on a mechanism whose
 # product-level property nothing asserted — and each one names the suite in delegation-wiring.test.js
 # that drives the real activate() tick path and kills it.

 # THE FIRST LIVE REPEAT. loom_cdp.py runs for up to INJECT_TIMEOUT_MS — four ticks at the default
 # interval — and until it returns nothing is latched, so every one of those ticks re-read an
 # unlatched file, found the same due stretch and injected again. Up to four deliveries of one
 # reminder, and the same mechanism is what stops a SECOND WINDOW delivering its own. Killed by
 # "DG-001-R1 wiring: a reminder IN FLIGHT is delivered once, not once per tick" and by
 # "DG-001-R1 wiring: TWO windows on one project deliver one reminder between them".
 #
 # NOT `if (false) {`, WHICH IS THIS CORPUS'S USUAL SPELLING AND HERE WOULD NOT COMPILE. TypeScript
 # discards narrowing inside a statically unreachable block, so `repo` reverts to `string | null`
 # and `saveDelegation(repo, …)` fails to typecheck — a MUTANT THAT DOES NOT COMPILE IS SCORED AS A
 # KILL BY EVERY RUNNER, including this one, so the most important mutant in the block would have
 # been reported dead without a single test having looked at it. The guard is removed instead, with
 # the claim still TAKEN so that the release path is unchanged and only the suppression is gone.
 ("nothing marks the injection in flight, so every tick inside it reminds again",
  "src/extension.ts",
  """      if (!claimInjection(repo)) {
        saveDelegation(repo, r.state);
        debugLog({ delegation: { orchestrator: f.orchestrator, skipped: "a reminder is in flight" } });
        return;
      }""",
  "      claimInjection(repo);"),

 # THE WRONG FIX FOR IT, and the more expensive failure of the two: take the claim and never give it
 # back. Every suite about repeats stays green — the bus simply goes quiet for ever. Killed by
 # "DG-001-R1 wiring: a DISPATCH re-arms it, and the next stretch is reminded once".
 ("the injection claim is never released, so the bus is silenced after one reminder",
  "src/extension.ts",
  "        releaseInjection(repo);",
  "        void 0;"),

 # The same silence arriving by the other road: a claim that can never expire. A window killed
 # between taking it and releasing it then holds it for ever. Killed by "DG-001-R1 wiring: an
 # EXPIRED claim is taken over, so a crash mid-injection is not silence".
 ("a claim left by a dead window never expires, so nothing can ever remind this bus again",
  "src/delegation.ts",
  "  if (Number.isFinite(started) && now - started < timeoutMs) return false;",
  "  if (true) return false;"),

 # THE SECOND LIVE REPEAT, in the counter rather than the delivery, and the quieter half: every
 # worktree window of a project ticks one state file, so N windows advanced busyTicks N times a tick
 # and a threshold that says 30 minutes arrived in 30/N. Killed by "DG-001-R1 wiring: two windows
 # observing one orchestrator bank ONE busy tick, not two".
 ("every window banks its own look at the same orchestrator, so 30 minutes arrives in 30/N",
  "src/delegation.ts",
  "    const counted = at === null || stale || at - last >= tickMs;",
  "    const counted = true;"),

 # …AND THE SAME DEFECT ARRIVING FROM THE WIRING, which is the one that can be reintroduced by an
 # edit that never opens delegation.ts. `at` is optional and absent means "count every tick", so a
 # caller that stops supplying it degrades in SILENCE, with the pure suites green. That default is
 # deliberate and this mutant is what holds it. Killed by "DG-001-R1 wiring: two windows observing
 # one orchestrator bank ONE busy tick, not two".
 ("the tick stops supplying the observation's instant, so the counter multiplies by window again",
  "src/extension.ts",
  "          workers, lastDispatch: lastDispatchAt(repo), at: tickAt }, prev, mins, tickMs);",
  "          workers, lastDispatch: lastDispatchAt(repo) }, prev, mins, tickMs);"),

 # The tick LENGTH, from the same call. delegation.ts defaults to 15s; schedule() reads the interval
 # from settings and clamps it at a 5s floor. A window at the floor banks three ticks per 15 seconds,
 # so it is told it has worked half an hour after ten minutes — and the message states the minutes as
 # an observation, so it says so. Killed by "DG-001-R1 wiring: the threshold is measured in the
 # interval the window ACTUALLY ticks at".
 ("the threshold is measured in delegation.ts's default tick, not the one the window ticks at",
  "src/extension.ts",
  "          workers, lastDispatch: lastDispatchAt(repo), at: tickAt }, prev, mins, tickMs);",
  "          workers, lastDispatch: lastDispatchAt(repo), at: tickAt }, prev, mins);"),

 # THE RACE THE MARKER CANNOT CLOSE. Two windows tick one file: B reads the state, A delivers and
 # latches, B writes back the state it computed from its older read and `reminded` goes to false for
 # a stretch that WAS reminded. Decided entirely by which window lands second, and invisible to both.
 # This one is killed by a STATE-FILE test rather than by the wiring, because reproducing it through
 # activate() needs B's write to fall inside A's injection by milliseconds — which is a coin toss, and
 # a mutant killed by a coin toss is a mutant that is not killed. Killed by "DG-001-R1: a window that
 # ticked before the reminder landed cannot un-latch it".
 ("a window that lost the race writes the latch back off, and the next tick reminds again",
  "src/delegation.ts",
  "      if (cur && cur.reminded === true && !st.reminded && (cur.since ?? null) === st.since) {",
  "      if (false) {"),

 # An injection killed at its own timeout may already have typed, so retrying it is how ONE due
 # reminder becomes TWO delivered ones — the last route to a repeat, and the one the elapsed time is
 # read to close. Killed by "DG-001-R1 wiring: a DISPATCH re-arms it, and the next stretch is
 # reminded once" (nothing ever latches, so the second tick reminds again).
 ("a timed-out injection is always retried, so a reminder it already typed is delivered twice",
  "src/delegation.ts",
  '  return elapsedMs >= timeoutMs ? "latch" : "retry";',
  '  return "retry";'),

 # The over-correction: latch on anything that comes back, including a refusal that delivered
 # nothing. That is the swallow — a bus whose composer was busy at the one moment it was looked at
 # goes unreminded for the whole stretch — and it is the wake rule abandoned where it was still
 # cheap. Killed by "DG-001-R1 wiring: an injection REFUSED fast is not latched, and the next tick
 # tries again".
 ("a refused injection latches anyway, so a reminder nobody received counts as delivered",
  "src/delegation.ts",
  '  return elapsedMs >= timeoutMs ? "latch" : "retry";',
  '  return "latch";'),

 # THE REPEAT THAT SURVIVED THE FIRST VERSION OF DG-001-R1, and the reason the injector's own words
 # are read instead of a stopwatch. loom_cdp.py's fast `ok: False` is not one failure: "composer not
 # found" typed nothing, while "typed but NOT submitted … text still in composer (verified)" means
 # the whole reminder is already IN the composer and only the send button failed. Retry that and a
 # second copy is appended every fifteen seconds — the livegita symptom, reached by a route neither
 # the boolean nor the elapsed time can see. Killed by "DG-001-R1 wiring: text already sitting in
 # the composer is never typed a second time".
 ("the injector's note is ignored, so a reminder already in the composer is typed again",
  "src/delegation.ts",
  '  if (note && TYPED_BUT_UNSENT.test(note)) return "latch";',
  '  if (false) return "latch";'),

 # The claim and the injector do not start their clocks together: the claim is stamped, then a state
 # write and a composed message happen, and only then does execFile begin counting. Equal windows
 # therefore leave a gap that is small but ALWAYS there, in which a hung injector still holds the
 # composer while its claim has expired and a second window is free to inject. Killed by
 # "DG-001-R1: the injection claim is exclusive, expiring, and given back".
 ("the claim expires before the injector it covers, opening a window for a second one",
  "src/delegation.ts",
  "                               timeoutMs = INJECT_TIMEOUT_MS + CLAIM_GRACE_MS): boolean {",
  "                               timeoutMs = INJECT_TIMEOUT_MS): boolean {"),

 # A cadence mark in the FUTURE — a stepped clock, a resumed VM, an older build's write — read
 # literally holds the counter shut until wall clock catches up, and only a dispatch clears it. On a
 # bus that is failing to dispatch, which is the bus being measured, that is for ever: the permanent
 # silence arriving through the half of this block that was meant to be the cheap half. Killed by
 # "DG-001-R1: the busy counter advances once per tick of wall clock, not once per window".
 ("a cadence mark in the future freezes the counter until the clock catches up",
  "src/delegation.ts",
  "    const stale = !Number.isFinite(last) || (at !== null && last > at);",
  "    const stale = !Number.isFinite(last);"),

 # THE SWALLOW HIDING IN THE SUCCESS PATH. The reminder asks the orchestrator to dispatch; when it
 # does so WHILE loom_cdp.py is still typing, the stretch the reminder was about is over by the time
 # the callback runs. Recording the delivery against the new stretch latches a stretch nobody has
 # been reminded about, and it stays latched until the dispatch after that. Killed by "DG-001-R1
 # wiring: a dispatch DURING the injection does not latch the new stretch".
 ("a reminder delivered for the old stretch latches the new one, which is then never reminded",
  "src/extension.ts",
  "        if (verdict === \"latch\" && sameStretch) saveDelegation(repo, markReminded(cur));",
  "        if (verdict === \"latch\") saveDelegation(repo, markReminded(cur));"),

 # ── DG-001-R2 · the observer must not change what it measures ──────────────────────────────────

 # THE CLAIM BACK IN THE BUS ROOT. Two readers take the newest mtime of anything under loom/<repo>
 # as project activity — busTouched (digest.ts) and the separate copy of that walk in planBuses
 # (gc.ts), which is the one that offers to archive a dead bus. The permanent case is the damaging
 # one: a claim orphaned by a window that died mid-injection freezes a bus as freshly touched for
 # ever, so gc can never propose the very bus it was written for. Killed by BOTH
 # "delegation: taking a claim writes NOTHING into the bus root" and
 # "delegation: an ORPHANED claim does not keep a dead bus looking alive" — deliberately two, because
 # the first states the fact and the second states why anyone should care.
 ("the injection claim is written into the bus root, where two mtime walks read it as activity",
  "src/delegation.ts",
  '  return path.join(LOOM_ROOT, ".inflight", repo + ".lock");',
  '  return path.join(LOOM_ROOT, repo, "delegation-inflight.lock");'),

 # THE DIGEST READS AMBIENT STATE AGAIN. working-sessions.json is MACHINE-GLOBAL — not this bus, not
 # any bus — so a buildDigest that reaches for it answers partly about a repo and partly about the
 # host, with nothing in the signature to say so. That is what made three digest suites fail in
 # SERIAL mode only, each by exactly one actionable item, when a sibling suite drove the real
 # activate(). Killed by "digest: a published global working count does not reach a digest that was
 # not given it" — which, unlike those three, is red in every mode.
 ("the digest reads the machine-global working count instead of the one it was handed",
  "src/digest.ts",
  "    workingNow: input.workingNow,",
  '    workingNow: (() => { try { return JSON.parse(fs.readFileSync(path.join(LOOM_ROOT, "working-sessions.json"), "utf8")).total; } catch { return input.workingNow; } })(),'),

 # The reach-back supply stops checking whether one is already there, so every tick appends another
 # block and a worker's inbox grows without bound. Killed by "reachback: it never appends twice".
 ("a reach-back block is appended on every tick, forever",
  "src/reachback.ts",
  '  if (hasReachBack(text)) return { supplied: false, note: "already carries a reach-back" };',
  "  if (false) return { supplied: false, note: \"already carries a reach-back\" };"),

 # THE ID RE-CHECK. §12 step 2 has the orchestrator overwrite inbox.md as its first move after
 # banking, and a tick can land inside that window: the block would then name the PREVIOUS block's
 # `# RESPONSE` heading, which no watcher greps for. Killed by "reachback: THE ID IS RE-CHECKED".
 ("a reach-back block is appended to a brief that has already been replaced",
  "src/reachback.ts",
  '  if (String(frontmatter(text)["id"] || "") !== expectId) {',
  "  if (false) {"),

 # An untagged bus gets an invented return address instead of nothing — the fingerprint route §13
 # bans, which sent two funisland rings into another project's tab. Killed by "reachback: an
 # untagged bus gets nothing — an invented return address is worse than none".
 # (Anchored on the RESOLUTION rather than on the null guard: deleting the guard does not compile,
 # because the narrowing it performs is load-bearing two lines down. This is the truer defect anyway
 # — it is the fingerprint-style GUESS §13 bans, rather than a missing check.)
 ("an untagged bus has a return address invented for it by guessing the usual role name",
  "src/reachback.ts",
  "  const tag = senderRole ? { role: senderRole } : getOrchestrator(repo);",
  '  const tag = senderRole ? { role: senderRole } : (getOrchestrator(repo) || { role: "productowner" });'),

 # PB-001 · the respawn false alarm, restored: the identity check is inverted, so agreement reads as
 # a transition and disagreement reads as settled — every correct respawn is reported as a §12
 # violation. Killed by "health: a respawned worker is NOT reported as an unclear session (PB-001)".
 ("a respawned worker is reported as a session that was never cleared",
  "src/health.ts",
  "  if (boardSid === statusSid) return { agree: true, note: null };",
  "  if (boardSid !== statusSid) return { agree: true, note: null };"),

 # …and the other half: the disagreement is computed and then never consulted, so the snapshot is
 # judged exactly as it was before the fix. Killed by the same test.
 ("the identity disagreement is computed and then ignored",
  "src/health.ts",
  "               : !agree.agree ? agree.note\n",
  ""),

 # PB-001 · the orchestrator is stall-alerted about itself again, and told to ring itself — the one
 # action that cannot help. Its status.json is a worker's heartbeat, which an orchestrator is not
 # required to maintain. Killed by "health: THE ORCHESTRATOR IS NEVER STALL-ALERTED ABOUT ITSELF".
 ("the orchestrator is alerted that it has stalled, and told to ring itself",
  "src/health.ts",
  " && !isTaggedOrchestrator(repo, role)) {",
  ") {"),

 # ── WC-001 · §17, the watcher detector. Each of these is a false positive the measurement over
 # 3,965 transcripts actually found; deleting the guard is what these mutants do. ────────────────

 # (2) A SUBAGENT'S WATCHER. 84 of the Monitor calls on this machine are sidechain records, and §4
 # tells every role to fan out. Counting them reports a role for doing what it was told to do.
 # Killed by "watchers: A SUBAGENT'S WATCHER IS NEVER THE ORCHESTRATOR'S".
 ("a subagent's Monitor is reported as the orchestrator's own watcher",
  "src/watchers.ts",
  "  if (rec.isSidechain) return null;\n  const content = rec.message && rec.message.content;\n  if (!Array.isArray(content)) return null;",
  "  if (false) return null;\n  const content = rec.message && rec.message.content;\n  if (!Array.isArray(content)) return null;"),

 # (6) ONLY THE SESSION'S OWN ACTS. A human typing into an orchestrator tab is a `user` record;
 # reporting it tells the session it did something a person did. Killed by "watchers: A WATCHER THE
 # HUMAN TYPED IS NOT REPORTED TO THE SESSION".
 # RE-ANCHORED 2026-09-17 (NT-001-R2): `assistantText` now carries the identical line, so the bare
 # spelling matched TWICE and this mutant reported STALE — it graded nothing, silently. The preceding
 # comment is unique to `classifyCall` and re-anchors it to the arming detector it belongs to.
 ("a record that is not the assistant's own act is counted as an arming",
  "src/watchers.ts",
  '  // (6) Only the SESSION\'s own acts. A human typing into the tab is a `user` record.\n  if (rec.type !== "assistant") return null;',
  "  if (false) return null;"),

 # (4) THE ONE THAT WOULD HAVE SUNK THE DETECTOR. 787 background loops in orchestrator dirs are
 # `until grep … lane.log; do sleep 3; done` — waiting on a GATE, not polling the BUS. Drop the bus
 # path and every one of them is a §17 violation. Killed by "watchers: A BOUNDED WAIT ON A BUILD
 # LOG IS NOT A BUS POLL".
 ("a background wait on a build log is reported as polling the bus",
  "src/watchers.ts",
  '      if (LOOP_SHAPE.test(cmd) && BUS_PATH.test(cmd)) return { kind: "loom-poll", at };',
  '      if (LOOP_SHAPE.test(cmd)) return { kind: "loom-poll", at };'),

 # (3) BACKGROUND IS NOT A WATCHER. 1,873 one-shot background calls in orchestrator dirs are builds
 # and deploys. Killed by "watchers: BACKGROUND IS NOT A WATCHER — ONLY A LOOP IS".
 ("a one-shot background build is reported as a watcher",
  "src/watchers.ts",
  '      if (LOOP_SHAPE.test(cmd) && BUS_PATH.test(cmd)) return { kind: "loom-poll", at };',
  '      if (BUS_PATH.test(cmd)) return { kind: "loom-poll", at };'),

 # (5) HISTORY. The transcript holds the whole life of the session. Without the baseline, the first
 # tick reports a watcher armed last Tuesday as if it were happening now — and every restart of the
 # extension re-reports it. Killed by "watchers: THE FIRST SIGHT OF A SESSION COUNTS NOTHING".
 ("a watcher armed before the detector ever ran is reported as new",
  "src/watchers.ts",
  "    st.offset = size;",
  "    st.offset = 0;"),

 # (7) PB-001's IDENTITY RULE, which is the whole reason this detector is allowed to read a
 # transcript at all. Without it a stale session id reads a DEAD session's records as today's —
 # the exact defect PB-001 shipped the fix for. Killed by "watchers: IDENTITY RECORDS THAT DISAGREE
 # COUNT NOTHING AND RE-BASELINE NOTHING".
 ("a session transition in flight is read anyway, on whichever id happens to be there",
  "src/watchers.ts",
  "  if (!input.sessionId) {",
  "  if (false) {"),

 # The suppression latch — without it the line repeats for every watcher armed in the stretch, which
 # is how a reminder becomes one people turn off. Killed by "watchers: reminded ONCE per stretch".
 ("the watcher reminder repeats for every arming instead of once per stretch",
  "src/watchers.ts",
  "  if (st.remindedAt !== null && st.remindedSession === input.sessionId) {",
  "  if (false) {"),

 # A RECORD STILL BEING WRITTEN. Consuming the partial tail means the record is never classified —
 # a watcher armed in the last line before a tick is lost forever. Killed by "watchers: only
 # APPENDED bytes are read, and a half-written record is not consumed".
 ("a half-written record is consumed, so the arming in it is never seen",
  "src/watchers.ts",
  '  const consumed = size - Buffer.byteLength(tail, "utf8");',
  "  const consumed = size;"),

 # THE CLAIM THE TOOL CANNOT MAKE. Liveness is not readable — measured: ZERO watcher-shaped calls on
 # any board session lacked a tool_result, and a background Bash returns its shell id immediately
 # while the loop runs on. A line asserting a running watcher is wrong a fraction of the time with no
 # way to tell which fraction. Killed by "watchers: THE MESSAGE NEVER CLAIMS THE WATCHER IS RUNNING".
 ("the reminder asserts a LIVE watcher, which is not readable from a transcript",
  "src/watchers.ts",
  "  return `[loom-watch] This session armed ${what} since the last check.${seen}${many} It may already ` +",
  "  return `[loom-watch] This session armed ${what} and it is running now.${seen}${many} It may already ` +"),


 # ── CL-002, 2026-09-17: a FIRST handoff is not a §12 violation ──────────────────────────────────
 #
 # §12 is violated by a SECOND block in one session. The detector reported "at least 1", which is not
 # a violation of anything, and it did so at the dispatch that had cleared and re-bound the role
 # seconds earlier — the reminder arriving for having got it RIGHT. Fourth false alarm from this one
 # detector in two days, and it came out of the THIRD fix: dropping the old session's ids from the
 # baseline empties it by construction, and the first block then lands on an empty baseline.

 # Killed by "CL-002 scanClears: a session's FIRST block raises nothing — one id is not a second one"
 # and, through the wiring, by "CL-002 on the real tick: the §12 dispatch is silent". Without the
 # threshold the detector fires on every correctly-dispatched fresh session: the state the §12 flow
 # produces BY CONSTRUCTION, so the reminder becomes one nobody can believe.
 ("the second-block requirement is dropped — one handoff in one session is reported as a violation",
  "src/health.ts",
  "      if (known.length + arrived.length < 2) continue;",
  "      if (known.length + arrived.length < 1) continue;"),

 # The same claim from the other side, and the one that fails SILENTLY. Killed by "CL-002 scanClears:
 # a SECOND block still fires, floor 2, naming both" — a threshold set one too high reports nothing
 # until the THIRD block, and every test of the message still passes while the detector goes deaf.
 ("the threshold is one too high — a genuine second block is not reported until a third arrives",
  "src/health.ts",
  "      if (known.length + arrived.length < 2) continue;",
  "      if (known.length + arrived.length < 3) continue;"),

 # THE PLACEMENT, NOT THE VALUE. Killed by "CL-002 scanClears: the suppressed first block is
 # REMEMBERED across a later /clear". Suppressing the arrival before `seen` is written is the same
 # silence for the same tick and loses the record: the unreported id is then in neither `ids` nor
 # `reported` nor `seen`, so the next `/clear` seeds it into the NEW session's baseline and a later
 # reminder names a block from the session that was just cleared — the undelivered-arrival defect,
 # re-introduced by the fix for a different one.
 ("the guard moves ABOVE the `seen` record — silence becomes amnesia and the id crosses the next clear",
  "src/health.ts",
  "      if (arrived.length) {\n        cl[snap.role] = { ...prev, seen: [...new Set([...(prev.seen || []), ...arrived])] };\n      }",
  "      if (arrived.length && known.length + arrived.length >= 2) {\n        cl[snap.role] = { ...prev, seen: [...new Set([...(prev.seen || []), ...arrived])] };\n      }"),

 # Killed by "CL-002 on the real tick: the §12 dispatch is silent, and the block AFTER it is not"
 # (its `NT-000` assertion) and by "CL-002 scanClears: a session's FIRST block raises nothing". The
 # baseline subtracted the old session's ids without REMEMBERING them, so they sat in `last_handled`
 # belonging to no list and read as fresh arrivals on the very next tick — counted and named against
 # the new session. Measured, not reasoned: the §12 sequence produced `blocks: 2, ids: ["B-2","B-1"]`
 # where B-1 belonged to the session that had just been cleared.
 ("what the baseline drops is not remembered — the cleared session's id returns as an arrival",
  "src/health.ts",
  "                          since: new Date(now).toISOString(), reported: [], seen: [], dropped };",
  "                          since: new Date(now).toISOString(), reported: [], seen: [], dropped: [] };"),

 # The consumer half of the same claim. Killed by the same two. Recording `dropped` and then not
 # consulting it when arrivals are computed is the identical defect one line away, and it is the
 # shape a later reader is most likely to "simplify" back in.
 ("`dropped` is recorded but never consulted — the inherited id is an arrival again",
  "src/health.ts",
  "      const arrived = snap.ids.filter((i) => !known.includes(i) && !(prev.dropped || []).includes(i));",
  "      const arrived = snap.ids.filter((i) => !known.includes(i));"),

 # THE FLOOR IS NOT A TOTAL, AND THE GUARD MUST NOT MAKE IT ONE. Killed by "CL-002 scanClears: a
 # session first sighted HOLDING one block still fires on the next". A first sighting cannot know what
 # a session carried before it, which is why the message says "at least"; counting only the ids that
 # ARRIVED would make a role the extension started watching mid-block need two further blocks before
 # it said anything, and an extension reload would silently reset every role's count.
 ("the floor counts only arrivals — a session first sighted already holding a block starts from zero",
  "src/health.ts",
  "      if (known.length + arrived.length < 2) continue;",
  "      if (arrived.length < 2) continue;"),

 # ── DU-001 · §19 · two live blocks on one file ────────────────────────────────────────────────
 #
 # THE FIRST TWO ARE WIRING MUTANTS AND THEY ARE THE POINT. Every claim in duties.test.js is about a
 # pure function and all of them stay green if nothing ever calls the detector. Verified by hand on
 # 2026-09-17: deleting the tick call left duties.test.js at 22/22 and was caught ONLY by
 # duties-wiring.test.js, which drives the real activate().
 #
 # AND A WARNING ABOUT HOW THAT WAS VERIFIED, because it nearly produced a false pass. The first
 # attempt reported the mutant CAUGHT-BY-NOTHING (all three wiring tests green) — because the
 # verification chain was `grep -c … && tsc …`, and `grep -c` exits NON-ZERO when the count is 0, so
 # the `&&` short-circuited and tsc never ran. The suite graded the previous build. A mutant run that
 # does not prove it recompiled is not evidence; check the emit, not the exit code of the line before.

 ("THE DETECTOR IS NEVER CALLED — the tick no longer runs it, and every unit test stays green",
  "src/extension.ts",
  "        try { runDuties(); } catch { /* a reminder must never break a tick */ }",
  "        try { if (false) runDuties(); } catch { /* a reminder must never break a tick */ }"),

 ("the finding is never DELIVERED — it is computed, logged, and dropped before the composer",
  "src/extension.ts",
  "      injectTo({ role: tag.role, webviewId: tag.webviewId ? tag.webviewId : null, repo },\n               overlapReminder(f), \"overlap-debug.json\", (ok, note) => {",
  "      injectTo({ role: tag.role, webviewId: tag.webviewId ? tag.webviewId : null, repo },\n               \"\", \"overlap-debug.json\", (ok, note) => {"),

 # IDLE ROLES ARE THE LOUDEST FALSE POSITIVE AVAILABLE. A finished worker's worktree still holds its
 # whole block until the orchestrator merges it, so dropping this filter reports every pair of BANKED
 # blocks as a live collision — on this repo that is most pairs, most of the time.
 ("an idle role counts as a live block — every pair of banked, unmerged blocks reports as a collision",
  "src/extension.ts",
  "        .filter((r) => isWorkingLike(readRoleStatus(repo, r).status));",
  "        .filter((r) => true);"),

 # THE LATCH. delegation.ts is the precedent and the stall alarm is the anti-precedent: a latch that
 # re-arms whenever its condition clears re-fires every time the condition flickers, which is how the
 # stall alarm produced four wrong alarms in two days. At a 15-second tick, two roles on one file for
 # an hour is 240 messages instead of one.
 ("the latch is dropped — the same collision is reported again on every tick, 240 times an hour",
  "src/duties.ts",
  "    if (st.reported[pairKey(c)] === blockKey(c)) continue;",
  "    if (false) continue;"),

 # …and the other direction: a latch keyed on the PAIR alone never re-arms, so a genuinely new pair
 # of blocks on the same file is silently swallowed for the life of the bus.
 ("the latch never re-arms — a new block on the same pair of roles is never reported",
  "src/duties.ts",
  "function blockKey(c: Collision): string {\n  return `${c.handoffs[0] ?? \"?\"}|${c.handoffs[1] ?? \"?\"}`;",
  "function blockKey(c: Collision): string {\n  return \"same\";"),

 # THE MANIFEST EXCLUSION, both ways. Without it the detector fires on package.json on every pair of
 # live blocks forever — a true collision the orchestrator already solves by assigning each block its
 # own version, and therefore pure noise.
 ("package.json is no longer excluded — every pair of live blocks reports the version bump",
  "src/duties.ts",
  "  for (const re of SERIALISED_BY_PROCESS) if (re.test(f)) return false;",
  "  for (const re of SERIALISED_BY_PROCESS) if (false) return false;"),

 # …and the exclusion must not be allowed to swallow the real finding sitting beside it.
 ("a pair sharing the manifest is dropped WHOLESALE — the real collision beside it goes unreported",
  "src/duties.ts",
  "      const shared = a.files.filter((f) => isCollidable(f) && bFiles.has(f));",
  "      const shared = a.files.every((f) => isCollidable(f)) ? a.files.filter((f) => bFiles.has(f)) : [];"),

 # BOTH HALVES OF A ROLE'S WORK. Measured on this bus 2026-09-17: the other live role had ZERO
 # committed files and its entire block sat uncommitted, so a branch-diff-only detector is blind to
 # the commonest state a worker is in.
 ("uncommitted work stops counting — a worker that has not committed yet is invisible",
  "src/duties.ts",
  "  for (const p of parsePorcelain(git(worktree, [\"status\", \"--porcelain\"]))) files.add(p);",
  "  for (const p of []) files.add(p);"),

 ("committed work stops counting — a worker that committed but was not merged is invisible",
  "src/duties.ts",
  "  for (const f of String(git(worktree, [\"diff\", \"--name-only\", `${base}...HEAD`]) || \"\").split(\"\\n\")) {",
  "  for (const f of String(\"\").split(\"\\n\")) {"),

 # THE THREE-DOT FORM. With two dots the diff also carries everything the orchestrator banked from
 # the OTHER worker since this branch forked, so one worker's merged block reads as the other's live
 # work — a collision between a role and its own colleague's already-merged code.
 ("the branch diff uses two dots — another worker's merged block reads as this one's live work",
  "src/duties.ts",
  "`${base}...HEAD`",
  "`${base}..HEAD`"),

 # A ROLE NEVER COLLIDES WITH ITSELF. A stale board entry beside a live one would otherwise be a
 # permanent, unfixable self-collision on every file that role touches.
 ("a role collides with itself — a duplicated board entry reports a permanent false collision",
  "src/duties.ts",
  "      if (a.role === b.role) continue;",
  "      if (false) continue;"),
 # ── OV-001 · the overlap guard, which REFUSES rather than reminds ─────────────────────────────
 # The direction of failure is inverted here. Every other detector above warns, so its mutants are
 # about a warning that stops arriving; these are about a DISPATCH that stops happening, or about a
 # guard that silently goes back to refusing nothing at all — which is what it had been doing on this
 # bus since CH-001 shipped, with every unit test green.

 # THE DEFECT OV-001 EXISTS TO FIX. `declaredFiles` read `files:` as one line; this bus writes an
 # indented list; so `handoffFiles` was [] for every role and the guard had NEVER refused anything
 # here. Killed by "OV-001: THE GUARD NOW ACTUALLY REFUSES on the spelling this bus writes" and by
 # C-10 in handoff-model.test.js, whose assertion this block deliberately reversed.
 ("the list form is not read — the guard silently returns to refusing nothing on this bus",
  "src/models.ts",
  'if (!raw) raw = listUnderKey(text, "files");',
  'if (false) raw = listUnderKey(text, "files");'),

 # The list must END at the first line that is not an `- item`, or it annexes whatever follows it —
 # the next key, or a second group after a blank line. Killed by "OV-001: collection STOPS at the
 # first non-item line", whose O-12 puts a blank line between two groups.
 ("the list never ends — collection runs past the first non-item line and annexes what follows",
  "src/models.ts",
  "if (!it) break;",
  "if (!it) continue;"),

 # Only the FRONTMATTER block is searched. ReciEats writes `files:` lines in a brief's prose, and
 # CH-001 already pinned that a body `files:` is not a declaration; reading the whole document would
 # turn a paragraph into a refusal. Killed by "an indented CONTINUATION under another key is not a
 # list" (its O-65 case: frontmatter present, list in the body).
 ("the list is searched for in the whole document — prose in the body becomes a declaration",
  "src/models.ts",
  "const lines = m[1].split(/\\r?\\n/);",
  'const lines = String(text || "").split(/\\r?\\n/);'),

 # THE MUTANT §6 NAMES: a guard that refuses on DOUBT. An undeclared handoff is one we cannot judge,
 # not one that touches nothing, and refusing on the silence makes the `files:` line compulsory by
 # stealth — measured, most buses on this machine do not write one. This is the failure that stalls a
 # bus. Killed by both "OV-001 §3: ABSENCE never refuses" and "§3: DOUBT never refuses".
 ("the guard refuses when NOTHING was declared — every bus without a `files:` line stalls",
  "src/overlap.ts",
  "export function overlapFor(repo: string | null, role: string, alsoLive: string[] = []): Overlap | null {\n"
  "  if (!repo || !role) return null;\n  const mine = handoffFiles(repo, role);\n  if (!mine.length) return null;",
  "export function overlapFor(repo: string | null, role: string, alsoLive: string[] = []): Overlap | null {\n"
  '  if (!repo || !role) return null;\n  const mine = handoffFiles(repo, role);\n  if (!mine.length) return { role, other: "?", file: "?" };'),

 # The exemption is LITERAL on the declared path. Run it through `pathsCollide` instead and a glob
 # exempts itself — `*` matches `package.json`, so `files: *`, a claim on every file, would be
 # dropped entirely and refuse nothing. Killed by "a WILDCARD is never exempted away".
 ("the exemption expands wildcards — a `files: *` claim on everything exempts ITSELF",
  "src/overlap.ts",
  "export function isMechanicalMerge(p: string | null | undefined): boolean {",
  "export function isMechanicalMerge(p: string | null | undefined): boolean {\n"
  "  return MECHANICAL_MERGE.some((n) => pathsCollide(p, n));"),

 # Both declarations are shrunk, not just the one being judged. Exempt only `mine` and a glob on this
 # side is still refused by a registry-only block on the other — a false refusal, the expensive
 # direction. Killed by "a WILDCARD is never exempted away" (its `test/*` vs `test/mutation.py` pair).
 ("the exemption is applied to one side only — the other side's version bump still refuses",
  "src/overlap.ts",
  "return firstShared(mine.filter((f) => !isMechanicalMerge(f)), theirs.filter((f) => !isMechanicalMerge(f)));",
  "return firstShared(mine.filter((f) => !isMechanicalMerge(f)), theirs);"),

 # ── OV-001-R1 · what is not a path, the list of docs, and the end of the silence ───────────────
 # Added by OV-001-R1 and NOT executed as a gate under it (the orchestrator owns the repo-wide runs,
 # §23). Each was verified one at a time instead: the `find` string is unique in its file, the mutant
 # COMPILES, and a named targeted suite that passed before it FAILS with it.

 # THE MUTANT THE BRIEF NAMED: the sentinel swallows a real path. The whole narrowing rests on the
 # test being on the WHOLE token; make it a substring test and `src/none-handler.ts` — and, via `-`,
 # most hyphenated filenames in the repo — silently declare nothing, so the guard stops protecting
 # the files it was handed. This is the expensive direction INVERTED: not a false refusal but a file
 # two roles now edit unguarded. Killed by "OV-001-R1: the OTHER direction — a real path that merely
 # CONTAINS one of these still refuses" — and by NOTHING ELSE, which is the point of spelling it on
 # `none` alone: the same mutant written over the whole sentinel set matches `-` as a substring, wipes
 # out every hyphenated path in the repo, and is killed by seventeen suites at once, proving only that
 # the guard still works at all rather than that THIS assertion holds.
 ("the sentinel is matched as a SUBSTRING — `src/none-handler.ts` declares nothing and goes unguarded",
  "src/models.ts",
  "if (PATH_SENTINELS.has(s.toLowerCase())) return \"\";",
  "if (s.toLowerCase().includes(\"none\")) return \"\";"),

 # The same defect on the annotation half: unanchor the bracket test and any path with a parenthesis
 # inside it — `docs/(draft)-spec.md` — becomes an annotation and disappears. Killed by the same
 # suite, whose T-4 declares exactly that path.
 ("the annotation test is not anchored — a path with a bracket INSIDE it disappears",
  "src/models.ts",
  "if (/^\\([^()/.]*\\)$/.test(s)) return \"\";",
  "if (/\\([^()/.]*\\)/.test(s)) return \"\";"),

 # And the narrowing removed altogether: this is the LIVE tfg_ua failure restored — two standby roles
 # refusing each other over the word `none`, and two annotated handoffs refusing each other on a
 # parenthetical. Killed by "the two LIVE tfg_ua declarations that were refusing on a non-path".
 ("a sentinel is a filename again — two standby roles refuse each other over the word `none`",
  "src/models.ts",
  "const PATH_SENTINELS = new Set([\"none\", \"n/a\", \"-\"]);",
  "const PATH_SENTINELS = new Set<string>([]);"),

 # RE-ANCHORED BY OV-001-R2: the list is three files now, not four, so the old `find` named a line
 # that no longer exists and the mutant would have been reported as a STALE ANCHOR — graded nothing.
 # The list of three goes back to two, and a pair sharing only a HANDOVER append is refused again.
 # This is the cheap failure, not the dangerous one — but it is the one R1 was asked for.
 # Killed by "the exemption names THREE files" and by "two blocks that share only a HANDOVER append".
 ("the handover is not exempt — an append to HANDOVER.md refuses a dispatch again",
  "src/overlap.ts",
  'const MECHANICAL_MERGE = ["package.json", "test/mutation.py", "HANDOVER.md"];',
  'const MECHANICAL_MERGE = ["package.json", "test/mutation.py"];'),

 # THE SILENCE RETURNS, at the source: a suppressed collision reports nothing, which is exactly the
 # defect class OV-001-R1 §1(3) was raised about — a value computed and then never rendered. Killed
 # by "exemptedShare names the file the guard let through".
 ("the exemption goes quiet again — a collision it suppressed is reported nowhere",
  "src/overlap.ts",
  "  if (sharedFile(mine, theirs)) return null;         // it refuses on its own merits; nothing was let through",
  "  return null;"),

 # ...and the note names the WRONG side. `mine: ["*"]` against a version bump is suppressed by the
 # OTHER side's manifest, so reporting mine's spelling would print `*` — a claim, not the file that is
 # now unguarded, and useless to anyone reading it. Killed by the same suite's wildcard case.
 ("the exemption note names the claim instead of the file it let through",
  "src/overlap.ts",
  "    return isMechanicalMerge(m) ? normalizeDeclaredPath(m) : normalizeDeclaredPath(t);",
  "    return normalizeDeclaredPath(m);"),

 # The judgement is made and then dropped at the CALL SITE, which is where this defect class actually
 # lives: overlap.ts computes the note correctly and the spawn result never carries it, so the
 # orchestrator reads an ordinary open and cannot tell a judgement was made for it. Killed by
 # "requests: an overlapping role is REFUSED, and one waved through by the exemption is REPORTED".
 ("the spawn result drops the exemption note — the guard judges and the orchestrator never hears",
  "src/requests.ts",
  "  return { open, spawn, stranded, refused, exempted, consumed: true };",
  "  return { open, spawn, stranded, refused, exempted: [], consumed: true };"),

 # THE SILENT ONE, and the only narrowing that can lose a guard with NOTHING said anywhere. Unanchor
 # the inside of the bracket and a REAL path someone bracketed — `(src/shared.ts)` — is deleted, so
 # the declaration becomes an absence: nothing refuses, and the exemption note does not fire either,
 # because nothing was exempted. Two roles edit the file with no refusal and no note. A refutation
 # pass found this in the shipped draft. Killed by "OV-001-R1: the OTHER direction — a real path that
 # merely CONTAINS one of these still refuses" (its T-8 case).
 ("a bracketed REAL path is deleted — the declaration becomes an absence and nothing is said at all",
  "src/models.ts",
  "if (/^\\([^()/.]*\\)$/.test(s)) return \"\";",
  "if (/^\\(.*\\)$/.test(s)) return \"\";"),

 # The warning tick dedupes per colliding PAIR. Share one key between the refusal and the exemption
 # note and a pair waved through at 14:02 has its GENUINE collision at 14:40 swallowed for the life of
 # the window — the cheap note eating the expensive warning, which is §1(3)'s failure reintroduced by
 # the fix for it. Inboxes are rewritten while a pair is live; that is how every block starts. Killed
 # by "OV-001-R1: a pair WAVED THROUGH is noted, and a later real collision still warns".
 ("the exemption note shares the refusal's dedupe key — a waived pair can never warn again",
  "src/extension.ts",
  'const key = [role, other].sort().join("|") + (ov ? "|refused" : "|waived");',
  'const key = [role, other].sort().join("|");'),

 # ── OV-001-R2 · the README reversal and the spaced annotation ──────────────────────────────────
 # Added by OV-001-R2 and NOT executed as a gate under it (§23 — the orchestrator owns the repo-wide
 # runs). Each was verified one at a time on a THROWAWAY COPY of the tree: the `find` string is unique
 # in its file, the mutant COMPILES, and a NAMED targeted suite that passed before it FAILS with it.

 # THE REVERSED INSTRUCTION, RESTORED — the mutant that matters most on this block, because the defect
 # it reintroduces was SHIPPED for a day and was not a coding mistake at all: it was a policy the
 # measurement had already refuted. `README.md` back on the list and the guard goes quiet on the file
 # that IS the product on hackomics, where `files: public/index.html, public/styles.css, README.md` is
 # live. Two roles are then dispatched onto a landing page in parallel — not silently, the waiver note
 # names it, but a note is all they get. Killed by "OV-001-R2: `README.md` is NOT exempt" — and by no
 # OTHER test file (verified: handoff-model.test.js and extension.test.js stay green), which is why the
 # suite asserts the hackomics declaration verbatim rather than a convenient pair: the test has to fail
 # for the reason the reversal happened. That suite is NOT a single-fact probe, though, and a refutation
 # pass was right to say so: it also asserts the reversal is exactly one file wide, so the handover
 # mutant below fails it too. The README assertions are the ones that fail for THIS mutant.
 ("`README.md` is exempt again — the guard goes quiet on another bus's PRODUCT",
  "src/overlap.ts",
  'const MECHANICAL_MERGE = ["package.json", "test/mutation.py", "HANDOVER.md"];',
  'const MECHANICAL_MERGE = ["package.json", "test/mutation.py", "HANDOVER.md", "README.md"];'),

 # The spaced-annotation pre-pass removed altogether: R1's pinned limit restored, and it is the
 # EXPENSIVE direction — `files: src/a.ts (new file)` declares `(new` as a path, so two handoffs
 # annotating that way refuse each other over a fragment and a dispatch stalls (§3). Killed by
 # "OV-001-R2: a SPACED annotation is dropped".
 ("a SPACED annotation is two paths again — two handoffs refuse each other on `(new`",
  "src/models.ts",
  "  for (const piece of stripSpacedAnnotations(raw).split(/[,\\s]+/)) {",
  "  for (const piece of raw.split(/[,\\s]+/)) {"),

 # THE DANGEROUS HALF OF THE SAME FIX, and the reason the pre-pass insists the bracket OPEN and CLOSE a
 # token. Drop both boundaries and the strip fires anywhere: a real path carrying a bracketed fragment
 # — `src/a (b).ts` — loses it, and `src/a.ts(NEW)` loses its tail, so declarations are re-spelled into
 # paths nobody wrote. That is the silent direction: the guard compares files that were never declared.
 # Killed by "OV-001-R2: the annotation pre-pass can only REMOVE tokens".
 ("the pre-pass strips brackets ANYWHERE — a real path is re-spelled into one nobody declared",
  "src/models.ts",
  "const SPACED_ANNOTATION = /(^|[,\\s])\\([^()/.,*]*\\)(?=[,\\s]|$)/g;",
  "const SPACED_ANNOTATION = /()\\([^()/.,*]*\\)/g;"),

 # And the inner predicate widened, which is the same silent loss R1's refutation pass found on the
 # space-free half, now reachable through the pre-pass: allow a slash or a dot inside the brackets and
 # a bracketed REAL path `(src/shared.ts)` is stripped, so the declaration becomes an absence — nothing
 # refuses, and no waiver note fires either, because nothing was exempted. Killed by the same suite's
 # T-28 case.
 ("the pre-pass accepts a slash inside the brackets — a bracketed real path becomes an absence",
  "src/models.ts",
  "const SPACED_ANNOTATION = /(^|[,\\s])\\([^()/.,*]*\\)(?=[,\\s]|$)/g;",
  "const SPACED_ANNOTATION = /(^|[,\\s])\\([^()]*\\)(?=[,\\s]|$)/g;"),

 # ── the two defects a REFUTATION PASS found in R2's own first draft ─────────────────────────────
 # Both were shipped in the draft that went to this refutation pass, and both are the SILENT direction:
 # a real declared path deleted before the guard ever compares it, so nothing refuses and no waiver
 # note fires either. They are mutants rather than just fixes because the fix is two characters wide in
 # one case and a single character of a `join()` in the other — the cheapest kind of thing to lose.

 # THE LIST-ITEM CROSSING. `listUnderKey` joins items so `declaredFiles` has one splitting loop; join
 # them with a SPACE and one item's `(` reaches another item's `)`, taking every item between them.
 # `Makefile`, `LICENSE` and `Dockerfile` are dot-free and slash-free, i.e. exactly annotation-shaped,
 # so this deletes REAL declared files. Killed by "OV-001-R2: a bracket run cannot cross a LIST ITEM".
 ("list items are joined by a space again — one item's brackets eat the items between them",
  "src/models.ts",
  '  return items.join(",");',
  '  return items.join(" ");'),

 # THE WILDCARD, ONE LEVEL UP FROM WHERE overlap.ts PROMISES IT. `overlap.ts` states a `*` is never
 # exempted away; allow `*` inside an annotation run and a `files:` list containing `- *` has its claim
 # on EVERY FILE deleted before the guard is consulted, which no downstream check can recover. Killed by
 # "OV-001-R2: a `*` is never deleted by the pre-pass".
 ("the pre-pass may swallow a `*` — a claim on every file is deleted before the guard sees it",
  "src/models.ts",
  "const SPACED_ANNOTATION = /(^|[,\\s])\\([^()/.,*]*\\)(?=[,\\s]|$)/g;",
  "const SPACED_ANNOTATION = /(^|[,\\s])\\([^()/.,]*\\)(?=[,\\s]|$)/g;"),

 # NF-001 · THE DEFECT ITSELF: retire a finish whatever the injection did. This is what shipped —
 # `announced.add(key)` at DETECTION, persisted before the injector was even spawned — so a worker
 # finishing while the orchestrator was mid-turn was refused by the busy-composer guard and never
 # raised again (a finished job sat unread in an outbox for three hours, reported 2026-09-17).
 # Killed by "NF-001 wiring: a REFUSED notification is raised again on a later tick".
 ("a finish is retired whatever the injection did — the busy composer loses it for good",
  "src/notifier.ts",
  '    if (verdict === "latch") {',
  '    if (verdict === "latch" || true) {'),

 # THE SAME DEFECT AT THE RETIREMENT END, and the one the adversarial pass found: `key` is
 # role|task|status, and rerunning a handoff produces it twice. An injection runs up to 60 s against
 # a 15 s tick, so a SECOND finish can be queued under that key while the first is still typing, and
 # matching by key retires a finish no message ever carried. Killed by "NF-001 wiring: a SECOND
 # finish under the same key is not retired by the first injection".
 ("retirement matches the KEY, not the instance — a rerun finish is retired by the previous one",
  "src/notifier.ts",
  "    const still = st.pending.some((p) => p.id === ev.id);",
  "    const still = st.pending.some((p) => p.key === ev.key);"),

 # THE WRITE-BACK. `scan` reads state, then board.json and one status.json per role, then saves; a
 # `settle` from another window fits in that gap. Saving the snapshot resurrects the event that was
 # just delivered AND erases the record of delivering it — a second copy typed into the composer.
 # Killed by "notifier: a scan cannot roll back a delivery that landed while it was reading".
 ("the scan saves the snapshot it started from — a delivery that landed mid-scan is rolled back",
  "src/notifier.ts",
  "    const fresh = loadState(this.repo) ?? { prev: {}, announced: [], pending: [], dropped: [] };",
  "    const fresh = persisted ?? { prev: {}, announced: [], pending: [], dropped: [] };"),

 # THE TRAP DG-001-R1 CLOSED, RE-OPENED ONE FILE OVER. loom_cdp.py's fast `ok: False` is two failures,
 # and dropping the NOTE makes them one: "typed but NOT submitted … verified" means the message is
 # already in the composer, so retrying it appends a second copy. Killed by
 # "NF-001 wiring: 'typed but NOT submitted' is NOT retried".
 ("the notifier reads the boolean and not the injector's note — a verified message is typed twice",
  "src/extension.ts",
  "        const verdict = settleInjection(ok, Date.now() - startedAt, note);\n        notifier.settle(ev, verdict, note);",
  "        const verdict = settleInjection(ok, Date.now() - startedAt, null);\n        notifier.settle(ev, verdict, note);"),

 # A finish that was superseded is delivered late: the role is back at work — which on this bus
 # usually means the orchestrator handed it a block — and it is still sent to an outbox already
 # answered. ANCHORED AT THE MERGE, because that is where the rule lives: the first version of this
 # mutant deleted a `pending.delete(role)` up in the scan loop and SURVIVED the whole suite, which
 # is how that line was found to be a dead second copy. Killed by "NF-001 wiring: a worker back at
 # WORK is not announced late".
 ("a role back at work keeps what it was owed — the orchestrator is sent to an answered outbox",
  "src/notifier.ts",
  '      if (working.has(p.role)) { drop(p, "superseded: the role went back to work"); continue; }',
  '      if (working.has(p.role) && false) { drop(p, "superseded: the role went back to work"); continue; }'),

 # AND THE OTHER HALF OF THAT RULE: the drop is only defensible because it is RECORDED. health.ts's
 # gate wake puts a worker back to `working` without telling the orchestrator, so a dropped finish
 # can be one nobody ever heard — and `dropped` on the bus is the only trace it leaves. Killed by
 # "NF-001 wiring: a finish that reached NOBODY is recorded as dropped".
 ("a superseded finish is dropped silently — nothing on the bus records that nobody was told",
  "src/notifier.ts",
  '      if (working.has(p.role)) { drop(p, "superseded: the role went back to work"); continue; }',
  '      if (working.has(p.role)) { continue; }'),

 # THE ORDER. Newest-first means the oldest finish is deferred again on every tick a newer one
 # arrives — the three-hour outbox, preserved exactly, on a queue that looks like it is draining.
 # Killed by "NF-001 wiring: two workers that finished while it was busy arrive one per tick".
 ("the newest finish is delivered first — the one that has waited longest keeps being deferred",
  "src/notifier.ts",
  "    queue.sort((a, b) => Date.parse(a.firstSeen) - Date.parse(b.firstSeen));",
  "    queue.sort((a, b) => Date.parse(b.firstSeen) - Date.parse(a.firstSeen));"),

]

def sh(cmd):
    return subprocess.run(cmd, shell=True, cwd=ROOT, capture_output=True, text=True)

# REFUSE TO RUN OVER UNCOMMITTED WORK. This script used to restore each mutant with `git checkout -- src/`,
# which cannot tell a mutation from work in progress: on 2026-09-09 it silently destroyed an hour of
# uncommitted changes to registry.ts, roles.ts, tracker.ts and statusView.ts. Commit (or stash) first;
# the whole point of the tool is to run against the code you are about to trust.
# AN-001 · IT COVERS WHAT `make_tree` COPIES, not just src/. It checked `-- src/` alone, while a
# mutant tree is a copy of src/, test/, test.sh, live-check.js and both manifests — so the SUITE that
# grades every mutant, and 18 of the 350 anchors, sat outside the only guard that claims "mutants are
# copies of what is committed-and-built". An uncommitted test file would have been graded against and
# then vanished from the record. The scan added by AN-001 reads the live tree, and that is sound only
# if this list is the same list.
def _refuse_if_dirty():
    dirty = sh("git status --porcelain -- src/ test/ test.sh live-check.js package.json "
               "tsconfig.json").stdout.strip()
    if dirty:
        print("REFUSING: the tree has uncommitted changes — mutants are copies of what is committed-and-built,\n"
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
    # `.mutant-tree` tells corpus.test.js that this tree is a COPY. Its anchor check is a claim
    # about the REAL source tree, and inside a mutant copy one anchor is bent on purpose, so the
    # claim is false here by construction — ungated it would fail in all 349 trees and mark every
    # mutant "caught" for a reason that is not the defect, which is an unreadable scoreboard.
    # A FILE rather than an environment variable: the first version was LOOM_MUTANT_TREE=1, which
    # one `export` in any shell could use to delete that file's coverage and still print a pass.
    (work / ".mutant-tree").write_text("a throwaway copy made by test/mutation.py\n")
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

# ── PRE-FLIGHT · EVERY MUTANT MUST ANCHOR AND MUST COMPILE, BEFORE ANYTHING IS GRADED ────────────
#
# WL-007-R1, and prescribed in the owner's notes since the WL-004 cycle without ever being enforced —
# which is why it recurred. On WL-007 the gate reported `193/194 caught, 1 stale`, and the "stale" one
# was not a rotted anchor at all: its replacement text did not COMPILE. A mutant that does not build
# asserts nothing — every test fails for a reason that is not the defect — so it is scored as "could
# return unnoticed" while the gate goes on printing a score. The one lost that day was the guard on
# the newest code in the block, which is exactly where a bad anchor lands.
#
# TWO CHECKS, AND NEITHER SUBSUMES THE OTHER — this is the whole reason both are here:
#   · the ANCHOR check catches a `find` that no longer matches (or matches twice). A stale anchor
#     COMPILES PERFECTLY, because nothing was changed: compiling proves nothing about it.
#   · the COMPILE check catches a `repl` that is not valid TypeScript. It can only run on a mutant
#     that anchored, so it can say nothing about one that did not.
# A run of 194 mutants is 194 suite runs; both failures are cheap to find here and expensive to find
# at the end, so this REFUSES TO START and names every offender at once rather than one per re-run.


def preflight_one(idx, name, rel, find, repl):
    """-> None if the mutant anchors and compiles, else ("anchor"|"compile", name, reason)."""
    work = make_tree(f"pf{idx}")
    try:
        p = work / rel
        src = p.read_text()
        n = src.count(find)
        if n != 1:
            return ("anchor", name, f"{rel}: pattern occurs {n} time(s), expected 1")
        p.write_text(src.replace(find, repl))
        r = subprocess.run([CODIUM, TSC_REL, "-p", "./"], cwd=work, capture_output=True, text=True,
                           env=mut_env_for(work))
        if r.returncode != 0:
            first = next((ln.strip() for ln in (r.stdout + r.stderr).splitlines()
                          if "error TS" in ln), "tsc failed with no TS error line")
            return ("compile", name, f"{rel}: {first}")
        return None
    finally:
        shutil.rmtree(work, ignore_errors=True)


# ── AN-001 · THE ANCHOR CHECK IS NOT PART OF THE GRADE, AND MUST NOT BE SCOPED LIKE ONE ─────────
#
# ANCHORING IS CHEAP AND GRADING IS EXPENSIVE, and this file used to conflate them: both halves of
# the pre-flight ran per mutant, so a run that graded 7 mutants checked 7 anchors and said nothing
# about the other 342. developer1 met that on OV-001-R2 — `7/7 caught` was true and carried no
# information about the rest of the corpus — and on this block SEVEN anchors were stale at HEAD
# while every subset run anyone had done reported clean. A stale anchor matches nothing, so the
# mutant is never applied, so it grades nothing, AND THE RUN REPORTS A CLEAN CORPUS: the evidence
# of the defect is indistinguishable from success, which is why it accumulates invisibly.
#
# So the anchor check is corpus-wide on EVERY run of every size. It can afford to be, because it is
# a string count: one read per DISTINCT FILE (32 files for 350 mutants), no tree copy, no compile.
# The per-mutant pre-flight below still checks the anchors it is about to grade — that is deliberate
# duplication in the safe direction, and the one check it adds is the compile, which cannot be done
# without a tree.
#
# IT READS THE LIVE TREE, which is only sound because `_refuse_if_dirty()` has already established
# that the tree is the committed one; it never writes there. Every mutation happens in a copy.
def anchor_scan(rows):
    """-> [(idx, name, rel, reason)] for every mutant whose `find` is not unique in its file."""
    cache, bad = {}, []
    for idx, (name, rel, find, _repl) in rows:
        if rel not in cache:
            fp = ROOT / rel
            cache[rel] = fp.read_text() if fp.exists() else None
        src = cache[rel]
        if src is None:
            bad.append((idx, name, rel, f"{rel}: the file does not exist"))
            continue
        n = src.count(find)
        if n != 1:
            bad.append((idx, name, rel, f"{rel}: pattern occurs {n} time(s), expected 1"))
    return bad


# WHAT A STALE ANCHOR COSTS THE RUN, and it is not one answer:
#
#   · stale INSIDE what this run grades -> REFUSE. A mutant you asked for that cannot be applied is
#     a hole exactly where you are looking, and the run would print a score that does not include it.
#   · stale ELSEWHERE -> REPORT. Refusing here would block work on one defect because of an anchor
#     somebody else rotted last week, and a guard that does that gets stopped being run — which
#     costs more than the staleness did. Reported at the top of the run AND in the final summary, so
#     it cannot be mistaken for success; MUTATION_STRICT_ANCHORS=1 escalates it to a refusal.
#
# PURE, so the decision is testable without a gate: the branch is the whole point of this block and
# an untested branch in a guard is how "it has never refused anything" happens.
def anchor_verdict(stale, graded, strict=False):
    """-> ("refuse"|"report"|"clean", stale_here, stale_elsewhere)."""
    here = [s for s in stale if s[0] in graded]
    away = [s for s in stale if s[0] not in graded]
    if here:
        return ("refuse", here, away)
    if away:
        return ("refuse" if strict else "report", here, away)
    return ("clean", here, away)


# Substring selection over the mutant's NAME and its FILE, so `mutation.py overlap.ts` grades the
# overlap guard's mutants and `mutation.py "stall alarm"` grades one. Selecting is how a subset run
# stops being an ad-hoc script that mutates the real tree by hand.
def select(patterns):
    if not patterns:
        return list(range(len(MUTATIONS)))
    pats = [s.lower() for s in patterns]
    return [i for i, (name, rel, _f, _r) in enumerate(MUTATIONS)
            if any(s in f"{name} {rel}".lower() for s in pats)]


# ── THE GATE ITSELF — everything below runs ONLY as a script ────────────────────────────────────
#
# WC-001 · WHY THIS GUARD EXISTS. Until now every statement below sat at module level, so `import
# mutation` — the obvious way to read the MUTATIONS table — did not read the table, it RAN THE GATE:
# a git check that can `sys.exit(2)`, then a baseline suite run and a mutant per table entry, each
# recompiling and running the whole suite in its own copy of the tree. Two blocks were billed for
# that probe before anyone wrote this line. The table is a data structure and must be readable as
# one; the gate is a program and must be asked for explicitly.
#
# The MUTATIONS table, and every helper above, are now importable with no side effect of any kind.
# `python3 test/mutation.py` is unchanged.
if __name__ == "__main__":
    _refuse_if_dirty()

    # THE WHOLE CORPUS, on every run of any size — see the note above `anchor_scan`. FIRST, before
    # the selection is even judged: a run that grades nothing still reports the corpus, because the
    # cost of saying so is a string count and the cost of not saying so is this whole block.
    _all = [(i, m) for i, m in enumerate(MUTATIONS)] + [("noop", tuple(NOOP_SELFCHECK))]
    _stale_all = anchor_scan(_all)
    print(f"anchor check (WHOLE corpus, {len(_all)} anchors): "
          f"{len(_all) - len(_stale_all)} unique, {len(_stale_all)} STALE")

    _sel = select(sys.argv[1:])
    # TI-001's rule, which is the same rule as this block's: a run that executes nothing is not a
    # pass. A selector that matches no mutant must never look like a clean gate.
    if not _sel:
        print(f"REFUSING: {sys.argv[1:]} selects 0 of the {len(MUTATIONS)} mutants — nothing would be "
              f"graded, and an empty run is not a green one.\n"
              f"          A selector is matched as a substring of a mutant's name or its file.")
        sys.exit(3)
    _rows = [(i, MUTATIONS[i]) for i in _sel]
    _subset = len(_sel) != len(MUTATIONS)
    _graded = {i for i in _sel} | {"noop"}
    _verdict, _stale_here, _stale_away = anchor_verdict(
        _stale_all, _graded, os.environ.get("MUTATION_STRICT_ANCHORS") == "1")
    _anchor_line = (f"anchor check (WHOLE corpus, {len(_all)} anchors): "
                    f"{len(_all) - len(_stale_all)} unique, {len(_stale_all)} STALE")

    # A stale anchor OUTSIDE this run is REPORTED, NOT REFUSED. Refusing would block work on one
    # defect because of an anchor somebody else rotted, which is how a guard teaches people to stop
    # running it. Reporting is only honest if it cannot be mistaken for success, so the count is
    # printed here, again in the summary at the end, and nowhere is a subset run allowed to end on a
    # line that mentions only what it graded. MUTATION_STRICT_ANCHORS=1 escalates it to a refusal
    # for anyone who wants the whole corpus to be a gate.
    if _stale_away:
        print(f"\n  {len(_stale_away)} STALE ANCHOR(S) OUTSIDE THIS RUN — they grade nothing, and this run "
              f"does not grade them:")
        for _i, _nm, _rel, _why in sorted(_stale_away, key=lambda s: str(s[0])):
            print(f"    [{_i}] {_why}\n         {_nm}")
        print()
    if _verdict == "refuse" and not _stale_here:
        print("REFUSING: MUTATION_STRICT_ANCHORS=1 — the whole corpus must anchor, not just the part "
              "this run grades.")
        sys.exit(2)
    if _stale_here:
        print(f"REFUSING: {len(_stale_here)} anchor(s) THIS RUN WOULD GRADE match nothing — the score "
              f"would silently omit them:")
        for _i, _nm, _rel, _why in sorted(_stale_here, key=lambda s: str(s[0])):
            print(f"    [{_i}] {_why}\n         {_nm}\n"
                  f"         FIX: re-anchor `find` on the current source — the code moved under it.")
        sys.exit(2)

    print(f"pre-flight: every one of {len(_rows) + 1} mutants this run grades must ANCHOR and must COMPILE...")
    _bad_anchor, _bad_compile = [], []
    with concurrent.futures.ThreadPoolExecutor(max_workers=PARALLEL) as pool:
        _pf = [pool.submit(preflight_one, i, *m) for i, m in _rows]
        # The self-check is a mutant like any other: a no-op that stopped compiling would fail the run
        # for a reason that has nothing to do with the harness being able to tell a no-op from a defect.
        _pf.append(pool.submit(preflight_one, "noop", *NOOP_SELFCHECK))
        for fut in concurrent.futures.as_completed(_pf):
            r = fut.result()
            if r is None:
                continue
            (_bad_anchor if r[0] == "anchor" else _bad_compile).append((r[1], r[2]))

    if _bad_anchor or _bad_compile:
        print(f"\nREFUSING: {len(_bad_anchor) + len(_bad_compile)} mutant(s) cannot grade anything. "
              f"They are reported here rather than as a score at the end,\n"
              f"          because a mutant that never ran is not evidence that a defect would be caught.\n")
        for nm, why in sorted(_bad_anchor):
            print(f"  STALE ANCHOR    {nm}\n                  {why}\n"
                  f"                  FIX: re-anchor `find` on the current source — the code moved under it.")
        for nm, why in sorted(_bad_compile):
            print(f"  DOES NOT BUILD  {nm}\n                  {why}\n"
                  f"                  FIX: rewrite `repl` — it anchors, but the text it produces is not "
                  f"valid TypeScript.")
        sys.exit(2)
    print(f"pre-flight clean: all {len(_rows) + 1} anchor and compile.\n")

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

    survived, stale, ungraded, noncompiling = [], [], [], []
    print(f"reintroducing {len(_rows)} of the {len(MUTATIONS)} defects that were live on 2026-09-09"
          + (f" (selected by {sys.argv[1:]})" if _subset else "") + ":\n")


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
                # NOT "STALE". WL-007-R1: these are different failures with different causes and
                # different fixes, and for one run they wore the same word — which cost the owner a wrong
                # first diagnosis until they read the reason on the next line. A STALE anchor means the
                # code moved out from under `find`; a mutant that does not BUILD means `repl` is not
                # valid TypeScript. One is the source drifting, the other is the mutant being wrong.
                # The pre-flight should make this branch unreachable; it is kept because "unreachable"
                # is a claim about the pre-flight, and a gate that trusts its own claims is the thing
                # this file exists to disbelieve.
                return ("NOCOMPILE", name, "(mutant does not compile — the pre-flight should have caught this)")
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
        elif status == "NOCOMPILE":
            print(f"  NOBUILD   {name}\n            {detail}")
            noncompiling.append(name)
        else:
            print(f"  STALE     {name}\n            {detail}")
            stale.append(name)


    with concurrent.futures.ThreadPoolExecutor(max_workers=PARALLEL) as pool:
        futures = [pool.submit(run_one, i, *m) for i, m in _rows]
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
        print(f"containment: 0 loom-* left in {tempfile.gettempdir()} across {len(_rows)} suite run(s).")

    # What this run is a statement ABOUT. A scoreboard over 7 of 349 mutants says nothing about the
    # other 342, and the one number a reader carries away must say so itself.
    _scope = (f"\n{len(_rows)} of {len(MUTATIONS)} mutants graded — this score is a statement about "
              f"those {len(_rows)}, not about the corpus." if _subset else
              f"\nall {len(MUTATIONS)} mutants graded.")

    sc_ok = sc_status == "SURVIVED"
    if sc_ok:
        print("self-check: the no-op mutant SURVIVED — the harness can tell a real defect from a no-op.")
    else:
        print(f"SELF-CHECK FAILED: the no-op mutant was reported {sc_status} {sc_detail}\n"
              f"  A mutation that changes NOTHING must survive. Until that holds, every score above is\n"
              f"  unreadable — this is the 2026-09-13 defect (a red baseline made every mutant 'caught').")

    if survived or stale or ungraded or noncompiling or not sc_ok:
        print()
        for s in survived:
            print(f"SURVIVED:  {s}")
        for s in stale:
            print(f"STALE:     {s}  (anchor no longer matches — re-anchor `find`)")
        for s in noncompiling:
            print(f"NOBUILD:   {s}  (anchors, but `repl` is not valid TypeScript — rewrite it)")
        for s in ungraded:
            print(f"UNGRADED:  {s}")
        ungradeable = len(survived) + len(stale) + len(ungraded) + len(noncompiling)
        parts = [f"{len(survived)} survived", f"{len(stale)} stale",
                 f"{len(noncompiling)} non-compiling", f"{len(ungraded)} ungraded"]
        line = (f"\n{len(_rows) - ungradeable}/{len(_rows)} caught, " + ", ".join(parts))
        # Only claim a defect could return when one actually can. A failing SELF-CHECK with a clean
        # scoreboard means the opposite: the scoreboard cannot be trusted to tell us either way.
        if survived or stale or ungraded or noncompiling:
            line += " — those defects could return unnoticed"
        else:
            line += " — but the SELF-CHECK above failed, so this scoreboard is not evidence of anything"
        print(line)
        print(_anchor_line + _scope)
        sys.exit(1)
    print(f"all {len(_rows)} mutations run were caught — those defects now break the suite")
    print(_anchor_line + _scope)
