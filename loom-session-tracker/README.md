# Loom Session Tracker

A VSCodium/VS Code extension for running **many Claude Code sessions as a team** on one machine.

If you use the Loom pattern — several Claude conversations open at once, each bound to a named
*role* (`developer`, `qa`, `curriculum`…), handing work to each other through a file bus at
`~/.claude/loom/<project>/` — this extension is the instrument panel for it. It watches every
session over the editor's own debug protocol and answers the questions you would otherwise be
answering by hand, or not at all:

- which tab is which role, right now, and is it still alive?
- did anything finish while I was looking elsewhere?
- is something stuck pretending to work?
- how many sessions am I actually running, across every window?
- is my orchestrator about to run out of context?

Everything it watches is read-only. The handful of things that change something — closing a
session, deleting one, clearing a context — are either an explicit click or a cycle with a written,
verified safety rule for each way it could destroy work.

---

## Requirements

| | |
|---|---|
| Editor | VSCodium or VS Code 1.85+, launched with `--remote-debugging-port=<port>` |
| Claude | The Claude Code extension (`anthropic.claude-code`), signed in |
| Bus | `~/.claude/loom/<project>/board.json` — the Loom file bus, one directory per project |
| Injector | `~/.claude/loom/loom_cdp.py` + `python3` — used to type into a session's composer |
| Runtime | `ws` (bundled); TypeScript to build |

The debug port is what makes any of this possible: it is how the extension reads the text of every
Claude panel in every window. It discovers the live port from the editor's own
`DevToolsActivePort` file, so you do not configure it — but the editor must have been started with
the flag. On this machine that is port **9333** (9222 is deliberately left to browser automation).

> **Never kill processes by matching that port.** `pkill -f "remote-debugging-port=9333"` matches
> the editor's own main process and takes down every window. Kill by PID or by a unique
> `--user-data-dir` instead.

---

## Installing

From the repo root:

```bash
cd loom-session-tracker && npm install && npx tsc -p .   # build out/
cd .. && ./deploy.sh loom-session-tracker                # copy + register + tell you to reload
```

Then reload the window (`Developer: Reload Window`). `deploy.sh` copies the built extension to
`~/.vscode-oss/extensions/local.loom-session-tracker-<version>/` and adds the matching entry to
`extensions.json`; there is no marketplace involved.

No npm on this machine? The suite and the live check run under the editor's bundled node
(`./test.sh`, `./live.sh`), and `out/` can be copied from a previous install.

---

## First five minutes

1. **Open a project window.** The project id is `basename(dirname(git rev-parse --git-common-dir))`
   — the same id the Loom skill uses, so a *worktree* window still resolves to the parent project.
   It must match a directory under `~/.claude/loom/`.
2. **Open the Loom Sessions view** (broadcast icon in the activity bar). Within one tick (15s) you
   should see your project with its live roles beneath it, each showing `● live` and a short frame
   id. The status bar shows `Loom: 2/5 · 11 open` (the denominator is `maxActiveSessions`, default 5).
3. **Tag the orchestrator.** The session you drive the others from appears as a candidate —
   `● possible orchestrator — click ★ to tag`. Click the star. Nothing else in the extension is
   *required*, but almost everything interesting is gated on it: finish notifications, stall
   alerts and the context-memory cycle all need to know where to talk.
4. **Run the startup digest** (checklist icon, or `Loom Sessions: What Needs Me?`) to see what has
   been sitting unattended.

If a role's session does not appear, it is usually because its tab has not said anything
identifiable yet — bind it with `/loom <role>` in that session and it will be picked up on the
next tick.

---

## What it does

### The live map

Every 15 seconds it reads the text of every Claude panel in every editor window and works out which
session is which role, from two independent signals: the `LOOMROLE=<role>` sign-off a role writes,
and the worktree paths its output is full of. A role's binding survives a tab that has scrolled its
marker out of view, and a failed read never wipes the map — sessions go `○ stale` rather than
vanishing. The result is published to `~/.claude/loom/<project>/targetmap.json`, which is what
`loom_cdp.py` uses to aim an injection at the right tab.

### Simultaneous session count

The per-project counter cannot see other windows. This one counts every Claude conversation open
across the whole editor and publishes it to `~/.claude/loom/active-sessions.json`, highlighting the
status bar past `sessionWarnThreshold`. Anthropic caps no session count, but they all draw on one
usage pool.

### Finish notifications

When a worker's `status.json` goes from working to `idle`/`blocked`, the tagged orchestrator gets a
`[loom-notify] …` prompt telling it whose outbox to read. State lives on the bus, so a finish that
happened while the editor was closed is still announced, and two windows watching one project
cannot both announce it.

### Stall watchdog

The finish notifier only ever sees a *transition*. A role that goes `working` and never comes back
is invisible to it — one had been "working" for 1,681 hours. The watchdog flags any role working
with no status update for `stallMinutes` (45 by default), warns you, and tells the orchestrator
once per stall. It also reports statuses outside the protocol (`idle|working|blocked`) and
`updated_at` fields that have stopped being maintained.

### Usage-limit auto-resume

When a session is blocked by a usage limit, the tree shows it paused with the limit and ETA. The
resume fires when the limit banner *clears* — an exact signal — not on the UI's coarse "resets in
2h" estimate, and only after it stays clear for consecutive ticks. Pending resumes survive a
restart.

### Model policy

The top pricing tier is reserved for the orchestrator. A worker found on a premium model is
switched back with `/model <workerModel>`, and stays pending until it is actually *seen* on a
cheaper model — a switch that silently fails is retried on a growing backoff rather than forgotten.

The footer chip lags the switch. Measured 2026-09-13 on ReciEats/developer2: `/model claude-opus-5`
printed "Set model to Opus 5 for this session only" at once, the chip still read "Fable 5.1" a minute
later, the policy typed the command again, and the chip only flipped when the session's next turn
began. So the panel is read for that acknowledgement: a `You: /model …` echo followed by
"Set model to <name>" with no later turn means the switch took, and the role is left alone until the
chip catches up. An old acknowledgement (a later turn, a resumed session) does not count — the chip
is the truth again.

The mirror holds too. `~/.claude/settings.json` pins the default model to the worker tier, so every
spawned or restored tab starts cheap; the TAGGED orchestrator, when its own frame is seen idle on
anything else, is switched to `orchestratorModel` (`claude-fable-5-1[1m]`) with the same backoff and
the same acknowledgement rule. Setting: `enforceOrchestratorModel`. Only the orchestrator is ever on
the premium tier; nothing else is promoted.

### Per-handoff model (MP-001)

Workers do not all need the Opus tier. The **orchestrator judges difficulty as it writes a handoff**
and records that judgement in the handoff's own frontmatter; the **tracker enforces it**; a
**ledger** records what each choice actually cost, so the rubric can be judged on evidence rather
than on feel. The orchestrator switching *itself* is not part of this — that is
`enforceOrchestratorModel`, above, and it is unchanged.

```markdown
---
id: MP-001
from: productowner
to: developer2
model: claude-sonnet-5      # ← the only new field
---
```

**The allowlist.** `workerModels` (default `["claude-opus-5", "claude-sonnet-5"]`) is the set of
tiers a worker may be put on. Haiku is deliberately out. The **premium tier stays orchestrator-only
whatever this setting says**: a premium id in a frontmatter is refused on the model table, not on the
allowlist, so widening the setting cannot open the top tier to a worker.

**A frontmatter the tracker cannot read changes nothing.** No inbox, no `---` block, a block that is
never closed, no `model:` line, a `model:` line in the body rather than the frontmatter — each falls
back to `workerModel`. The two cases that are a *request* rather than an absence — a premium id, an
id outside the allowlist — are ignored **and say so** under `model.frontmatterIgnored` in
`tracker-debug.json`. (An ignored request that is silent is indistinguishable from one that worked;
see principle 16.)

**Enforcement runs both ways.** A worker on Opus whose handoff asks for Sonnet is switched *down*; a
worker on Sonnet whose handoff asks for Opus, or says nothing, is switched *up*. Same rules as the
premium policy: only into an **idle** composer (a `/model` typed mid-turn queues as an ordinary
message and never runs), only into that role's **own frame**, same growing backoff, same
acknowledgement handling. A **target change restarts the backoff** — otherwise a role that had
backed off to the 15-minute step would sit on the wrong tier for a quarter of an hour after its
handoff asked for a new one.

**A spawned tab is put on its tier before it is bound.** `serveOpenRequests` types
`/model <desired>` into the new frame and waits, bounded by `modelAckMs` (8 s), for the session to
acknowledge it — *then* types `/loom <role>`. The order is the whole point: the bind runs the inbox
check, and from that moment the composer is busy, so a `/model` sent second would never execute.
Nothing is typed when the handoff wants the configured default, since a fresh tab already starts
there. **The bind is never conditional on the switch**: if the acknowledgement does not arrive the
tab is bound anyway and the tier is left to the next idle tick — a worker on the wrong model gets
corrected, a worker that was never bound just sits there.

**Escalation.** A role that reports `blocked` — what the `/loom` skill has a worker write when it
raises a loop-back — **twice on the same handoff** while on Sonnet has that handoff's `model:` line
rewritten to `claude-opus-5` (atomically, that line only, and only while the file's `id:` still
matches, so the *next* brief's deliberate Sonnet is never raised by the last one's loop-backs).
R2's next idle tick performs the actual switch. A third loop-back does not rewrite again. A report is
counted once: `status.json` is re-read every tick, so a new report means a new `updated_at`.

**The ledger.** `~/.claude/loom/<repo>/model-ledger.jsonl`, append-only, one line per
(role, handoff id), written when the handoff id changes or the role reports idle having handled it:

```json
{"id":"MP-108","role":"alpha","model":"claude-opus-5","chosenBy":"escalated","started":"…",
 "finished":"…","loopBacks":2,"testsBefore":563,"testsAfter":592}
```

`chosenBy` is `frontmatter` (the orchestrator chose), `default` (it did not) or `escalated` (the
tracker overrode it). A line that cannot be completed is written **with nulls, not skipped** — a
missing line is invisible, and the gap would bias exactly the comparison the ledger exists to make.

### Orchestrator context memory

The orchestrator is the session that actually fills up: it runs for days across every role. Left
alone it hits auto-compaction — a summary it did not choose, did not review and cannot re-read.

Past `contextThresholdPct` (30% — lowered from 50% on 2026-09-13: one day measured 2.93 billion
cache-read tokens across all projects at 238k of context per turn, and the orchestrators' context
length was the cost) this extension makes that deliberate instead:

1. **Bank** — the orchestrator is asked to write its working memory to
   `~/.claude/loom/<project>/<role>/memory.md`: what it is doing, what each role owes it, decisions
   already made, open questions, and an UNSURE section. Under 12 KB, because every fresh context
   re-reads it; durable lessons go to `<role>/notes.md`, appended rarely and read once per restore.
2. **Clear** — `/clear`, but only once that file is verifiably on disk.
3. **Restore** — a prompt into the fresh context: read the memory, the notes, the board and each
   role's status, then only the docs the memory names, and reconcile them so the memory stays true.
   The prompt also forbids watchers, Monitors and `/loop` in the orchestrator's session: the tracker
   wakes it (playbook §17), and a wake re-reads the whole context.
4. **Rebind** — `/clear` gives the orchestrator a new session id. The extension, having seen the
   fresh transcript appear, writes that id into the orchestrator's `board.json` entry itself
   (`session_id`, `rebound_by`) before the restore prompt goes out, and the prompt asks the
   orchestrator to confirm it against `$CLAUDE_SESSION_ID`. A stale id reads as a dead, still-full
   transcript — the fourteen-clear night.

The percentage comes from the panel's own compact button (`73% context used — click to compact`),
which the app renders only past 50% used. The session's transcript (its last `usage` block) gives
the token count and the session's identity, and is the estimate when the panel cannot be seen or the
threshold is below 50. It never overrules a panel that can be seen: a rendered conversation with no
button *is* under 50%, whatever a transcript says. Measured 2026-09-13, 00:13 to 04:21: Lumen's
orchestrator was banked, cleared and restored fourteen times, once per cooldown, on a 57% estimate
read off a transcript the session had stopped writing days earlier — the panel-emptied witness had
kept the old session id, that id also had a stale copy under Gaming's project directory, and the
fresh panel showed no button every time. Three rules came out of it: the panel's silence vetoes the
estimate; a known transcript older than the last completed cycle is dead, and only a transcript
written since the clear (or nothing) is read; and a session id present in several project
directories is read from the copy still being written.

`/clear` is irreversible from inside a session, so it is sent **only** when: the memory file exists,
is newer than the moment it was asked for, and is more than a stub; the session is not mid-turn; and
the frame was actually seen this tick. If the file never appears, the cycle aborts and clears
nothing. One window drives a cycle at a time (a lease on the bus), and a cycle is pinned to the role
and file it began with. `Loom Sessions: Bank Orchestrator Memory & Clear Context` runs one on
demand.

### Startup digest

On activation: responses sitting unpicked-up, roles blocked on a decision or by a usage limit,
workers on the premium model, unbanked worktree changes, roles whose session is not open, stalled
roles, and whether an orchestrator is tagged at all — with one-click **Tag orchestrator** and
**Reopen sessions**.

### Garbage collection

Nothing else here looks **across** projects at what has stopped being used. Measured on this machine
2026-09-13: **34** deployed extension versions (99 MB, one in use); **2.4 GB** of transcripts, 931 of
them untouched for 14 days; funisland with **75** worktrees of which **72** belong to no board role
(4.7 GB), Gaming 13 of 8; boards naming dead sessions (Gaming 5 of 6, lowercase `gaming` 10 of 10,
shwab_docker 1); **1.4 GB** of checkpoints; **19** `.bak-<epoch>` files.

The bytes are not the point. An orphan worktree or a dead board id **feeds back into an
orchestrator's context** — one `git worktree list` of funisland fills a panel, and the context is
re-read every turn — and a dead transcript is a wrong-lookup hazard: Lumen's orchestrator was banked,
cleared and restored fourteen times in one night against a stale copy of a transcript that was
sitting in Gaming's directory. Garbage here is not waste, it is misinformation.

**Nothing is ever deleted, at any tier.** Every action is a move into
`~/.claude/loom/_archive/<date>/`, a `git worktree remove` that keeps the branch and its commits, or
a field added to a board entry — and every one is logged with its way back in
`~/.claude/loom/gc-debug.json`. A cross-device move copies, verifies the byte total and only then
releases the source; a verify that fails — or that cannot be trusted because the walk hit its budget
— takes the half-written destination with it and leaves the original alone, because a truncated
archive that looks complete is worse than no archive.

**A plan is a guess about a moment that has passed.** It is shown to a person, who reads it and
clicks, and in that window a session can start, a tree can go dirty and a board entry can be
rewritten by another session. So every safeguard is checked again at apply time, against the world as
it is then — live roles, live session ids, merge state, and whether the board entry still names the
session the plan judged.

**`gcEnabled` is `false` in 0.33.0.** The first pass on a machine that has never had one moves
hundreds of megabytes unattended. Run `Collect Garbage (across projects)` → **Show plan** → **Run
tiers 1+2** once by hand, then turn it on.

**Tier 1 — automatic, no confirmation, always reversible.** Runs once per `gcIntervalHours` per
*machine* (one window at a time takes a lease in `gc-state.json`, exactly as the context cycle does,
so seven open windows do not race; the claim is refreshed at half-life so a long pass cannot expire
under its own holder, and a timestamp in the future is treated as expired rather than as fresh). It
runs on the interval, not only at activation.

* Deployed builds under `~/.vscode-oss/extensions/local.loom-session-tracker-*` other than this
  window's version, **every** version registered in `extensions.json`, and **every version any window
  is still running** per `running-versions.json`. An editor keeps the code it loaded until it is
  reloaded: measured 2026-09-13, the registry said 0.32.0 while *nine* windows were on 0.29.0, so
  registry-alone would have pulled the extension out from under nine live editors. If
  `extensions.json` cannot be read, or this window's own version is not a semver (the `unknown`
  case), the whole extension tier is refused. A window that is OPEN but whose extension host has
  wedged stops stamping, and after `gcIntervalHours` its build reads as nobody's and is archived in
  tier 1 — under a running editor; reload such a window rather than leaving it sitting there. (A
  stamp entry whose `at` will not parse is dropped for the same reason: nothing could ever age it
  out, so it would pin its build in the keep-set permanently.)
* Transcripts older than `gcTranscriptDays` that **nothing references**, that are **not the newest in
  their project directory**, and that are **not a live role's session**. "References" means: any board
  `session_id` (nested or flat), any `context-state.json` sessionId, any role's `status.json`
  session id, any `open-requests.json` `opened[].sessionId`, and — the catch-all — any 36-character
  session id appearing in any `*.json`/`*.md` under `~/.claude/loom` (bounded by file size and count).
  Those bounds are ALL-OR-NOTHING and sticky: if the sweep gives up early — too many files, too deep,
  or one `.md` over 8 MB — the **whole transcript tier is refused** until that stops being true, with
  only a line in the plan's notes to say so. One oversize banked handover switches the tier off.
  Buses **without** a `board.json` are scanned too: four of them hold a `context-state.json` naming a
  live session. A session's `<sid>/subagents/` tree moves with it or not at all.
* `*.bak-<epoch>` files under `~/.claude/loom` older than `gcBackupDays`, judged by the epoch in the
  name rather than an mtime a later copy may have refreshed.

**Tier 2 — one click, reported in the digest.** Only from the digest action or the command, after a
confirmation naming the counts.

* Worktrees under `<repo>/.claude/worktrees/<name>` where the name is on no board role **and is not
  an alias of one** (a bus renames roles in `naming.json`; livegita's `worktrees/developer` belongs to
  `gitadeveloper`), the branch is **fully merged** into the default branch, and the tree is **clean**.
  A name that is within one or two edits of a real role is somebody's typo — `Gaming/protyping` for
  `prototyping` — and drops to tier 3 rather than being offered. Removal goes through the same
  `removeWorktree` safeguards the cleanup report uses (nothing dirty, rostered, live, detached, or
  holding gitignored files git cannot restore). **This is the one action here that deletes**: the
  branch, its commits and a restore command in `worktree-removals.json` are kept, but the working
  directory goes, and with it anything git was never told about. The guard that actually decides is
  the **roster**, not liveness: a worktree is a candidate only when its name is on no board entry and
  owns no mailbox (`status.json`/`inbox.md`/`outbox.md`) on its project's bus — at any age, however
  long ago that role last wrote.
* Board entries whose `session_id` has no transcript anywhere get `"status": "dead"` and a dated
  `gc_note`. The entry is never removed, an owner role is never touched, and a role with a live tab
  is never touched (a fresh session's board id lags its transcript by seconds).

**Tier 3 — a person decides; the digest lists them and nothing acts.** Buses untouched for
`staleBusDays`; owner `.id` files pointing at a frame another bus also declares (this is how
ReciEats' orchestrator came to be offered in Gaming's sidebar); orphan worktrees that are unmerged or
dirty — funisland's live here until someone looks at them; and `~/.claude/checkpoints`, reported by
size only, because there is no retention policy for those yet and inventing one quietly is how work
gets lost.

Settings: `gcEnabled` (false), `gcIntervalHours` (24), `gcTranscriptDays` (14), `gcBackupDays` (7);
tier 3's bus staleness reuses `staleBusDays`. `./live.sh` prints the current dry-run plan counts, and
`Collect Garbage (across projects)` always offers **Show plan** before **Run tiers 1+2**.

### Session lifecycle

Spawn a session for a role, retire one (which names its tab for a person to close — Loom never
closes a tab itself), lock one against deletion, or delete a role's
artifacts entirely. Every destructive path refuses first: the orchestrator can never be closed or
deleted, a locked role cannot be touched, a role must be a *confirmed live agent of this project*
to be retired, and a delete refuses if the worktree has unbanked work — with a two-step
confirmation and a typed name.

### Worktree cleanup

Lists every worktree under `<project>/.claude/worktrees/` with its branch, orphaned/dirty/live
flags and unmerged-commit count. Removal deletes only the checked-out directory — branches and
commits are kept — and each removal is logged with its exact restore command to
`~/.claude/loom/worktree-removals.json`. It refuses anything dirty, still on the board, backing a
live session, on a detached HEAD, or holding gitignored files git cannot give back (`.env`, keys,
`*.sqlite`).

---

## Naming roles

One canonical orchestrator id: **`product-owner`**. Nothing in the code compares a role name against a
literal — everything asks `isOwnerRole()` in [`src/naming.ts`](src/naming.ts), which accepts every
spelling in `OWNER_ALIASES`: `product-owner`, `productowner`, `product_owner`, `po`, `owner`,
`orchestrator`, `pm`.

This matters more than it looks. Before 2026-09-09 the owner set was hardcoded in four places
(`roles.ts`, `coordinator.ts`, `orchestrator.ts`, and twice in `loom_cdp.py`) and `po` — livegita's
actual board key and mailbox — was in none of them. Its orchestrator was therefore classified as an
ordinary **worker**, which meant it was never offered as a tag candidate *and* was a legal
spawn/retire/delete target: the boundary that exists to make the orchestrator undeletable had a hole
in it for one project. `loom_cdp.py` now reads the same table from `~/.claude/loom/naming.json`, which
this extension publishes on activation, so the two cannot drift.

**Adding a spelling** is a one-line edit to `OWNER_ALIASES`. Do that rather than letting a bus invent
a name nothing recognises — `./live.sh` fails loudly on an owner-looking role the contract rejects.

### Per-project naming lives on the bus

`~/.claude/loom/<repo>/naming.json` — no rebuild, no redeploy:

```json
{
  "owner": "po",
  "aliases": { "gitadeveloper": "developer" }
}
```

- **`owner`** — which mailbox is this project's real orchestrator, when the bus has more than one.
  livegita has both `po/` (42 KB inbox, queued tickets, tools) and an empty `productowner/` the PO
  session created for itself; only the project can say which is real.
- **`aliases`** — two names for one agent, collapsed. An alias must point at a role that already
  exists on the bus, and resolution is one step only, so it can never loop.

Alias direction is deliberate: **collapse into the name that has a worktree.** `gitadeveloper` folds
into `developer` because `worktrees/developer` is a real path, so the surviving name resolves from
*either* signal. The other direction would leave a role identifiable only by a `LOOMROLE=` marker that
scrolls out of the panel — which is exactly why livegita's one developer read as two different agents
depending on what was on screen.

Mailbox directories are never renamed by any of this. Every `loom/<repo>/<role>/status.json` path
keeps working, and `ownerRoleFor()` follows a bus that later renames itself to the canonical id.

### Role names are project-scoped, and there are four of them

The bus directory namespaces role names, so every project uses the **same** vocabulary and nothing
needs a project prefix:

| role | job |
|---|---|
| `product-owner` | orchestrates; banks, never edits |
| `developer` | builds |
| `designer` | design |
| `monetization` | revenue |

That is only safe because resolution is scoped. `loom_cdp.py`'s `_role_repo()` used to resolve a bare
name by scanning every board and taking the first hit — `sorted()` puts `Gaming` before `livegita`, so
`/loom developer` in livegita wrote its binding onto **Gaming's** bus. That was the 2026-09-08 LG-001
misroute, and the only reason livegita's developer was ever renamed `gitadeveloper`. Two such
collisions were live on 2026-09-09: `developer` (Gaming + livegita) and `productowner` (Gaming +
shwab_docker).

Now every role operation takes `--repo`. The extension passes it on every path that targets a role
(finish notifier, stall alert, context cycle, model policy, limit resume) — one project per editor
window, so the window always knows. Without `--repo`, an ambiguous bare name is **refused** with the
list of buses that carry it, instead of guessed. The targetmap is scoped the same way, so a `/model`
nudge aimed at livegita's developer cannot land in Gaming's.

The vocabulary is a **target, not a gate**: nothing renames a mailbox or refuses an off-list role.
`./live.sh` reports each bus's distance from it (`INFO`), so a migration is a visible decision.
funisland runs 13 genuinely distinct agents; collapsing that is not a cleanup.

### The board outranks the tag

The sidebar once offered a *diagnostic* session as livegita's only orchestrator candidate — twice in
one evening it got starred, and the finish notifier typed a developer's loop-back into it. When a
board declares the PO's frame, that frame is the only candidate shown, and it is the frame the cycle
uses even if the tag points elsewhere; a misclick cannot override the board.

### Finding the orchestrator's tab

The orchestrator quotes its workers' `LOOMROLE=` sign-offs, so content detection calls it a worker
unless it quotes **three distinct** roles. A project with one or two workers can never reach three —
livegita's PO quoted a single `LOOMROLE=gitadeveloper` and was read as the developer, then beat the
real developer's frame for that role on text length (159 KB vs 57 KB). The sidebar was showing the
orchestrator's tab *as* the developer, which is how a hand-tag came to write `{"role":"gitadeveloper"}`.

So the **board is authoritative**: a board entry whose key is an owner name carries the PO's own
`webviewId`, and `boardOwnerFrames()` treats that frame as the orchestrator regardless of what its
text looks like. The `≥3 distinct roles` heuristic is a fallback for buses that declare nothing.

The context cycle refuses outright to run against a tag that does not name an orchestrator — its
endpoint is a `/clear`, and a worker-named tag is one tick away from wiping a working session.

### Orchestrators open their own sessions

An orchestrator can write files and ring sessions but cannot open a tab. It writes
`~/.claude/loom/<repo>/open-requests.json` — `{"roles":["developer1"],"requestedAt":"<iso>"}` — and the
next tick opens each role from its freshest transcript *that this window can resume*, replacing the
file with the outcome (`opened` / `refused`, each refusal carrying its reason). Bounded: never an
orchestrator, never a role already live, never one off the board, never past the active-session cap,
and a request older than 30 minutes is ignored so a dead session cannot open tabs tomorrow. Setting:
`serveOpenRequests`. Playbook §15 is the orchestrator-facing copy.

A transcript resumes only from the window whose folder it was written under. Claude Code looks a
session id up in that cwd's project directory (`~/.claude/projects/<cwd with / and . as ->`); an id it
cannot find there opens a *new, blank* `Untitled` conversation on the pinned model. Measured
2026-09-13 05:50: four roles (Lumen/developer1, ReciEats/developer1 and designer, livegita/developer1)
were reopened from their freshest transcripts, all under `…--claude-worktrees-<role>` because each
role had moved into its worktree, and all four tabs came up as 400-character blank shells with
`webviewId: null` handed back — so the orchestrators asked again, and the windows filled with empty
tabs. Such a role is *stranded* from this window: it is not offered for reopening, the restart path
skips it, the digest's "Reopen sessions" refuses it with the reason, and an open-request for it is
served by spawning a fresh bound tab, with a `note` in the result naming the transcript and the cwd it
would resume from. Reopening it *with* its memory means a window on that worktree.

### The ids died on every restart, and now they heal themselves

A `webviewId` is the `?id=` UUID VSCodium mints per webview **instance**. Nothing persists it and
nothing can: every restart mints new ones. So `bindings.json`, `board.json`, `<role>.id` and
`orchestrator.json` all woke up pointing at frames that no longer existed, and stayed that way until
a worker re-ran `/loom <role>` by hand and the orchestrator re-confirmed each tab with a nonce ring.
Measured after the 2026-09-13 restart: `productowner.id` said `1db463ac` while that session was in
fact in `1e41adbf`, and both developer tabs of the `vs_code_extensions` bus were stranded and never
reopened at all.

**The Claude session id does not die on restart, and it is readable.** Each panel's inner
`#active-frame` has a URL of the form `…/index.html?id=<webviewId>&…&session=<uuid>`, reachable from
the shell frame's own `Runtime.evaluate` — same process, no extra CDP attach. Measured on 12 live
panels across 5 windows: 11 are conversation panels and each mapped straight to some bus's
`board.json` `session_id`; the 12th is the sidebar (`purpose=webviewView`) and correctly carried
none.

**The URL, not the bootstrap state.** A panel also carries `{"isFullEditor":true,"sessionID":"…"}`
in an inline script, and the two disagree. The state is written at load and never updated, so it
goes stale exactly when it matters — on a `/clear`. ReciEats' orchestrator panel read URL
`e868c82c` (a session live 18:26 → 20:54) while its state still said `cee5d24f`, a session that had
ended at 16:06. Across the twelve the state was present on six and never once where the URL was
absent, so it adds no coverage and can be confidently wrong. Loom reads the URL only.

So the **session id is the address and the webviewId is a cache**. A frame carrying a role's session
id *is* that role — ahead of content, and ahead of a declaration naming a frame that no longer
exists — and the tracker then rewrites `bindings.json`, `board.json`, `<role>.id` (keeping line 2's
guard when it still holds) and, for an owner, `orchestrator.json`. Writes are atomic and
change-only, and each one is logged in `tracker-debug.json` as `reboundBySessionId` with old → new.
Within one tick of a restart, `reach_po.py @<repo>/<role>.id` works again with nobody typing
anything.

This is the **one** narrowing of the rule that the tracker never writes `bindings.json`: a binding
derived from a session-id match may be written, and nothing else may. Content never rewrites
anything, and a tracker that cannot read a session id changes nothing at all.

Two more guards, because a wrong answer here is written to three files and then injected into:

* a session id claimed by **two** roles is dropped rather than tiebroken;
* the restart path opens **one** tab at a time and diffs the frame list around each open, and 0 or
  ≥2 new frames writes nothing — the same rule `serveOpenRequests` already used, now shared code
  (`newframe.ts`) so the two cannot drift.

**The remaining manual step.** A role whose board `session_id` is stale *and* whose transcripts live
under a cwd this window cannot resume is still stranded — Loom will not open a tab it cannot
attribute. It is reported in `tracker-debug.json` as `restartStranded`, and the orchestrator's wake
tells it to spawn. The transcript fallback covers the ordinary case: when the board's `session_id`
has gone stale, a frame carrying any transcript id from that role's **own worktree** is matched to
it. The window's own cwd is deliberately not used — the owner role usually has no worktree, so every
ad-hoc Claude tab a person opens in that folder would map to the orchestrator.

### Blank tabs after a restart

Claude Code's restore discards the session id, so every Claude panel comes back as a blank `Untitled`
conversation — 8 of 26 panels after one measured restart. The restart reopen then adds the real
sessions, which is why roles appeared twice. 0.26.0 closed those shells over CDP and lost three
windows (`/json/close` on a webview target closes its window), so Loom never closes a Claude tab: the
shells stay for a person to close, `blanks.ts` still identifies them, and `closeBlankShellsOnRestart`
is inert. The second source of blank tabs — reopening a transcript from the wrong window — is
described under "Orchestrators open their own sessions" and no longer happens.

## Commands

| Command | What it does |
|---|---|
| `Refresh Now` | Force a tick |
| `Show Status` | The tracked agents and their liveness |
| `Spawn Session…` | Open a session for a role (refuses past the active cap) |
| `Retire (Close) Session` | Name a confirmed live agent's tab so a person can close it — Loom never closes a tab itself (the command's own title is left over from 0.26.0) |
| `Delete Session` | Archive a role's worktree + transcript (recoverable) |
| `Lock` / `Unlock` | Protect a role from deletion |
| `Tag as Orchestrator` / `Untag` | Choose the session that receives notifications |
| `Show Simultaneous Session Count` | Editor-wide conversation count |
| `What Needs Me? (startup digest)` | The attention summary |
| `Toggle All-Projects View` | This project only, or every project |
| `Worktree Cleanup Report` | Report first, remove second |
| `Collect Garbage (across projects)` | Show the plan, or run tiers 1+2 after a confirmation |
| `Bank Orchestrator Memory & Clear Context` | Run a context-memory cycle now |

## Settings

All under `loomSessionTracker.`.

| Setting | Default | |
|---|---|---|
| `intervalMs` | `15000` | Tick interval (5s floor) |
| `showAllProjects` | `false` | Show every project's roles in this window |
| `sessionWarnThreshold` | `5` | Highlight past this many simultaneous conversations |
| `notifyOrchestrator` | `true` | Tell the orchestrator when a worker finishes |
| `stallWatchdog` / `stallMinutes` | `true` / `45` | Flag roles working but silent |
| `workingWarnThreshold` | `5` | Digest warning for roles working across all projects |
| `autoResumeAfterLimit` / `resumeMessage` | `true` / built-in | Resume a session when its usage limit lifts |
| `enforceWorkerModel` / `workerModel` / `premiumModels` | `true` / `claude-opus-5` / Fable, Mythos | Reserve the expensive tier for the orchestrator |
| `workerModels` | `claude-opus-5`, `claude-sonnet-5` | The tiers a handoff may ask for in its `model:` frontmatter (premium is refused whatever this says) |
| `modelAckMs` | `8000` | How long a spawned tab may take to acknowledge its `/model` before it is bound anyway |
| `enforceOrchestratorModel` / `orchestratorModel` | `true` / `claude-fable-5-1[1m]` | Put the tagged orchestrator back on it when a restore drops it to the pin |
| `showStartupDigest` / `staleBusDays` / `digestUnbankedCheck` | `true` / `30` / `true` | The attention summary |
| `contextMemory` | `true` | Run the bank → clear → restore cycle |
| `contextThresholdPct` | `30` | When to run it (30, not 50, since 0.32.0 — see principle 14) |
| `contextWindowTokens` | `1000000` | Window size for the transcript estimate |
| `contextMemoryFile` | `""` | Empty = `~/.claude/loom/<project>/<role>/memory.md` |
| `contextSaveTimeoutMinutes` | `10` | Give up (clearing nothing) if the memory never appears |
| `contextClearTimeoutMinutes` | `5` | Give up on confirming a `/clear` |
| `contextCooldownMinutes` | `15` | Minimum gap between cycles |
| `gcEnabled` | `false` | Collect garbage across projects (everything reversible except a tier-2 worktree removal). Off for 0.33.0 — run it by hand once first |
| `gcIntervalHours` | `24` | How often the automatic tier-1 pass runs, per machine |
| `gcTranscriptDays` | `14` | Age past which an unreferenced transcript is archivable |
| `gcBackupDays` | `7` | Age past which a `*.bak-<epoch>` under `~/.claude/loom` is archivable |

## Files it touches

**Moves, not deletes — with one exception:** garbage collection archives under `~/.claude/loom/_archive/<date>/`
(`extensions/`, `transcripts/<projectdir>/`, `backups/`) and records every move in `gc-debug.json`.
It is the only thing here that touches `~/.vscode-oss/extensions`.

**Reads, never writes:** `<project>/board.json` (the roster), `<project>/bindings.json` (written by
`loom_cdp.py` at `/loom` time), each role's `status.json`/`inbox.md`/`outbox.md`, and
`~/.claude/projects/*/<sessionId>.jsonl`.

**Writes** (all atomic, change-only, and never fatal if they fail):
`<project>/targetmap.json`, `orchestrator.json`, `session-locks.json`, `notify-state.json`,
`limit-state.json`, `model-policy.json`, `stall-state.json`, `context-state.json`; globally
`active-sessions.json`, `working-sessions.json`, `worktree-removals.json`, `gc-state.json`; plus
`*-debug.json`
files recording the last injection attempt of each kind, which is where to look when something did
not arrive.

---

## Troubleshooting

**`★ orchestrator · frame not identified`** — the tag names a frame this project cannot see (its
window reloaded, or it was tagged from the wrong window). The real candidates are listed directly
beneath it; click the ★ on one.

**No candidate offered** — a session is only offered if it is *attributed to this project* (its
text names this project's paths) and is not one of its roles. A session whose output is dominated
by `worktrees/<role>` paths is treated as that worker, not as the orchestrator.

**`Loom: CDP?` in the status bar** — the debug read failed. The map is kept and aged rather than
wiped. Check the editor really was launched with `--remote-debugging-port`.

**Nothing is being injected** — read the relevant `~/.claude/loom/*-debug.json`. Note that
injections aimed at the orchestrator address its **webviewId**, not its role: `loom_cdp.py`
deliberately refuses to resolve `product-owner` by content, so a tag without a frame cannot deliver.

**Check everything at once:**

```bash
./live.sh
```

This asserts, against the *running* editor and the real bus, the things a unit test cannot: one
frame is at most one project's orchestrator, every tag resolves to an attributable frame of its own
project, a tagged orchestrator has some way to read its context, no rostered role's worktree reads
as orphaned, every board `session_id` resolves to a transcript — and it prints what the memory cycle
would do right now, per project. It is read-only: it never injects, writes or closes anything.

---

## Testing

Three layers, because the first two were not enough. On 2026-09-09 this suite went from 349 to 388
passing across a night in which the live system misrouted six different ways — every fixture had been
written from the code's own model of the world, so where that model was wrong the tests agreed with it.

```bash
./test.sh                 # unit + fixture suites
python3 test/mutation.py  # reintroduce each known defect; the suite MUST fail on every one
./live.sh                 # invariants against the running editor and the real bus
```

**Captured fixtures** (`test/fixtures/live/`) are real panels from the running editor, snapshotted by
`test/fixtures/capture.js`. It redacts the user's prose but preserves every token classification reads —
sign-off lines, worktree and project paths, the model footer, limit banners, the busy chip — at their
real positions and repetition counts, so purity ratios and frame lengths (which decide ties) survive
exactly. Capture **refuses to write a fixture whose behaviour differs from the frame it came from**, and
snapshots the buses too, since a roster and its aliases are half the input. Re-run it when the world
changes; state the ground truth in the test by hand, from evidence outside the code.

**Mutation testing** is what keeps the suite honest. `test/mutation.py` restores each defect that was
actually live that night — `po` missing from the owner set, a clean owner sign-off falling through to
worktree paths, path evidence needing no corroboration, commands typed into busy composers, a limit
banner that never expires — and fails if the suite still passes. A green suite means nothing; a suite
that breaks when reality does means something.

**Dispatch** (`src/dispatch.ts`) exists so the decision that caused the harm — *who gets typed into* —
can be asserted directly. It used to live in a closure inside `activate()`, reachable only by driving
the whole extension, and had no test of its own.

## Development

```bash
npx tsc -p .                                   # build to out/
./test.sh                                      # 623 checks, 39 files, no test framework
./test.sh notifier                             # filter by name
rm -rf /tmp/cov && NODE_V8_COVERAGE=/tmp/cov ./test.sh && python3 ../tools/coverage.py /tmp/cov out
./live.sh                                      # invariants against the live editor
```

Tests run under the editor's bundled node (no npm needed) and force `HOME` to a throwaway
directory, so they can never touch the real bus. The CDP layer is driven against a fake DevTools
server, so the reader's nesting, two-pass and timeout behaviour is tested without a browser.

A note on what the suite is *for*. It sits at 93.1% of lines (5641/6060, measured 2026-09-13 at
0.34.0; `LOOM_TEST_JOBS=1` reads 93.3%, the 12 extra lines being state leaked between test files
that share one `HOME`), and it caught none of the four
defects found on 2026-09-08/09 — every fixture in it was written from the same model of the world as
the code, so where the model was wrong, the tests agreed. Coverage tells you which lines ran, never
which realities you considered. `live.sh` and measuring the real system are the other half;
when you change something here, check both.

Each module states its one job and the measurement behind its decisions at the top of the file —
start there. The parent [README](../README.md) carries the cross-extension notes, and
`~/.claude/loom/ORCHESTRATION-PLAYBOOK.md` describes the Loom pattern this serves.
