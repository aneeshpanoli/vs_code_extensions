# Handover — loom-session-tracker

Written 2026-09-09 so a fresh context can pick this up without the conversation that produced it.
Read this, then `README.md` (what the extension is and how to use it), then run `./live.sh`.

If you are the orchestrator being restored by this extension's own memory cycle: this is the same
idea, done by hand. The state below was true when it was written; **verify it, do not trust it.**

---


## ★ Resume here — banked 2026-09-13 before a context clear (updated the same day for 0.30.0)

**Version 0.33.0**; **546 tests** green in BOTH modes (`./test.sh` and `LOOM_TEST_JOBS=1
./test.sh`), **85/85 mutants caught** by the real baseline-graded gate (GC-003, developer2) with its
no-op self-check surviving. `./live.sh` is clean except the warnings under open threads and the
expected "windows are running an OLD build" failure until the deploy + reload. Read this section,
then `README.md`, then run `./live.sh` and believe it over anything written here.

### The principles the code now rests on (each was learned from a live failure)
1. **Names are a contract** (`src/naming.ts`): one owner test `isOwnerRole()`, aliases on the bus in
   `<repo>/naming.json`, four-role vocabulary with numbered instances (`developer1`, never
   `developer_1` — underscores are invisible to both regexes).
2. **A panel belongs to the window it is in** (0.28.0): CDP `parentId` → window folder; a repo-scoped
   tracker never claims a frame from another folder's window. This superseded a week of text
   heuristics (attribution purity, marker-over-path, corroboration, contested declarations) — those
   remain as the fallback for legacy reads with no parentId.
3. **Declarations beat guesses**: `<role>.id` files and board webviewIds identify frames; a targetmap
   is a cached guess. `loom_cdp.py` refuses a by-role lookup into any bus's declared orchestrator.
4. **Commands need an idle composer**: `/model`, `/clear`, `/loom` typed mid-turn queue as messages and
   never execute; `loom_cdp.inject()` refuses them unless `--allow-busy`; the context cycle needs two
   consecutive idle readings before `/clear`.
5. **Never close a Claude tab over CDP** — `/json/close` on a webview target closes the WHOLE WINDOW
   (three windows lost 2026-09-12). `cdp.closeWebview()` refuses; `retire`/`delete` name the tab
   for a person. A tab-scoped close needs `vscode.window.tabGroups` and a live test first.
6. **Every message carries a return address** (`[from repo/role @ id8 · reply: ring @repo/role.id]`),
   enforced in `loom_cdp.inject()`; the extension passes `senderArgs()`. Playbook §16.
7. **Orchestrators open their own roles**: `<repo>/open-requests.json` → reopened from the freshest
   transcript or SPAWNED + bound if the role never had a session; the result carries each new tab's
   `webviewId`. Playbook §15. The restart wake and the post-`/clear` restore both tell the PO this.
8. **Restart path**: previously-live roles are reopened automatically 30 s after activation (the one
   sanctioned auto-open), then the PO is woken once. Blank `Untitled` shells from Claude Code's
   restore are left in place (see 5).
9. **Testing**: `./test.sh` (parallel by file), `python3 test/mutation.py` (parallel, refuses a dirty
   `src/`), `./live.sh` (real bus + running editor, FAILS on: old build in a window, poisoned
   targetmap, invisible orchestrator, worker-named tag). Fixtures in `test/fixtures/live` are real
   panels, redacted, self-verified at capture; capture the BUS too or fixtures encode the blind spot.
10. **Gate on real exit codes.** Twice a `time`/`tail` pipe hid a red result and a push went out.
11. **A transcript resumes only from the window it was written under** (0.30.0). Claude Code looks a
    session id up in the window cwd's project dir; elsewhere `editor.open(sid)` makes a blank
    `Untitled` tab on the pinned model. A role whose transcripts all live under its worktree's cwd is
    *stranded* from the main window: never reopened, spawned+bound on request, reported with the cwd.
    Measured 2026-09-13 05:50 — four roles, four blank tabs, orchestrators asking again.
13. **The panel's silence is an opinion** (0.30.1): the compact button renders only past 50% used,
    so a visible conversation with no button is under 50% and no transcript estimate may start a
    cycle. A transcript that stopped before the last clear is dead. One session id can live in two
    project dirs; the newest copy is the session. After a confirmed clear the extension REBINDS the
    orchestrator's `board.json` entry to the fresh id itself (`rebindSession`, 0.31.0); the restore
    prompt and playbook §14 step 4 ask the orchestrator to confirm it.
12. **Only the orchestrator is on the premium tier** (user direction 2026-09-13). The settings pin is
    `claude-opus-5`; the tagged orchestrator's own idle frame is promoted with `/model`. The footer
    chip lags a switch until the next turn, so `models.acknowledgedSwitch()` reads the "Set model
    to" line and the policy does not retype while it lags.
14. **The context is re-read every turn, so its LENGTH is the cost** (0.32.0, measured
    2026-09-13 across all projects: 2.93 billion cache-read tokens in one day, 238k of context per
    turn over 12,540 turns, output under 0.5% of tokens). Three consequences, all shipped:
    the clear threshold is **30%**, not 50 — a restore costs ~30-60k tokens once, a fat context costs
    its full length on every one of those turns; the memory is a **contract**, `memory.md` under
    `MAX_MEMORY_BYTES` (12,000) with an UNSURE section, durable lessons split into `<role>/notes.md`
    (read once per restore, appended rarely), and a restore reads memory → notes → board + each
    role's `status.json` → ONLY the docs the memory names, never `CLAUDE.md` and `docs/` wholesale
    (an oversize memory still clears — the note says to trim it); and **no watchers, Monitors or
    `/loop` in an orchestrator session** — the tracker wakes it when a role finishes, stalls or is
    resumed, and every self-armed wake pays the whole context again (restore prompt, playbook §17).

15. **Garbage is misinformation, not waste** (0.33.0, measured 2026-09-13: 34 deployed builds with
    one in use, 2.4 GB of transcripts with 931 untouched for 14 days, funisland at 75 worktrees of
    which 72 are on no board role, boards naming 16 dead sessions, 1.4 GB of checkpoints). The cost
    is not disk: an orphan worktree or a dead board id feeds straight back into an orchestrator's
    context — a `git worktree list` of funisland fills a panel, and by principle 14 that is paid on
    every turn — and a dead transcript is a wrong-lookup hazard (the fourteen-clear night ran on a
    stale copy under another project's directory). `src/gc.ts` plans and applies in three tiers and
    **never deletes anything**: tier 1 (superseded builds, unreferenced transcripts, old `.bak-`
    files) moves into `~/.claude/loom/_archive/<date>/` automatically once per `gcIntervalHours`
    behind a cross-window lease like the context cycle's; tier 2 (orphaned *clean and merged*
    worktrees via the existing `removeWorktree` safeguards, board entries marked `dead` and never
    removed) needs a click; tier 3 (stale buses, copied owner `.id` files, unmerged/dirty orphans,
    checkpoints) is only ever listed. `gcEnabled` ships **false**: the first pass on this machine
    moves ~700 MB, so a person runs Show plan → Run tiers 1+2 once before it is automatic.
    The hardening that survived adversarial review is the interesting part, and all of it is one
    idea — **the registry is not the runtime, and a plan is not the world**:
    an editor keeps the code it loaded, so nine windows were on 0.29.0 while `extensions.json` said
    0.32.0 (`running-versions.json` is now part of the keep-set, and a non-semver `VERSION` refuses
    the whole tier); a session id can be referenced only in a `status.json` or an `open-requests`
    result, so the reference set is those plus a sweep of every `*.json`/`*.md` under the loom root,
    over buses that have no `board.json` at all; a worktree name is matched through the bus's aliases
    and a name one typo from a real role (`Gaming/protyping`) drops to tier 3; and every safeguard is
    asked AGAIN at apply time against the live roster, because the plan is read by a person who then
    clicks. A lease timestamp in the future is expired, not fresh — a clock step must not create a
    claim nothing can break.
16. **A read that cannot answer must say so, not return nothing** (0.33.0, GC-004 — the second
    review, and every finding in it was this one sentence). `readJson` → `null` → an empty set is
    indistinguishable from "there is nothing", and every guard downstream reads "nothing" as
    permission: a TORN `running-versions.json` (ten windows rewrite it every 15 s) meant an empty
    keep-set and archiving the build nine windows were running; a reference sweep that hit its file
    budget or skipped an oversize file meant "no bus references this transcript". Both now refuse
    their whole tier with a note (`RunningVersions.readable`, `ReferenceSweep.truncated`), the same
    shape as `Measured.truncated`. Two supply-side corollaries: the version stamp is keyed by
    **windowId**, not by repo — two windows on one project shared a slot and every folderless window
    collapsed into `(no project)`, so a window's build could be invisible — and it is written
    tmp+rename; and the live roster fed to a MACHINE-WIDE pass cannot come from `tracker.view()`,
    which is scoped to one project by design, so `busLiveRoles()` reads every
    `<repo>/<role>/status.json` touched in the last 30 minutes (the file's mtime, not its
    `updated_at`, which measurably lies).

### Things outside git this depends on
`~/.claude/loom/loom_cdp.py` (return address, busy guard, orchestrator guard, --repo/--webview-id),
`~/.claude/loom/test_loom_cdp.py` (mirrored in `tools/`), `ORCHESTRATION-PLAYBOOK.md` §13–§17 (§17: no watchers in an orchestrator session).
Backups of loom_cdp.py sit beside it as `loom_cdp.py.bak-<epoch>`.

## Where everything is

| | |
|---|---|
| Source (git) | `/home/aneesh/vs_code_extensions/loom-session-tracker` — `main`, pushed to `github.com:aneeshpanoli/vs_code_extensions` |
| Deployed copy | `~/.vscode-oss/extensions/local.loom-session-tracker-0.14.0/` — installed with `../deploy.sh loom-session-tracker`, registered in `extensions.json`, needs a window reload |
| The bus it watches | `~/.claude/loom/<project>/` — `board.json`, per-role `status.json`/`inbox.md`/`outbox.md`, plus the state files this extension writes |
| The injector | `~/.claude/loom/loom_cdp.py` — **not in git**, backed up in place as `loom_cdp.py.bak-<epoch>`. Changed 2026-09-09: `--repo` (project-scoped `_role_repo`/`find_role`/`_load_targetmap`, refuses ambiguous bare names), owner aliases read from `naming.json`, `KNOWN_ROLES` derived from the buses instead of a literal, `/loom` binding requires a leading command not a substring |
| The pattern's playbook | `~/.claude/loom/ORCHESTRATION-PLAYBOOK.md` — **not in git**; §13 (target by webviewId) and §14 (the memory cycle) matter most here |
| Live projects | `Gaming`, `gaming` (stale, lowercase), `funisland`, `livegita`, `shwab_docker` |

Two of those live outside version control. If either is lost, the extension still runs but cannot
inject anything.

---

## What this extension is

The instrument panel for running many Claude Code sessions as a team: it reads every Claude panel in
every editor window over CDP, works out which session is which Loom role, and acts on what it finds
(finish notifications, stall alerts, usage-limit resumes, model policy, worktree hygiene, and the
orchestrator context-memory cycle). `README.md` is the full description. The parent
[`../README.md`](../README.md) keeps the engineering record — what was measured and why each
decision went the way it did.

---

## State as of 2026-09-09

**Version 0.16.0** (0.15.0 = the naming contract + board-declared PO frame; 0.16.0 = project-scoped role resolution, the four-role vocabulary, declared-outranks-tag). 366 checks, 23 files. Deployed; the window must be RELOADED to run it.
Working tree clean. Six commits this session, `18fb520..f058c2f`:

| | |
|---|---|
| `115a631` 0.11.0 | Roster derivation by shape+mailbox; notifier baselines on working-like; orchestrator addressed by webviewId; the context-memory cycle |
| `5731caf` 0.12.0 | The cycle could not fire (no transcript for `product-owner`) and would have fired at the wrong session (editor-wide frames) |
| `ca43bc7` 0.13.0 | Weak candidates — the session that needs the cycle could not be tagged |
| `958a1f7` 0.13.1 | `live-check.js` |
| `61c1789` 0.14.0 | Edge cases + the two-window `/clear` race they found |
| `f058c2f` | `README.md`, `live.sh` |

### The live system, right now

`./live.sh` reports **1 FAIL, 5 WARN**, and the failure is a real state to fix, not a bug:

- `a8faad83` (shwab_docker's PO) is still tagged as the orchestrator of **Gaming and funisland**.
  That frame died with the editor restart, so both tags read `frame not identified` and both cycles
  correctly refuse to act.
- **The pending action:** in the funisland window click the ★ on `f1cf0030` (**88% context** — it
  will bank and clear on the next tick); in the Gaming window, on `c16de08c` (54%) or `dc1aff90`.
  Frame ids change on every window reload — take them from `./live.sh`, never from this document.
- `livegita` sometimes offers no candidate: its PO-ish session is dominated by `worktrees/developer`
  paths, so it classifies as the `developer` worker and is excluded. Tag it from the QuickPick if it
  really is the orchestrator.
- 16 board `session_id`s point at no transcript. Bus drift, not an extension fault — but "Reopen
  sessions" cannot restore those.

---

## What changed this session, and why

Each of these came from measuring the live system, not from reasoning about it. That is the method
to keep.

**The roster was dropping real roles.** `boardRoles()` filtered a flat `board.json` with a denylist
of metadata key names; funisland's board carries seven keys that were not on it, so its roster was 7
phantoms plus 3 real roles and **dropped the 8 roles that own a mailbox**. Consequences: those
sessions were undetectable; `funisland/simulation` had been "working" for 433h with no watchdog able
to see it; and 7 of their worktrees read as orphaned, 6 of which passed every safeguard in
`removeWorktree`. Roles are now board entries recognised by *shape* (`session_id`/`branch`/`status`/
`bound_at`) unioned with every bus directory holding a mailbox.

**Nothing could reach the orchestrator.** `loom_cdp.py`'s `find_role()` drops any frame that
content-detects as `product-owner` — the self-woke guard — so `inject --role product-owner` can
never land, and the finish notifier and stall alert had a delivery path that would always have
failed. `loom_cdp.py` now takes `--webview-id` to address one named frame, verifying the frame's own
URL carries that id (playbook §13, the check `safe_inject.py` makes). Every injection aimed at the
orchestrator goes through `src/inject.ts` with the tag's recorded frame.

**The context-memory cycle** (`src/memory.ts`, `src/context.ts`): past 50% the orchestrator is asked
to write `~/.claude/loom/<repo>/<role>/memory.md`, then `/clear`, then a restore prompt that reads
that file, the board and the docs and reconciles them. `/clear` is sent only after the file is
verified newer-than-the-request and non-trivial, never mid-turn, never when the frame was not seen
this tick, one window at a time (a lease on the bus), and pinned to the role and file it began with.

**The percentage comes from the panel.** The compact button's `title` reads `NN% context used —
click to compact`; the shipped webview renders it only past 50% used, dividing by
`contextWindow - maxOutputTokens - 13000`. It lives in an attribute, invisible to `innerText`, so
`cdp.ts` pulls it explicitly. Below that threshold the session's transcript is used
(`input + cache_read + cache_creation` of the last main-thread turn, tail-only, sidechains skipped).
Either source alone is enough — which matters because the tag usually names `product-owner`, a role
no board lists, so there is often no transcript at all.

**Frames are attributed to a project.** The CDP read is editor-wide, so "the only orchestrator frame"
was being adopted by every window at once — one shwab_docker frame was tagged by three projects. A
frame is now attributed by dominant `loom/<repo>/` path mentions, and an unattributable frame is
adopted by nobody. Candidates come in two strengths: STRONG (says it is the orchestrator) can be
adopted silently; WEAK (works on this project, is not one of its roles) is offered for a click only.

**Two windows, one project.** Nine windows are open, and a worktree window resolves to its parent
repo id, so two windows are routinely scoped to one project — and both were sending the save prompt
and then both sending `/clear`, the second landing in the session the first had just restored.
Hence the lease.

---

## 0.20.0 — proper tests (2026-09-09, user direction)

The suite went 349 -> 388 passing across the night described above while the live system misrouted six
ways. Three things now exist so that cannot repeat quietly:
- `test/fixtures/live/` — REAL panels captured from the running editor, redacted of prose but exact in
  every token classification reads, and in length. `capture.js` refuses to write a fixture that behaves
  differently from the frame it came from, and snapshots the buses (roster + aliases) as well, since the
  tests run with HOME sandboxed and frames alone are half a world. It caught two of its own bugs on the
  first run: filled `·` separators broke the model footer, and a trailing-slash-only path pattern erased
  `worktrees/developer`.
- `test/mutation.py` — reintroduces all 12 defects of that night and requires the suite to fail on each.
  Run it after any change to classification, dispatch or limits. It found a real gap immediately: the
  source-ranking rule (a sign-off outranks path evidence) had NO test that failed without it, because
  the corroboration rule masked it in every existing scenario.
- `src/dispatch.ts` — the "who gets typed into" decision, extracted from a closure inside `activate()`
  so it can be asserted directly, with COMMAND (needs an idle composer) and MESSAGE (may queue) as
  distinct purposes.
Capturing the fixtures also exposed a live defect nothing else had: livegita's real PO (a57ba8a7) signs
`LOOMROLE=productowner` and mentions `worktrees/developer` eleven times, and `classify()` returned
`developer` — a clean OWNER sign-off fell through to path evidence. Only `boardOwnerFrames()` stood
between that and the orchestrator being treated as a worker.

## 0.21.0 — the bus declares its frames (2026-09-09, user report)

"I don't see any orchestrated session for ReciEats." Its PO was running and writing status every few
minutes; the sidebar listed nothing. Cause: the buses address frames through `<repo>/<role>.id` files
(ReciEats/README-ids.md documents the convention; funisland uses the line-1 form) and this extension
had never read them. That PO's tab works on `main`, mentions almost no project paths, and so attributed
to NO project — leaving it offerable to no window at all.

`registry.busDeclaredFrames()` now reads board webviewIds AND id files. Three consequences:
- a declared OWNER frame is that project's orchestrator candidate regardless of attribution;
- a declared WORKER frame holds its role above any content guess (a bystander printing
  `worktrees/developer` can no longer take it);
- the line-2 guard is honoured, but only on an IDLE tab — on a working one the sign-off scrolls out of
  the virtualized DOM and a guard check false-refuses a correct id (the bus found this itself).

Declarations are CONTESTED across buses: `Gaming/*.id` and `ReciEats/*.id` carry the same two
webviewIds, because the ReciEats bus was copied from Gaming's. Attribution breaks the tie, and when it
is silent the freshest `<role>/status.json` does — Gaming's productowner mailbox was last written
2026-07-11, ReciEats' minutes ago. `./live.sh` warns on every contested declaration; the real fix is
deleting the stale copies.

**The testing lesson, again, one level up.** The 0.20.0 fixtures did not catch this because they were
captured THROUGH THE CODE'S OWN LENS: the bus snapshot recorded `boardOwnerFrames()`, which did not
read id files, so the fixture encoded the blind spot. The new invariant is derived from the bus
instead — *a project whose orchestrator mailbox was written recently must have an offerable
candidate* — in both `live.sh` and the fixture suite. Capture now snapshots the id files and the
mailbox mtimes as well.

**`test/mutation.py` destroyed uncommitted work** the first time it ran here: it restores each mutant
with `git checkout -- src/`, which cannot tell a mutation from work in progress. It now refuses to
start when `src/` is dirty. Commit before running it.

## The lesson worth keeping

The suite is at ~95% of lines and **caught none of the four defects found this week.** It could not:
every fixture was written from the same model of the world as the code, so where the model was wrong
the tests agreed with it enthusiastically. Board fixtures always listed the role the test then
tagged; every test supplied one window's frames; every test's orchestrator frame carried a
`LOOMROLE=` sign-off that real ones do not have.

Coverage says which lines ran. It cannot say which realities were considered. So:

- `./live.sh` asserts invariants against the **running** editor and the real bus. Run it after any
  change, and before believing anything works.
- When a fixture encodes an assumption, go measure the real thing first. Every constant in this
  codebase has its measurement in the comment beside it — keep that up.

---

## Verifying and working on it

```bash
cd /home/aneesh/vs_code_extensions/loom-session-tracker
npx tsc -p .        # or: ELECTRON_RUN_AS_NODE=1 /usr/share/codium/codium node_modules/typescript/bin/tsc -p ./
./test.sh           # 349 checks; ./test.sh <filter> to narrow
./live.sh           # invariants against the live editor (read-only)
rm -rf /tmp/cov && NODE_V8_COVERAGE=/tmp/cov ./test.sh && python3 ../tools/coverage.py /tmp/cov out
cd .. && ./deploy.sh loom-session-tracker    # then reload the window
```

There is **no `node` on this machine** — everything runs under VSCodium's bundled one, which is what
`test.sh` and `live.sh` do. Tests force `HOME` to a throwaway directory and can never touch the real
bus.

**Never `pkill -f "remote-debugging-port=..."`.** It matches the editor's own main process and has
taken down every window three times. Kill by PID or by a unique `--user-data-dir`.

---

## 0.17.x — the read-side half of project-scoped names (2026-09-09, late)

After the IDE restart, livegita's window classified Gaming's restored developer tab (`132f0ce0`, 86%
Gaming paths, marker scrolled off) as livegita's `developer` by path — both rosters carry the name —
and typed livegita's `[loom-resume]` into it. That is the 2026-09-08 LG-001 misroute, reproduced.
Three things now hold: a signing marker (1.2) outranks path evidence (≤1); a frame whose dominant
paths belong to another bus is never this window's worker; and limit/model nudges are dispatched
only for SIGNED or BOUND agents — a path-only agent is shown and watched but never typed into.
Tried and removed the same night: a SELF_RE-style "discusses Loom internals ⇒ not a worker" rule.
Every real worker runs `ls ~/.claude/loom` at bootstrap, so it excluded the genuine developer.
Residual, documented in tracker.ts: a session that PRINTS another role's sign-off on its own line
(test fixtures, grep output) reads as signed. Don't print `LOOMROLE=` lines in diagnostic sessions.

## 0.19.0 — the restart path (2026-09-09, user direction)

After a window reload, Claude Code restores every Claude tab BLANK (measured: 12 of 25 frames were
empty shells). The user's instruction, verbatim in spirit: "remember their loom role, rebind them on
restart, then wake the PO to continue the work." So `src/reopen.ts` + `extension.ts`:
- `previouslyLive(repo)` = roles in the bus's `targetmap.json` + `bindings.json`, read BEFORE the
  first tick rewrites them — the record of who was open, not who the board has ever known.
- 30 s after activation (restored shells are still rendering during the first tick), every such role
  that is now missing is reopened from its FRESHEST transcript THAT THIS WINDOW CAN RESUME (board sid
  vs newest in the role's worktree project dir — the board sid is sometimes stale; a transcript under
  another cwd opens blank and is skipped, `tracker-debug.json` lists it as `restartStranded`), plus
  the orchestrator always.
- Once the tag resolves to a live frame again, `[loom-restart]` is injected into it, once.
- `loomSessionTracker.autoReopenOnRestart` (default true) turns this off. This is the ONE exception
  to the 2026-07-12 rule that Loom never opens or closes Claude tabs on its own; it still never closes.
- Outside the restart path, a persistent status item "Loom: reopen N" offers the rest on a click.
Caveat inherited from Claude Code: a session hidden via the picker can never be resumed by id.

## 0.19.1/0.19.2 — why the model policy never worked (2026-09-09, late)

"Are you sure your model change command is working?" It was not, for two independent reasons, both
measured on the live editor rather than reasoned about:

1. **Busy composers swallow commands.** A `/model` typed while the target is mid-turn is queued as a
   message and never executes. The real worker took 9 injections and produced 0 "Set model" lines.
   `tracker.busyRoles` now withholds mid-turn roles from the policy entirely — no violation, no
   attempt, no backoff growth — judged on the first idle tick instead.
2. **The policy was aiming at the wrong session.** A diagnostic session that merely PRINTED
   `worktrees/developer` paths took Gaming's `developer` by path and absorbed 38 `/model`
   injections. Two holes let it: `attributeRepo` returned NULL for it (0.77, under the 0.8
   threshold) and the 0.17.0 rule only rejected frames attributed to a DIFFERENT repo; and path
   evidence ranked equal to a sign-off. Now: path evidence counts only when the frame's dominant
   project paths agree with the window's project, and a frame attributed to another project is
   never this window's worker whatever it signs (a marker names the ROLE, not the PROJECT — both
   Gaming and ReciEats have a `developer`). An UNattributed sign-off is still trusted: that is a
   fresh session right after `/clear`.

Simulated after the change: Gaming claims nobody (its developer's session is not open), ReciEats
claims 849774ff, livegita 45962fe2, funisland gamification. The diagnostic session is nobody's worker.

## Open threads (2026-09-13)

- **0.32.0's companion edits are outside git** — playbook §17 (`~/.claude/loom/ORCHESTRATION-PLAYBOOK.md`)
  and the ReciEats and livegita orchestrator memory files on the bus were patched by hand. Every
  window still needs a reload to be on this build. funisland's copy of the loom skill is still
  uncommitted in funisland's own repo.
- **Audit 2026-09-13 (two Explore agents, all seven projects):** no project doc told the orchestrator
  to refresh its own `board.json` session_id after a clear; every one teaches rebinding WORKERS. The
  shared loom skill said "bind once, never rebind" — now qualified (global copy and funisland's copy,
  the latter uncommitted in funisland's repo). Repaired by hand with `rebindSession`: Lumen
  (75e42c92), ReciEats (d4452a2b; its state pointed at a third id), livegita (`po` entry had no
  session_id at all; c55cf44e), shwab_docker (tag pointed at the QUANT frame 32da9c83 — 15 aborted
  cycles; re-tagged to 4fedfbea / transcript 907775cc, backups beside orchestrator.json and
  productowner.id; `bindings.json` still maps dead 972792b0 → productowner). tfg_ua was correct.
  Gaming's bus is abandoned/cross-wired (board sid has no transcript; its productowner.id is
  ReciEats' frame) and funisland's board has NO owner entry — `rebindSession` leaves both alone.
- **Windows on old builds** — `./live.sh` names them; 0.29.0 needs a reload per window. Until the
  ReciEats window reloads, its PO's `open-requests.json` for developer1 is refused "already live"
  (Lumen's developer1 claimed cross-window — fixed in 0.28.0, not yet loaded there).
- **`Gaming/developer1.id` and `Gaming/productowner.id` are stale copies of ReciEats'** — delete them
  (user's call). `live.sh` warns on every contested declaration.
- **Blank `Untitled` shells after every restart** — Claude Code's restore discards the session id.
  Left in place on purpose (principle 5). `blanks.ts` identifies them for a future tabGroups close.
- **`~/.claude/settings.json` now pins `claude-opus-5`** (changed 2026-09-13, backup beside it as
  `settings.json.bak-<epoch>`). Running sessions keep their model; restarted ones come up on Opus and
  the tagged orchestrator is promoted by the policy. First real restart should be watched.
- **Blank `Untitled` tabs already open** (ten at 2026-09-13 05:55) must be closed by hand; the cause
  (principle 11) is fixed in 0.30.0, but every window must RELOAD to run it.
- **The context-memory cycle completed end to end on a real session — fourteen times in one night,
  wrongly** (Lumen, 2026-09-13 00:13–04:21, one per 15 m cooldown, on a 57% estimate off a dead
  transcript). Fixed in 0.30.1 (panel-silence veto, dead-transcript rule, newest-copy lookup);
  Lumen's `context-state.json` was pointed at the live transcript by hand to stop it. Lumen's
  `board.json` still names the dead PO session 64938df2 — the PO should rebind (`/loom productowner`).
- `gaming` (lowercase) is a stale duplicate bus of `Gaming`; 16 board session_ids point at nothing.
- Model policy and limit resume have no cross-window lease (the context cycle does).

## How the person running this works

Act on well-evidenced decisions in the same turn rather than asking: build, test, commit on `main`
in the repo's existing style, push, and deploy with `deploy.sh` — those are the endpoint of the
work, not separate decisions. Confirm only for genuinely destructive or irreversible things
(deleting data or worktrees, force-pushing, rewriting history, anything that leaves the machine).
Commit messages here are long and explain what was measured and why; match that.
