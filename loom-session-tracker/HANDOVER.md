# Handover — loom-session-tracker

Written 2026-09-09 so a fresh context can pick this up without the conversation that produced it.
Read this, then `README.md` (what the extension is and how to use it), then run `./live.sh`.

If you are the orchestrator being restored by this extension's own memory cycle: this is the same
idea, done by hand. The state below was true when it was written; **verify it, do not trust it.**

---


## ★ Resume here — banked 2026-09-13 before a context clear (updated 2026-09-15 for 0.38.2)

**Version 0.38.2** is WL-005, which took two lies out of the instruments this bus reads its own
state from. (1) A handoff's duration was measured between two different clocks: `started` was read
from the worker's `status.updated_at`, which at the moment a block OPENS still holds the stamp of
the block BEFORE it. Not one record in this bus's ledger had a `started` of its own — WL-001 read
2455 minutes for a ~90-minute block, and ReciEats read **–39.3**, which is the same defect wearing
its visible face. Both ends are now one clock (the tracker's own observation of the opening and
closing tick); worker stamps are kept as `workerStampAt*` for diagnosis and are never endpoints; a
block whose start was never observed has **no** duration rather than a zero or a guess. The
render-side `<= 0 ? "—"` suppression is GONE and a negative is now SHOWN — blanking it claimed
*not measured* for something that had been measured wrongly, and that render-time hiding is why the
defect survived while the same field fed the median. (2) `live-check.js` printed `deployed is <X>`
off the SOURCE manifest, so between a merge and `deploy.sh` it named a build that existed on no
disk and told the reader to RELOAD to reach it. `deployed` now means what is on disk, resolved
through WL-003-R5's own `deployedVersions()`, with three separated cases — reload a window behind
the artifact, run `deploy.sh` when the manifest is ahead of it, `unmeasured` when no artifact
exists — and version segments compare NUMERICALLY, because a string compare calls 0.38.10 older
than 0.38.9. Merged `8219c88`, DEPLOYED 2026-09-15. **Three pre-existing tests encoded both defects
and were updated, not deleted** — one of them required a negative to render as a dash, which is a
test documenting the cover-up. 0.38.1 is WL-004 + R6 and FX-002. WL-004 took the byte cap out of every agent-facing
memory prompt — an agent asked to hit a number deletes what is true to reach it, and this bus lost
the record of the owner's product goal that way twice. R6 is the correction to WL-004's own thesis:
banning the NUMBER did not ban the TRADE, and a deliberate mutant reading "If it will not fit, cut
the least important section until it does" carried no digit and passed every assertion. The ban is
now keyed on WHAT is cut — cutting words is legal, cutting sections, content or facts is not.
FX-002 is the inode fix: 15 test sites called `os.tmpdir()` from inside the mutation gate's
throwaway tree, which is the HOST `/tmp`, so six days of gates took the filesystem to 100% of its
inode table with 74 GB free; the runner now owns every fixture, and the gate asserts containment at
run time because a mutant on `mutation.py` itself can never be caught (the copy's driver is never
executed). Merged as the WL-004-R6 merge and deployed 2026-09-15. 0.38.0 was WL-003 + R5 (the work
audit now reaches the ORCHESTRATOR — appended to the restore message a fresh context reads and again
at dispatch — and its headline is a COUNT of tool calls scoped to the orchestrator's own session,
never a percentage of its own conduct; R5 rekeyed the release line off git TAGS onto what reached a
user: deployed artifact, else manifest bump, else `unmeasured`), `1f1277d`. 0.37.1 was WL-002 (the
ledger could not see any repo whose name has an underscore, and reported that as $0.00/line — the
cheapest possible week — rather than as unmeasured, `316ef5c`); 0.37.0 was WL-001 + R7, the work
ledger itself (`68e7ef0`). The deployed copy on this machine is what `ls
~/.vscode-oss/extensions/ | grep loom-session-tracker | sort -V | tail -1` says, and every window
needs `../deploy.sh loom-session-tracker` + a reload before it is actually running it — do not read
a version here as "that is what the editor is executing". **783 tests** green in BOTH modes
(`./test.sh` and `LOOM_TEST_JOBS=1 ./test.sh`), and **180/180 mutations caught** under the
baseline-grading gate GC-003 introduced, with the deliberate no-op self-check surviving.
(Re-measure after each merge, and note that `./test.sh` does NOT compile — a stale `out/` after a
merge reads as a red suite.) `./live.sh`
is clean except the warnings under open threads and the expected "windows are running an OLD build"
failure until that deploy + reload. Read this section, then `README.md`, then run `./live.sh` and
believe it over anything written here.

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
   **The mutation gate is BASELINE-GRADED** (GC-003, 2026-09-13) — it measures the unmutated suite
   first, REFUSES to grade against a red baseline (exit 2), counts a mutant caught only when a test
   that PASSED on the baseline FAILS on it, names those tests, and runs a deliberate no-op mutant that
   must SURVIVE. Do not reduce it to "the suite went red": that is the vacuous gate it replaced.
10. **An exit code is only evidence when you know what green looks like.** Twice a `time`/`tail` pipe
    hid a red `./test.sh` result and a push went out — so never hide one in a pipe. And the deeper
    version, measured 2026-09-13: the mutation gate graded every mutant on `./test.sh`'s exit code
    while the suite was ALREADY red in that mode, so all 46 mutants of the day "failed the suite" and
    all 46 were scored caught — a no-op mutant would have been too. An exit code compared against
    nothing is a constant. See principle 9.
11. **A transcript resumes only from the window it was written under** (0.30.0). Claude Code looks a
    session id up in the window cwd's project dir; elsewhere `editor.open(sid)` makes a blank
    `Untitled` tab on the pinned model. A role whose transcripts all live under its worktree's cwd is
    *stranded* from the main window: never reopened, spawned+bound on request, reported with the cwd.
    Measured 2026-09-13 05:50 — four roles, four blank tabs, orchestrators asking again.
12. **Only the orchestrator is on the premium tier** (user direction 2026-09-13). The settings pin is
    `claude-opus-5`; the tagged orchestrator's own idle frame is promoted with `/model`. The footer
    chip lags a switch until the next turn, so `models.acknowledgedSwitch()` reads the "Set model
    to" line and the policy does not retype while it lags.
13. **The panel's silence is an opinion** (0.30.1): the compact button renders only past 50% used,
    so a visible conversation with no button is under 50% and no transcript estimate may start a
    cycle. A transcript that stopped before the last clear is dead. One session id can live in two
    project dirs; the newest copy is the session. After a confirmed clear the extension REBINDS the
    orchestrator's `board.json` entry to the fresh id itself (`rebindSession`, 0.31.0); the restore
    prompt and playbook §14 step 4 ask the orchestrator to confirm it.
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

    **The WRITER side of the same sentence** (GC-006, 2026-09-13). Making the reader fail closed did
    nothing while the writer still failed open: `catch { /* first */ }` around the stamp read treated
    "there is no file" and "I could not read the file" as the same thing, and they are opposites. It
    then pruned nothing and ATOMICALLY published `{ thisWindow: <version> }` — erasing every other
    window's entry, which gc reads as a perfectly *readable* file naming ONE version and archives
    every other running build in tier 1, the unattended tier. Only `ENOENT` is "first" now; any other
    read error, parse failure or non-object shape SKIPS the write for that tick and says why in
    `tracker-debug.json`. There is deliberately no self-heal on a file that exists and will not
    parse: an old build rewriting it non-atomically can sit truncated for longer than any re-read
    gap, so "unchanged on re-read" would license exactly the erasure this prevents. A wedged stamp
    over-keeps builds; a confidently wrong one archives a build out from under a live editor.
    The corollary is that the bound must exist in the other direction too: a stamp entry whose `at`
    will not parse is dropped by the reader and pruned by the writer, because nothing could ever age
    it out and it would pin its build in the keep-set permanently.

    **Two places where this refusal is sticky, and both are quiet** — worth knowing before reading a
    plan that collected nothing. (a) The reference sweep's bounds are ALL-OR-NOTHING: one `.md` over
    8 MB anywhere under `~/.claude/loom` refuses the entire transcript tier, with only a line in
    `plan.notes` as the signal. (b) A window that is OPEN but whose extension host has wedged stops
    stamping, and after `gcIntervalHours` its build is archived in tier 1 *under a running editor* —
    reload it rather than leaving it sitting there.

17. **Name the guard that actually decides, not the one that looks like it does** (GC-006,
    2026-09-13). A review found the tier-2 worktree removal — the ONE path here that deletes rather
    than moves — guarded by `busLiveRoles`'s 30-minute window, which returns two roles machine-wide,
    and proposed widening it. It is not that guard. `scanWorktrees` calls a worktree orphaned only
    when its name is absent from `boardRoles(repo)`, and that roster is the board UNION every role
    owning a MAILBOX on the bus — any directory holding a `status.json`, `inbox.md` or `outbox.md`,
    at ANY age. Liveness never gets a say, and a "wider liveness set" would have been a strictly
    narrower test inside a guard that already passed: an unreachable safeguard that reads as
    load-bearing, which is worse than none. The fix was a test pinning the real guard through this
    tier (there was none), a mutant on it, and honest comments. Same judgement as the redundant
    lowercasing in GC-004 and the S3 live check in GC-002 — the third and fourth time now: when a
    guard turns out to be redundant, retarget at the point that decides; never add another copy.

18. **The session id is the address; the webviewId is a cache the tracker refreshes** (0.34.0,
    RB-001, 2026-09-13). A `webviewId` is minted per webview INSTANCE, so every restart invalidated
    every id the bus had recorded — `bindings.json`, `board.json`, `<role>.id`, `orchestrator.json` —
    and the only repair was a human re-running `/loom` and a nonce ring per tab. The Claude session
    id survives restarts and is readable off each panel's inner `#active-frame` URL
    (`…?id=<webviewId>&…&session=<uuid>`), from the shell frame's own `Runtime.evaluate`. Measured on
    12 live panels in 5 windows: 11 conversation panels, every one mapping to a `board.json`
    `session_id`; the 12th was the sidebar (`purpose=webviewView`) and had none.

    **Read the URL, never the bootstrap state.** The panel's inline
    `{"isFullEditor":true,"sessionID":"…"}` is written at LOAD and not updated, so it is wrong
    precisely after a `/clear` — ReciEats' orchestrator read URL `e868c82c` (live 18:26 → 20:54)
    against state `cee5d24f` (ended 16:06). The state appeared on 6 of 12 panels and never once
    where the URL was missing: no coverage gained, a confident wrong answer risked.

    So a frame carrying a role's session id IS that role, above content and above a declaration
    naming a dead frame, and `rebind.ts` then rewrites every place the bus records that frame.
    This narrows "the tracker NEVER writes bindings.json" by exactly one clause — a binding DERIVED
    FROM A SESSION-ID MATCH — and by no other. Content still rewrites nothing; a tracker that cannot
    read the session id changes nothing at all. Corollaries, each of which cost a test:

    * **Ambiguity refuses**, as everywhere else here: two roles claiming one session id is a drop,
      not a tiebreak, and an open that yields 0 or ≥2 new frames attributes nothing.
    * **Heal the spelling the board actually uses.** The extension reads `webviewId`; the boards the
      Loom skill writes carry `webview_id` (this project's own `productowner` entry has only the
      snake form). Writing just the camel field would leave a correct value beside a stale one and
      look fixed. Same shape as the guard-that-does-not-decide in principle 17: find the field the
      readers read, do not add another copy.
    * **Not reading something is not evidence against it.** The restart path knows which frame it
      just opened without having read a word of it, so it passes `frameText === null` and the id
      file's line-2 guard is KEPT — the same judgement as "a guard is inconclusive on a busy tab",
      and the same family as principle 16.
    * The transcript fallback is scoped to a role's OWN worktree, never the window's cwd. RB-001
      asked for both; the owner role typically has no worktree, so windowCwd would have mapped every
      ad-hoc tab a person opens to the orchestrator, at binding authority and injectable as it. The
      narrowing is deliberate and is stated in `rebind.ts` where someone would otherwise re-widen it.
19. **The orchestrator chooses the tier per handoff; the tracker enforces; the ledger judges**
    (0.34.0, MP-001, 2026-09-13). Workers do not all need Opus. Nothing about "which model" belongs
    in a setting that is true for a whole project for a month: difficulty is a property of the
    BLOCK, and the only session that has read the block before anyone works on it is the
    orchestrator writing the handoff. So the choice lives in the handoff's own frontmatter
    (`model: claude-sonnet-5`), the tracker does the typing, and every block appends a line to
    `<repo>/model-ledger.jsonl` — because a rubric nobody can score is a preference, and in a month
    the only way to know whether the Sonnet blocks looped back more is to have written it down at
    the time. Four things worth keeping in mind:

    **The floor is not the allowlist.** `workerModels` is a setting, and settings get widened; the
    premium tier being orchestrator-only is a rule. So a premium id in a frontmatter is refused
    against the model TABLE, before the allowlist is consulted at all — widening the setting cannot
    open the top tier to a worker. A guard that can be turned off by editing a config is not the
    guard you thought you had.

    **Principle 16, pointed the other way.** A frontmatter the tracker cannot read changes NOTHING —
    but the two cases that are a *request* rather than an absence (a premium id, an unknown id) are
    ignored **and say so** in `tracker-debug.json`. An ignored `model:` line that is silent is
    indistinguishable from one that worked, and the orchestrator would go on writing it.
    Note the trap that cost a test cycle here: `debugLog` is last-writer-wins within a tick, and its
    own comment says so. A note attached to one call is overwritten by the next; these had to become
    WINDOW state (`modelNote`, beside `stampNote`) to survive to the end of the tick.

    **Order is a correctness property, not a style one.** On the spawn path `/model` must be typed
    BEFORE `/loom <role>`: the bind runs the inbox check, and from that moment the composer is busy,
    so a `/model` sent second queues as an ordinary message and never executes (dispatch.ts). Both
    commands are still sent either way, so every count-based assertion passes and the tab silently
    stays on the wrong tier. Only an assertion on the ORDER catches it — hence the append-only
    inject log in `extension.test.js` rather than `spawn-debug.json`, which keeps only the last call
    and therefore cannot answer "before or after". The bind is deliberately NOT conditional on the
    switch: an unbound tab is a worse loss than a mistuned one, and R2's next idle tick fixes the
    tier anyway.

    **Count reports, not reads.** Escalation counts a worker's loop-backs, and `status.json` is
    re-read every tick — so "blocked" is true for hundreds of ticks on one report. Counting reads
    instead of reports escalates on the FIRST loop-back within seconds, and the judgement the whole
    rubric is meant to measure never gets made. The same shape as the ledger's closed-line marker:
    a transition must be recognised once, not once per observation of the state it left behind.
20. **One handoff is one merge: the tracker refuses overlap, the ledger measures size** (0.35.0,
    CH-001, 2026-09-13). The fixed cost of a handoff — ~40 mechanical orchestrator calls, three gate
    runs, a merge — is the same whatever its size, so bite-sized handoffs are the expensive kind and
    §19 sets a size rule (150–250 worker calls, split at FILE boundaries) and a parallelism rule (one
    developer per file-disjoint package). A rule nobody enforces drifts, and these two are enforced
    and scored in different ways ON PURPOSE, because only one of them is decidable: disjointness is a
    fact about two files that a machine can check before the tab exists, while size is a judgement
    that can only be MEASURED after the fact and argued about with numbers.

    **Declare, then refuse — but only where something was declared.** `files:` in the frontmatter is
    the package; `planOpen` refuses a requested role whose files a currently WORKING role's handoff
    also claims, reason `overlaps <role> on <first shared file>`, and counts roles accepted earlier in
    the SAME request as live (one request naming two colliding briefs is the case §19 is most about,
    and neither is "working" yet). Absence is never a refusal, on either side: an undeclared handoff is
    not one that touches nothing, and reading the silence as licence would make the line compulsory by
    stealth. The same family as principle 16, and as MP-001's `model:`.

    **A ring cannot be refused, so it is warned about instead.** A role that is already bound is
    reached through `reach_po.py` — off-git, no part of this extension, nothing to intercept. The
    honest surface is a status-bar line plus `handoffOverlap` in `tracker-debug.json`, once per
    colliding pair. Naming that limit in the code is worth more than a guard that pretends to cover it.

    **The same file gets written from two roots on one bus**, so the comparison is a path-SEGMENT
    anchored suffix match, not a string compare: CH-001's own frontmatter said `src/models.ts` while
    RB-001's status.json said `loom-session-tracker/src/models.ts`. The anchor is what keeps it from
    also matching `other/src/mymodels.ts`. It still over-matches a bare `models.ts`, and that is the
    correct direction to be wrong in — an over-match costs one re-read of two briefs, an under-match
    costs a merge conflict discovered an hour later.

    **A size field that cannot be read is null, and `Number(null)` is 0.** The ledger gained
    `contextPctAtFinish`, `wallMinutes`, `filesDeclared` and `statusUpdates`, and adding the first of
    them exposed a hole that had been open under `testsBefore` since MP-001: `numOrNull` mapped
    `null`, `undefined` and `""` to 0, so an unreadable value entered the ledger as a MEASURED zero.
    That matters most for the percentage: the panel renders no compact button below ~50 % used, which
    is exactly §19's "under 30 % context was too small" band, so every comfortable handoff would have
    been scored as the smallest one ever handed out. A number there now always means at least half
    full; null means comfortable OR unread, and those two are not worth pretending to separate.
    `statusUpdates` counts REPORTS, not reads — the same sentence as principle 19's last paragraph,
    and the third feature in this file to need it.

    **A prune must be gated on the durable copy existing.** Once a block's ledger line is appended the
    escalation record is working state and is dropped — but the append is deliberately swallowed so a
    full disk cannot break a tick, so pruning unconditionally would destroy BOTH copies of "this block
    was escalated after two loop-backs". `appendLedger` returns whether it landed, and that boolean is
    the whole guard. Measured the same day, and not hypothetically: `/home` hit 100 % full mid-handoff
    and truncated `src/tracker.ts` to zero bytes. A write that cannot fail is a write nobody checked.

    **A field asserted everywhere can still have an untested WRITE.** The mutation run's one survivor
    was `filesDeclared` set to 0 where the ledger line OPENS — and it survived because every longer
    block has that value refreshed by a later tick before it closes, so the open-site assignment is
    reachable only by a block ABANDONED after exactly one tick (playbook §12 step 2's window: the
    orchestrator's first move after banking is to write the next brief over the inbox). Four tests
    asserted the field and none of them reached the line that first sets it. Same lesson as RB-001's
    survivor — two tests that read as "either way" can exercise one branch twice — and the same tool
    found it: only a baseline-graded mutant can tell "asserted" from "reached".

21. **A default nobody hears is a default nobody writes; an exit code is not a switch; and an
    orchestrator can shift itself** (0.36.0, MS-001, 2026-09-14). MP-001 was reported working
    machine-wide. Measured that morning it had chosen a tier exactly ONCE on this machine, no inbox
    on any other bus had ever carried a `model:` line, and ReciEats' ledger read 10/10 `chosenBy:
    default`. The mechanism was correct and the outcome was nil, because nothing ever said so.

    **The resolution stays; the silence goes.** An absent `model:` line still runs the configured
    `workerModel` (owner, 2026-09-13) — but the tick notes it ONCE per (role, handoff id), in the
    status bar and under `model.defaulted` in `tracker-debug.json`, with the "already noted" set
    persisted in `model-policy.json` so a reload does not re-toast. Once per handoff, never per tick:
    a warning that repeats every 15 seconds is one that gets switched off, which is the same failure
    as the silence with more noise. Acks are not handoffs and are not noted (FX-001, again).

    **An exit code is not evidence.** `enforce()` set `ok = !err`, and `loom_cdp.py inject` exits 0
    while printing `{'ok': False, …, 'note': 'typed text not confirmed in composer; NOT submitted'}` —
    measured against this window's own orchestrator frame at 2026-09-14T00:04:57Z. So every refused
    switch was recorded as "switched", `lastError` stayed empty and the human was never warned.
    `injectTo` had read the printed dict correctly since it was written; `enforce` had its own copy of
    the logic that did not. The reading now lives in ONE exported function (`injectVerdict` in
    inject.ts) that both call — a second call site that re-derives a verdict is a second chance to
    get it wrong, and this is what that costs.

    **An orchestrator cannot run `/model` on itself, so it asks in a file.** `<repo>/orchestrator-
    model.json` `{"model", "reason", "at"}`; the tick enforces it on the orchestrator's own declared
    frame, idle only, against the `orchestratorModels` allowlist, and refuses an unknown id with a
    note rather than typing it. This OVERRIDES the earlier "self-downshift is out of scope" decision
    (owner, 2026-09-14). The change that makes a downshift possible at all is one early return:
    `checkOrchestrator`'s "the chip is premium → fine" had to become "the chip is the desired model →
    fine", and with it the premium-tier check stopped being the orchestrator's whole policy. Every
    performed shift appends a `{self: true, from, to, reason, at}` line to `model-ledger.jsonl`, one
    per request — the owner asked to see who shifted and why, and a mechanism whose use cannot be read
    back is the thing that just failed above.

    **A fresh tab's tier is what its FRAME says, not what the setting says it should be.** The same
    night, three workers on another project were spawned through `open-requests.json`, came up on
    Fable 5.1, were bound, and ran their whole handoffs there — 71/55/70 premium turns. All three
    handoffs correctly said `model: claude-opus-5`, and that is exactly why nothing was typed: that
    id IS the configured `workerModel`, and the spawn returned "default tier — nothing to type" on
    the assumption that a fresh tab starts on the pin. The assumption had never been checked against
    a frame. Two things follow. **Never infer state you can read** — the decision now compares the
    tab's own chip. And **`/loom` is a one-way door**: it starts the inbox check, the composer is
    busy from that instant, and the idle tick refuses to type into a busy composer, so a tab bound on
    the wrong tier is not "corrected later", it is stuck. The bind is therefore refused while the
    chip is premium (after one retry, which is free — a session-less composer is always idle), the
    frame and the reason go back in `opened[].note`, and the human is toasted. A mistuned but cheap
    tab is still bound: an unbound tab is the worse loss, and that one the tick really can fix.

    **The header is the only channel that reaches every orchestrator.** Both rules go in
    `restoreMessage` (§18: every handoff carries `model:`; §20: shift yourself with the file), because
    that text is what every orchestrator on every project reads after a `/clear` — a playbook section
    reaches only the sessions that happen to open the playbook, which is how MP-001 ended up honoured
    on one bus out of many.

### Things outside git this depends on
`~/.claude/loom/loom_cdp.py` (return address, busy guard, orchestrator guard, --repo/--webview-id),
`~/.claude/loom/test_loom_cdp.py` (mirrored in `../tools/` at the repo root, NOT inside this project), `ORCHESTRATION-PLAYBOOK.md` §13–§20 (§17: no watchers in an orchestrator session; §18: the orchestrator picks the worker's tier per handoff; §19: chunking — one handoff is one merge, and `files:` declares the package; §20: an orchestrator shifts its OWN tier by writing `<repo>/orchestrator-model.json`, which the owner writes off-git and `restoreMessage` names).
Backups of loom_cdp.py sit beside it as `loom_cdp.py.bak-<epoch>`.

**21. A number an agent can author is a number that says the week went well.** (WL-001, 2026-09-15.)
Everything the panel showed before this — `status.json`'s `last_line`, the ledger's test counts,
"DEV-219 landed" — was the agents' own account of themselves. Measured from git instead, 10.7 % of
ReciEats' changed lines over seven days reached a user's screen, 171 of 614 commits only updated the
guide, and 0 releases had ever been cut; by the agents' account the same week was excellent. So
`workledger.ts` takes every figure from git or from `model-ledger.jsonl` (whose lines the extension
appends by observing transitions, not the role by typing them), and the rule is worth defending when
this file is edited: **if a figure could be sourced from something a session wrote about itself, it
does not belong here.**

Three corollaries the code is built to, each of which had to be argued for once:

- **A figure that cannot be computed is `null`, never `0`.** A measured zero and an unreadable value
  are opposites — the `numOrNull` lesson from CH-001, now applied to a whole panel. Non-positive wall
  times are dropped, not averaged in; a handoff no commit names shows `—`, not 0 lines.
- **Cache reads are the figure.** They run ~100× the other token classes. A token total that omits
  them understates a 15-billion-token week by two orders of magnitude, and every cost ratio with it.
- **The numerator and the denominator must not overlap.** WL-001 shipped with `productPaths`
  matching `src/app/**`, which also matches `src/app/page.test.tsx` — so the same 39,150 lines were
  counted as product *and* as rig, and the shipping share read 56.8 % where the truth was 25.1 %. A
  ledger built to separate product from rig cannot let one glob claim both. `excludePaths` is kept as
  its own visible list for the same reason the `heuristic` flag exists: what was subtracted has to be
  readable, not inferable.
- **Churn is not production.** The denominator is a two-point diff, not a sum of per-commit numstat:
  a file rewritten 118 times has produced nothing if it ends the same size. ReciEats' most-touched
  file in the audited week was `guide/GUIDE.txt`, at 203 touches.

## Where everything is

| | |
|---|---|
| Source (git) | `/home/aneesh/vs_code_extensions/loom-session-tracker` — `main`, pushed to `github.com:aneeshpanoli/vs_code_extensions` |
| Deployed copy | `~/.vscode-oss/extensions/local.loom-session-tracker-0.32.1/` (newest installed 2026-09-13; 0.33.0 is merged but NOT yet deployed) — installed with `../deploy.sh loom-session-tracker`, registered in `extensions.json`, needs a window reload |
| The bus it watches | `~/.claude/loom/<project>/` — `board.json`, per-role `status.json`/`inbox.md`/`outbox.md`, plus the state files this extension writes |
| The injector | `~/.claude/loom/loom_cdp.py` — **not in git**, backed up in place as `loom_cdp.py.bak-<epoch>`. Changed 2026-09-09: `--repo` (project-scoped `_role_repo`/`find_role`/`_load_targetmap`, refuses ambiguous bare names), owner aliases read from `naming.json`, `KNOWN_ROLES` derived from the buses instead of a literal, `/loom` binding requires a leading command not a substring |
| The pattern's playbook | `~/.claude/loom/ORCHESTRATION-PLAYBOOK.md` — **not in git**; §13 (target by webviewId) and §14 (the memory cycle) matter most here |
| Live projects | whatever has a `board.json` under `~/.claude/loom/` — 15 buses as of 2026-09-13, including `Gaming` + `gaming` (stale, lowercase), `ReciEats`, `Lumen`, `livegita`, `tfg_ua`, `shwab_docker`, `funisland`, `vs_code_extensions`. Enumerate it, do not trust this list |

Two of those live outside version control. If either is lost, the extension still runs but cannot
inject anything.

---

## What this extension is

The instrument panel for running many Claude Code sessions as a team: it reads every Claude panel in
every editor window over CDP, works out which session is which Loom role, and acts on what it finds
(finish notifications, stall alerts, usage-limit resumes, model policy, worktree hygiene, cross-project
garbage collection, and the orchestrator context-memory cycle). `README.md` is the full description. The parent
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
- `test/mutation.py` — reintroduces 102 measured defects (2026-09-09 onward) and requires a test that
  PASSED on the unmutated baseline to FAIL on each; see principle 9.
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
./test.sh           # 659 checks; ./test.sh <filter> to narrow
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
- **Windows on old builds** — `./live.sh` names them; every window needs a reload to reach 0.32.1 (and a deploy for 0.33.0). Until the
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
