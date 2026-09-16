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

**A switch is only a switch when the injector says so** (MS-001). `loom_cdp.py inject` exits 0 and
prints its own result dict even when it could not confirm the typed text — `{'ok': False, …, 'note':
'typed text not confirmed in composer; NOT submitted'}`, measured against the orchestrator's own
frame on 2026-09-14. The verdict is read off that dict, never off the exit code, so a refused
injection is retried rather than recorded as done, and the injector's note is what lands in
`lastError` and in the warning the human sees.

### The orchestrator shifts its own tier (MS-001)

A session cannot run `/model` on itself, so the orchestrator asks and the tracker types it:

```json
// ~/.claude/loom/<repo>/orchestrator-model.json
{"model": "claude-sonnet-5", "reason": "banking the memory doc", "at": "2026-09-14T04:00:00Z"}
```

The tick enforces that id on the orchestrator's own declared frame, **idle only**, in **both
directions** — the old early return "the chip is premium, so it is fine" is now "the chip is the
desired model, so it is fine", which is what makes a downshift possible at all. Same backoff, same
acknowledgement rule; a changed target restarts the backoff. Sonnet for doc banking and status
reconciliation, Opus for ordinary review and dispatch, Fable for architecture and adversarial
judgement — the orchestrator rewrites the file when the task changes, and the file survives a
`/clear` and a bank.

**The allowlist is `orchestratorModels`** (`claude-fable-5-1[1m]`, `claude-opus-5`,
`claude-sonnet-5`). An id outside it — or an unreadable file, or no file — is **refused with a note**
(`model.orchestratorRefused` in `tracker-debug.json`, said once per request) and the configured
`orchestratorModel` stands exactly as before. **Workers cannot use this file**: a worker's tier is
its handoff's, and nothing here reads it for a worker.

Every self-shift the tracker actually performs appends a line to `model-ledger.jsonl`, so the owner
can see who shifted and why:

```json
{"role":"productowner","self":true,"from":"Fable 5.1","to":"claude-sonnet-5",
 "reason":"banking the memory doc","at":"2026-09-14T04:00:30.000Z"}
```

One line per request: retries of the same request write nothing more, and a promotion that came from
the setting rather than from the file is not a self-shift and writes no line.

**The fresh-context header carries both rules.** `restoreMessage` is the one text every orchestrator
on every project reads after a `/clear`, so it now names them: every handoff you write carries a
`model:` line (§18), and you shift your own tier by writing `orchestrator-model.json` (§20).

### Per-handoff model (MP-001) and per-handoff files (CH-001)

Workers do not all need the Opus tier. The **orchestrator judges difficulty as it writes a handoff**
and records that judgement in the handoff's own frontmatter; the **tracker enforces it**; a
**ledger** records what each choice actually cost, so the rubric can be judged on evidence rather
than on feel. The orchestrator switching *itself* is not part of this — that is
`enforceOrchestratorModel`, above, and it is unchanged.

```markdown
---
id: CH-001
from: productowner
to: developer2
model: claude-sonnet-5                          # MP-001: which tier this block needs
files: src/models.ts, src/requests.ts, test/*   # CH-001: which files it will touch
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

**An absent `model:` line is loud too** (MS-001). The resolution is unchanged — no line means
`workerModel` — but the tick now says so **once per (role, handoff id)**, in the status bar and under
`model.defaulted` in `tracker-debug.json`: `alpha's DEV-179 has no model: line — running the default
claude-opus-5 (§18)`. Once per handoff, never per tick, and the "already noted" set is persisted in
`model-policy.json` so a window reload does not re-toast it. Acks (`id: X-ack`) are not handoffs and
are never noted. This exists because the silence was load-bearing: on 2026-09-14 a machine-wide audit
found the `model:` line had been honoured **once**, no inbox on any other bus had ever carried one,
and one project's ledger read 10/10 `chosenBy: default`, with nothing anywhere pointing it out.

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
there. **The bind is conditional on one thing only: not being on the premium tier** (MS-001 R2b). On an
unreadable frame or a merely mistuned one the tab is bound anyway and the tier is left to the next
idle tick — a worker on the wrong model gets corrected, a worker that was never bound just sits
there. But `/loom` starts the inbox check, and from that moment the composer is busy, so the tick
can never switch it: a tab left on Fable runs its whole handoff there. Measured on another project
2026-09-14: three workers spawned, all three came up on Fable 5.1, all three bound, 71/55/70 premium
turns before anyone noticed. So the `/model` is **retried once** (a session-less composer is always
idle) and, if the tab is still premium, the spawn stops: nothing is bound, the frame and the reason
`on premium — /model refused` go back in `open-requests.json` under `opened[].note`, and the human
is warned. **What decides is the frame, not the setting.** Those three handoffs each asked for
`claude-opus-5` — the configured default — and the old rule ("a fresh tab already starts there")
typed nothing at all. The `/model` step's outcome is now merged into `spawn-debug.json`, which used
to hold only the bind.

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
 "finished":"…","loopBacks":2,"testsBefore":563,"testsAfter":592,
 "contextPctAtFinish":67,"wallMinutes":72,"filesDeclared":3,"statusUpdates":2}
```

`chosenBy` is `frontmatter` (the orchestrator chose), `default` (it did not) or `escalated` (the
tracker overrode it). A line that cannot be completed is written **with nulls, not skipped** — a
missing line is invisible, and the gap would bias exactly the comparison the ledger exists to make.

The last four fields are CH-001's, and they are there to score §19's **size** rule rather than the
tier rubric:

| field | what it is | when it is `null` |
|---|---|---|
| `contextPctAtFinish` | the role's own panel percentage on the tick the line closed | the panel rendered none — see below |
| `wallMinutes` | `finished − started`, in minutes | either stamp will not parse |
| `filesDeclared` | how many paths the handoff's `files:` line named | never; an absent line is `0`, which is a fact |
| `statusUpdates` | how many **distinct** `status.json` `updated_at` values the tracker saw during the block | no `updated_at` was ever readable |

**`null` for a percentage means "comfortable", not "missing".** The panel only renders its compact
button past roughly 50 % used, so a block that finished below that has no number to read. That is
exactly §19's "finished under 30 % context was too small" band — so the honest reading is: a *number*
here always means at least half full, and a `null` means the session was nowhere near it. It is never
written as `0`; a zero would be scored as the smallest handoff ever handed out.

**`statusUpdates` counts reports, not reads.** `status.json` is re-read every tick, so a tick is not a
turn — only a new `updated_at` is. Counting reads would turn this field into a measure of how long the
window happened to be open. (The same rule, and the same past defect, as escalation counting.)

### File disjointness: the tracker refuses an overlapping handoff (CH-001)

Playbook §19's other rule is **one developer per file-disjoint package**: two live handoffs on one bus
must not touch the same files, because the cost of breaking that is paid at merge time, hours later,
by the orchestrator rather than by whoever broke it. The `files:` line above declares the package, and
the tracker enforces it:

* **On the path that opens tabs** (`open-requests.json`), a requested role whose handoff declares
  files that a currently **working** role's handoff also declares is **refused**, with the reason
  `overlaps <role> on <first shared file>` written back into the result file. Roles accepted earlier
  **in the same request** count as live too — one request naming two colliding briefs is the case the
  rule is most about, and neither of them is "working" yet.
* **On an already-bound role**, there is nothing to refuse: the orchestrator rings a live tab through
  `reach_po.py`, which is off-git and outside this extension. So the same check surfaces as a
  **status-bar warning**, once per colliding pair, and is recorded under `handoffOverlap` in
  `tracker-debug.json`. Warn only — a ring cannot be stopped.

**Never a refusal on absence.** Both sides need a `files:` line. A handoff that declares nothing is not
a handoff that touches nothing; it is one that cannot be judged, and reading the silence as licence to
refuse would make the line compulsory by stealth and break every bus that has not adopted it
(principle 16, pointed the same way as `model:`).

**What counts as the same file.** A `*` is a wildcard (`src/*.ts` collides with `src/models.ts`), and
the comparison is a **path-segment-anchored suffix** match, because the same file gets written from two
roots on one bus: CH-001's own frontmatter said `src/models.ts` while RB-001's status.json said
`loom-session-tracker/src/models.ts`. Anchoring on `/` is what keeps `src/models.ts` from matching
`other/src/mymodels.ts` or `xsrc/models.ts`. It can still over-match a bare `models.ts` against any
directory's — which is the right direction to be wrong in (an over-match costs one re-read; an
under-match costs a merge conflict found an hour later) and is entirely in the writer's hands: declare
a path with a directory in it.

### The work ledger: what the agents actually produced (WL-001)

**Every figure in this section is computed from git and from `model-ledger.jsonl`. Nothing in it
comes from what an agent wrote about itself** — not `status.json`'s `last_line`, not a test count a
session reported, not "DEV-219 landed". That is not a stylistic preference; it is the defect being
corrected.

Two products ran ~70,000 agent turns and ~15 billion cache-read tokens in seven days, and the owner's
reading of it was "coding nonstop for days and the product hasn't moved much at all." Measured from
git, it had not:

| measured over 7 days | ReciEats | pleodo |
|---|---|---|
| changed lines reaching a user's screen | 10.7 % | 9.3 % (42.6 % counting the engine) |
| commits touching nothing a user sees | 356 of 614 | — |
| commits whose only job is updating the guide | 171 (28 %) | — |
| handoffs needing at least one loop-back | 30 % | 94 % |
| releases/tags ever cut | 0 (221 blocks) | 0 |

The panel could not have told anyone, because everything it showed was the agents' own account of
themselves — and by that account the week was excellent. So a **`work ledger` node now sits under
each project, ABOVE its agents**, collapsed into one line that carries the verdict:

```
ReciEats   9.3B · $7,313 equiv · $0.12/line · ships 10.7% · loop-backs 30% · narration 28% · release unmeasured
```

Expand it and each figure is its own row, coloured by threshold, with the raw numbers — numerator,
denominator, window, and `computedAt`, so a stale cache is obvious — in the tooltip. **A red row
states its number.** A bare warning icon tells a reader something is wrong without telling them how
wrong, which is how the last one got ignored.

| figure | what it measures |
|---|---|
| `shipsToUser` | changed lines (added+deleted) in product paths ÷ all changed lines |
| `loopBackRate` | handoffs in `model-ledger.jsonl` with `loopBacks > 0` ÷ all, plus the median wall time |
| `narrationShare` | commits whose **entire** file set is documentation — the "update the guide" commits |
| `rigRatio` | test/script/tooling lines ÷ product lines |
| `release` | whether what is on HEAD is in front of a user: the newest **deployed artifact** (or manifest bump), and the NET product lines on HEAD that are not in it, as a share of the window's product. **Not** the tag count, and not a commit count — see below |
| `tokens` | every billed token in the window, **cache reads included**, split by model |
| `list-price equivalent` | those tokens priced at list — **not a bill** (see below) |
| `net product lines` | a **two-point** diff over the product paths, plus files newly added |
| `$ per product line` | the ratio the owner actually asked for |

### The audit goes to the orchestrator, not to a panel

The add-on exists to make the **orchestrator** see it is spending its blocks on bus mechanics rather
than on building the product. A panel behind a window is not that: on 2026-09-15 this bus had 743
tests, three merges and two deploys while 8.6% of the week's changed lines reached a user and nothing
had been released in 86 blocks — and the orchestrator did not know it while deciding what to do next.

So the figures are **delivered where a decision is made**, on messages already being sent:

1. **On fresh context** — appended to the `[loom-context]` restore message, which a new orchestrator
   is guaranteed to read, *after* the bind instructions it must act on first.
2. **At dispatch** — armed when an `open-requests.json` is served, because choosing what the next
   block does is the decision the audit informs. Never typed into a running turn: it waits for an
   idle composer like every other injection here.

**Scoped to the orchestrator's own session id**, read from `board.json`. A developer's tool calls are
not the orchestrator's time, and reporting them as such would be the same category error the ledger
exists to refuse — unscoped, this bus reports 2,129 calls where the orchestrator itself made 89.

**The bus tree is not a git repository**, so bus mechanics cannot come from its history, and mtimes
cannot supply it either: a `board.json` rewritten two hundred times carries one mtime, so the volume
of bus work is exactly what an mtime destroys. It is counted instead from the transcripts, which
record every tool call with its input — the same thing the owner counted by hand. A call naming both
a bus path and a product path is **bus** work: whichever is tested first decides the number, and
testing product first is how bus work disappears into the product bucket.

**A release is what reached a user, and tags are not it.** Measured 2026-09-15: this product has
**42 deployed versions** in `~/.vscode-oss/extensions` and 56 manifest bumps in history, and **zero
tags** — and the panel read the tag count and reported that it had never cut a release. That is the
proxy-for-the-thing error the ledger exists to refuse, made about the repo the ledger lives in. The
signal is keyed on the manifest version reaching a user, in order: a **deployed artifact** matching
the manifest (roots are a setting; the artifact name always derives from the manifest's own
publisher/name), else a **manifest version-bump commit**, else **`unmeasured`** — a project whose
releases cannot be seen has not "never released", and must never be rendered as `0 blocks`, which
reads as *shipped just now*. Every line names which of the three answered. A tag is corroboration,
never the source. In a repo holding several products (this one holds three) the **most recently
touched** manifest answers and the line says which product it is about: taking the first by name
reported "111 blocks since 1.0.0" for a repo whose active product had shipped that morning.

**Counts, never a score.** The lines say what the week *contained* and let the orchestrator draw the
conclusion — `38 of the last 89 tool call(s) you made went to bus mechanics`, not
`orchestrator efficiency: 43% (below target)`. A percentage of its own conduct is a dial an agent can
move without doing any of the work it stands for; that is the WL-001 failure class aimed at the one
reader who can act on it, and a test asserts no `%` and no grading word ever reaches that text.

Six things this deliberately refuses to do:

- **A repo whose transcripts it cannot find is `unmeasured`, never `$0.00/line`.** The session
  encoder writes a project directory by folding `/`, `_` **and `.`** to `-`, so
  `/home/aneesh/vs_code_extensions` lands at `~/.claude/projects/-home-aneesh-vs-code-extensions`.
  Matching the repo name raw found nothing for every underscore- or dot-named repo, and finding
  nothing rendered as **zero tokens at $0.00 per product line — the cheapest possible week, green,
  and under every alarm threshold this module has.** The most flattering number the panel can print
  was what it printed for the one project it could not see at all. Both sides are now canonicalized
  before the separator anchor is applied (canonicalize, *then* anchor: the guard is not relaxed to
  buy the match — `pleodo` must still not swallow a sibling `pleodo-archive`, which the previous
  single-hyphen anchor did in spite of its comment). **Zero matched directories and zero tokens in
  the window are different facts**: the first nulls tokens, cost and $/line, bands the ratio
  `unknown` rather than green, names the directory it searched, and raises the daily nudge on its
  own, because a cost alarm can never fire on a repo whose cost reads as zero. The second is an
  honest `0`. One word — `unmeasured` — in the row, the one-line summary, the nudge and the report,
  because the panel previously said `$?` in one place and `$0.00` in another for the same gap.
- **A duration is bounded by its own block, and `deployed` means what is on disk.** Both were proxies
  stated as facts. `wallMinutes` took its start from the worker's `status.updated_at`, which at the
  moment a block opens still holds the stamp of the block *before* it — so WL-001 reported **2455
  minutes** against a real ~90, ReciEats reported **-39.3**, and on this bus not one record's `started`
  was its own. Both ends now come from one clock, this process's observation of the ticks that opened
  and closed the block; the worker's stamps are kept as `workerStampAt*` for diagnosis and are never
  endpoints. A block whose start was never observed has **no** duration rather than a small or a large
  one. And a negative is now **shown, not blanked**: blanking it claimed "not measured", which was
  false — it was measured, wrongly — and that render-time hiding is why the defect survived while the
  same field fed the median. Separately, `live-check.js` said `deployed is <X>` reading the **source
  manifest**: run after a merge and before `deploy.sh` it named 0.38.1 while the newest artifact on
  disk was 0.38.0, a build that existed nowhere, and told the reader to *reload* to reach it. It now
  resolves the newest artifact through the same `deployedVersions()` the release signal uses — one
  answer to "what reached a user" — and separates three cases: reload a window that is behind the
  artifact, run `deploy.sh` when the manifest is ahead of it, and `unmeasured` when no artifact exists.
- **A figure it cannot compute is `null` and renders "unknown", never `0`.** A measured zero and an
  unreadable value are opposites. A non-positive `wallMinutes` is dropped rather than averaged in as
  0, and a handoff no commit names shows `—` rather than 0 lines shipped.
- **A message that interrupts you states its OWN cause.** The once-a-day nudge is raised by the
  shipping and cost thresholds, and it used to append the release state unconditionally — so a
  figure that triggered nothing rode along on someone else's alarm and carried the authority of one.
  That is how the false "no release in 87 blocks" reached the orchestrator mid-decision on
  2026-09-16. The release state is now a trigger in its own right when it is genuinely bad, and the
  clause renders **if and only if** that is one of the reasons the alert fired — the same boolean
  does both, so they cannot drift apart. It is safe to raise on only because the band is now honest:
  `unmeasured` bands unknown and a deployed release with nothing outstanding bands good, so neither
  can fire it. Under the old tag proxy, every untagged repo would have alarmed daily.
- **A release state is never a blank cell — but "no tag" was never the state.** The first version of
  this rule read the TAG COUNT and coloured the row red whenever it was zero. WL-003-R5 rekeyed the
  collector off deployed artifacts and **exactly one of its four readers**; the panel tile, the
  summary line and the orchestrator's own nudge kept reading the tag, so on 2026-09-15 — a day this
  bus deployed five builds — all three said *"no release in 88 blocks"*, and the tile hard-coded
  `band: "bad"`. Because the tree derives the whole ledger node's icon from any red band, that was
  not one wrong row: it was **every untagged project's headline verdict, permanently red**. All four
  readers now take the line from one field. What is shown is **unshipped product** — the net product
  lines on HEAD that are not in the newest deployed artifact, as a share of the window's product —
  because a *commit* count is not work: three of this repo's "blocks since release" that day were
  HANDOVER and version commits, so the count overstated the drift by three while the honest answer
  was zero. `tag` / `blocksSinceRelease` / `daysSinceRelease` are still collected as corroboration
  for repos that do tag, and a test asserts **behaviourally** that changing them changes no reader's
  output. **`unmeasured` is its own state with its own band**: "I cannot measure this" and "this
  never shipped" are different statements, and only a tracked manifest whose version has never moved
  earns the second one.
- **A guessed product path says it is a guess.** A repo not named in `productPaths` falls back to a
  heuristic (everything except test/spec/`scripts/`/`tools/`/`docs/`/`*.md`/lockfiles/config) and is
  marked `(est)` on the row and `HEURISTIC` in the tooltip. An unconfigured guess presented as a
  measurement is the same lie in a new place.
- **Tests are subtracted from product even when a product glob matches them**, by `excludePaths`
  (`**/*.test.*`, `**/*.spec.*`, `**/__tests__/**`, `**/__mocks__/**` by default, settings-overridable).
  It is kept as its own visible list rather than folded into the product globs, so the next person can
  see what was taken out — and it is not hypothetical. ReciEats' product globs are `src/app/**` and
  `src/lib/**`; over the audited week **39,150 of the 63,225 lines they matched were test files living
  under `src/`**, and `src/app/page.test.tsx` alone was +10,782 — the single largest file in the
  product figure. Uncorrected, the shipping share read **56.8 %** instead of **25.1 %**, and the cost
  per product line $0.12 instead of $0.30. A ledger whose whole purpose is to separate what reached a
  user from the rig around it, and which counts `page.test.tsx` as product, reports exactly the number
  it exists to refute.
- **Product and rig partition the week's lines; they never overlap.** Whatever `excludePaths`
  subtracts from product is counted as rig, alongside `test/`, `scripts/`, `tools/` and fixtures. The
  two sets used to share the test files, so `rigRatio` understated the rig by construction while
  `shipsToUser` overstated the product — both halves of one error.
- **An unpriced model contributes tokens but no dollars, and is named.** A silent undercount
  presented as a cost is the same failure again.

**Cache reads are included and that is the point.** They run ~100× the other token classes — one
measured day was 2.93 billion of them — so a total that omits them turns a 15-billion-token week into
a 100-million-token one. `test/mutation.py` carries a mutant that drops them, and it must be caught.

**"List-price equivalent" is not a bill.** This work runs on a subscription and nobody is invoiced
it; the dollar figure is the resource measure, and every label that shows it says so. Prices are in
`modelPrices`, verified 2026-09-15 against the published model table — Fable 5.1 $10/$50, Opus 5
$5/$25, Sonnet 5 $2/$10, Haiku 4.5 $1/$5 per MTok, a cache read 0.1× input and a 1-hour cache write
2×, **except Claude Fable 5.1, whose cache reads are $0.25/MTok rather than $1.00**. Ids match by
longest prefix, so `claude-opus-5[1m]` and a dated snapshot inherit their family's row.

**These are dated constants and prices move.** A stale price is the characteristic failure of a cost
figure: it stays plausible while being wrong, which is the one thing this panel must not do. The whole
table is settings-overridable — re-check it against the published pricing rather than trusting the
date in this file. The Fable 5.1 cache-read rate is exactly the kind of exception a remembered rule of
thumb gets wrong: 0.1× input would say $1.00, overstating the largest single line in the whole figure
fourfold, because cache reads run ~100× every other class and the orchestrator is the Fable session.

**Net product lines is a two-point diff (`<base>..HEAD`), not a sum of per-commit numstat**, and the
difference is the whole value of the figure. Summing commits counts a line once per commit that
touched it, so a file rewritten 118 times reports thousands of lines of "production" while ending the
same size. A repo whose entire history is inside the window diffs from the empty tree, so everything
in it correctly counts as new.

**Performance.** One `git log --numstat` pass per repo per compute, cached atomically in
`~/.claude/loom/<repo>/work-ledger.json` with its `computedAt`; every tick in between reads the
cache, and the view never runs git at all.

**The orchestrator is told, once per project per calendar day.** When a project is red — the shipping
share, or the cost per product line, or a week that produced no net product line at all — one line is
injected into that project's **tagged orchestrator**, and only into an **idle** composer, the same
discipline `/model` is held to. Never a worker: a worker cannot choose what the next block builds.
The day is stamped in `work-ledger.json` before the injection, so a reload cannot re-announce it and
two windows on one project cannot both announce it. That is the point of the whole feature — the
number has to reach the session that decides what to build next.

### Orchestrator context memory

The orchestrator is the session that actually fills up: it runs for days across every role. Left
alone it hits auto-compaction — a summary it did not choose, did not review and cannot re-read.

Past `contextThresholdPct` (30% — lowered from 50% on 2026-09-13: one day measured 2.93 billion
cache-read tokens across all projects at 238k of context per turn, and the orchestrators' context
length was the cost) this extension makes that deliberate instead:

1. **Bank** — the orchestrator is asked to write its working memory to
   `~/.claude/loom/<project>/<role>/memory.md`: what it is doing, what each role owes it, decisions
   already made, open questions, and an UNSURE section. It is asked to write **tight** — every line
   earning its place, because the next session re-reads the whole file before it has done any work —
   **and it is given no byte target, deliberately.** `Keep it under 12,000 bytes` used to be in that
   prompt, and on 2026-09-15 it made an orchestrator trim its own memory and destroy the section
   recording the owner's stated product goal, the most important thing in the file, twice in one day,
   then argue the cap was "advisory" to justify what was left. An imperative with a measurable target,
   handed to an agent, about the one artifact that survives its own erasure, buys bytes with facts.
   A test fails if any agent-facing memory prompt names a byte count, a ceiling, or the threshold, in
   any spelling — while the **context** percentage stays, since that is the trigger for the cycle and
   not a rule about how long a file may be. What keeps the working memory small is the split, said
   plainly in both prompts: durable lessons go to `<role>/notes.md`, appended and never rewritten,
   and a deletion made for room is redirected there rather than out of existence. The restore prompt
   reads the notes **even when the working memory is short**, which is when more of what matters is
   in them. `MIN_MEMORY_BYTES` (200) stays — it is evidence a file was written before a `/clear`
   destroys the session, not a target for prose; the large-memory threshold survives only as an
   internal figure the panel may observe, never as a sentence an agent reads.
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
| `work ledger — what the agents actually produced` | The full report, as a markdown document: every figure with its raw numbers, the most-touched files, and a per-handoff table. A document rather than a webview so it can be pasted straight into a handoff. |

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
| `enforceOrchestratorModel` / `orchestratorModel` | `true` / `claude-fable-5-1[1m]` | Put the tagged orchestrator back on it when a restore drops it to the pin, unless it asked for a tier of its own |
| `orchestratorModels` | `claude-fable-5-1[1m]`, `claude-opus-5`, `claude-sonnet-5` | The tiers an orchestrator may put *itself* on by writing `<repo>/orchestrator-model.json` (MS-001); anything else is refused with a note |
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
| `workLedgerEnabled` | `true` | Measure what each project PRODUCED, from git and the transcripts, and show it above that project's agents |
| `productPaths` | ReciEats, pleodo | Repo → globs of what ships to a user. An unlisted repo falls back to a heuristic and the panel says so. An empty list means "nothing here ships" and is honoured as configuration |
| `excludePaths` | `**/*.test.*`, `**/*.spec.*`, `**/__tests__/**`, `**/__mocks__/**` | Subtracted from product whatever `productPaths` matches, and counted as rig instead. Its own list, so what was taken out is visible. Without it, 39,150 of ReciEats' 63,225 "product" lines in the audited week were tests under `src/` |
| `workLedgerWindowDays` / `workLedgerIntervalMin` | `7` / `10` | Days of history measured; minimum minutes between recomputes (the tick reads the cache in between) |
| `workLedgerThresholds` | see below | `shipsGood` 40 / `shipsBad` 20 · `loopBackGood` 20 / `loopBackBad` 50 · `narrationGood` 10 / `narrationBad` 25 · `costPerLine` `0.25` dollars per net product line. Read field by field, so a partial object works |
| `modelPrices` | list prices | `[input, output, cacheRead, cacheWrite1h]` per MTok, for the list-price-equivalent figure only — this work runs on a subscription and nobody is invoiced it |

## Files it touches

**Moves, not deletes — with one exception:** garbage collection archives under `~/.claude/loom/_archive/<date>/`
(`extensions/`, `transcripts/<projectdir>/`, `backups/`) and records every move in `gc-debug.json`.
It is the only thing here that touches `~/.vscode-oss/extensions`.

**Reads, never writes:** `<project>/board.json` (the roster), `<project>/bindings.json` (written by
`loom_cdp.py` at `/loom` time), each role's `status.json`/`inbox.md`/`outbox.md`,
`<project>/orchestrator-model.json` (the orchestrator's own tier request, MS-001), and
`~/.claude/projects/*/<sessionId>.jsonl` — the last of these also for WL-001's token
accounting, which sums each assistant message's `usage` (cache reads included) by model.

**Writes** (all atomic, change-only, and never fatal if they fail):
`<project>/targetmap.json`, `orchestrator.json`, `session-locks.json`, `notify-state.json`,
`limit-state.json`, `model-policy.json`, `stall-state.json`, `context-state.json`,
`work-ledger.json` (the work-ledger figures, their `computedAt`, and the day the
orchestrator was last told — WL-001); globally
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
./test.sh                                      # 659 checks, 40 files, no test framework
./test.sh notifier                             # filter by name
rm -rf /tmp/cov && NODE_V8_COVERAGE=/tmp/cov ./test.sh && python3 ../tools/coverage.py /tmp/cov out
./live.sh                                      # invariants against the live editor
```

Tests run under the editor's bundled node (no npm needed) and force `HOME` to a throwaway
directory, so they can never touch the real bus. The CDP layer is driven against a fake DevTools
server, so the reader's nesting, two-pass and timeout behaviour is tested without a browser.

A note on what the suite is *for*. It sits at 93.1% of lines (5640/6060, measured 2026-09-13 at
0.34.0; `LOOM_TEST_JOBS=1` reads 93.3%, the 12 extra lines being state leaked between test files
that share one `HOME`), and it caught none of the four
defects found on 2026-09-08/09 — every fixture in it was written from the same model of the world as
the code, so where the model was wrong, the tests agreed. Coverage tells you which lines ran, never
which realities you considered. `live.sh` and measuring the real system are the other half;
when you change something here, check both.

Each module states its one job and the measurement behind its decisions at the top of the file —
start there. The parent [README](../README.md) carries the cross-extension notes, and
`~/.claude/loom/ORCHESTRATION-PLAYBOOK.md` describes the Loom pattern this serves.
