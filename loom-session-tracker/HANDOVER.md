# Handover — loom-session-tracker

Written 2026-09-09 so a fresh context can pick this up without the conversation that produced it.
Read this, then `README.md` (what the extension is and how to use it), then run `./live.sh`.

If you are the orchestrator being restored by this extension's own memory cycle: this is the same
idea, done by hand. The state below was true when it was written; **verify it, do not trust it.**

---

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
  that is now missing is reopened from its FRESHEST transcript (board sid vs newest in the role's
  worktree project dir — the board sid is sometimes stale), plus the orchestrator always.
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

## Open threads

- **MIGRATION TO THE FOUR ROLES is undecided in scope.** The vocabulary (product-owner / developer /
  designer / monetization) is declared and reported by `./live.sh`, but only livegita is near it (3/4).
  funisland 1/13, Gaming 2/6, shwab_docker 1/7 — real, distinct, live agents. Renaming live mailboxes
  is a per-project decision to take when that project's sessions are idle. livegita's own path:
  `gitadeveloper/` -> `developer/` (session must stop writing to the old dir first), `po/` ->
  `product-owner/` (then `naming.json` `owner` can go), drop the empty `productowner/`.
- **livegita migration is STAGED, not run:** `~/.claude/loom/livegita/migrate-to-four-roles.sh` refuses unless developer/gitadeveloper/po are idle (verified: exits 3 while the developer works LG-047), backs up the bus, folds `gitadeveloper/`→`developer/`, renames `po/`→`product-owner/`, drops empty `productowner/`, rewrites board/bindings/targetmap/orchestrator/naming/state. After it runs, re-bind the developer with `/loom developer --repo livegita` so it signs its real name.
- **`loom_cdp.py` `--repo` is optional at the CLI.** The extension always passes it; a hand-typed
  `inject --role developer` with no `--repo` is refused as ambiguous. That is the intended failure.

- **The three stale tags** above — one click each, in the right window. (livegita's is now correct:
  `po @ f13a5e27`, reading 60% off the panel.)
- **`livegita/productowner/`** is an empty duplicate mailbox the PO session created for itself at
  17:40 on 2026-09-09, with a board note saying "rings go to po/ — this dir is an alias". The bus's
  `naming.json` pins `"owner": "po"`, so nothing is confused by it; retire the directory once that
  session stops writing its status there.
- **`livegita/gitadeveloper` vs `developer`** — aliased to one identity for CLASSIFICATION only; both
  mailboxes are still watched, because the live session writes to `gitadeveloper/` and was mid-task.
  Retire the directory when it is idle. NOTE the tension recorded in `loom_cdp.py`: `gitadeveloper` was
  project-prefixed ON PURPOSE, because a bare `developer` collides across buses and that collision
  misrouted LG-001 into the ReciEats PO tab on 2026-09-08. `loom_cdp.py`'s `KNOWN_ROLES` is a FLAT
  global set, so the prefix still earns its keep there. Nothing was changed about what the session
  signs, and bare `developer` was NOT added to `KNOWN_ROLES`.
- ~~**`livegita` has no offerable candidate**~~ — SOLVED 2026-09-09, and the earlier diagnosis in this
  document was wrong. It was not "dominated by `worktrees/developer` paths". Two separate faults:
  livegita spells its orchestrator `po`, which was in none of the four hardcoded owner sets; and its PO
  tab quotes its single developer's sign-off, which `detectOwner`'s `>=3 distinct roles` test can never
  catch on a one-worker team, so the PO was classified AS the developer and beat the real developer's
  frame on text length. Fixed by `src/naming.ts` (one owner contract, shared with `loom_cdp.py`) and
  `registry.boardOwnerFrames()` (the board declares the PO's `webviewId`; it beats content detection).
- **The cycle has never completed end to end on a real session.** Every stage is tested and the
  refusals are proven, but no orchestrator has yet banked, cleared and restored for real. The first
  one to watch is funisland at 88%.
- **`gaming` (lowercase) is a stale duplicate bus** of `Gaming`; the digest reports the role-name
  collisions. Nobody has decided whether to retire it.
- **16 board `session_id`s point at nothing** — worth a pass over the boards.
- **Model policy and limit resume have no lease**, unlike the context cycle. They are idempotent
  nudges rather than destructive, so two windows doing them twice is noise, not damage — but it is
  the same class of bug if that ever changes.

---

## How the person running this works

Act on well-evidenced decisions in the same turn rather than asking: build, test, commit on `main`
in the repo's existing style, push, and deploy with `deploy.sh` — those are the endpoint of the
work, not separate decisions. Confirm only for genuinely destructive or irreversible things
(deleting data or worktrees, force-pushing, rewriting history, anything that leaves the machine).
Commit messages here are long and explain what was measured and why; match that.
