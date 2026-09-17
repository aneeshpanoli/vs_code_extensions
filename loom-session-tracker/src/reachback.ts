// reachback.ts — ONE JOB: every handoff sitting in a role's inbox carries a way to reach its sender.
//
// PLAYBOOK §11, a standing user directive since 2026-09-08: "every handoff any loom role writes to
// another role's inbox MUST end with a HOW TO REACH ME BACK block, so the round-trip never stalls
// waiting for a human relay." It is forgotten across buses, and the owner's complaint (2026-09-17)
// is not that the wording needs work:
//
//   "I'm not asking you to write a hundred million lines of recommendations to them, but there has
//    to be an in-built mechanism to prevent these directives falling through the cracks."
//
// THE RANK THIS TAKES, AND WHY NOT THE ONE ABOVE IT.
//
//   1 IMPOSSIBLE  — refuse the wrong thing at a chokepoint (CX-001: an orchestrator can never be
//                   cleared, whatever any caller passes).
//   2 SUPPLIED    — the tool provides the thing, so nobody has to remember it.   <-- THIS FILE
//   3 DETECTED    — remind, when only the orchestrator can decide the right action.
//   4 TEXT ONLY   — a recommendation. The class of fix the owner rejected.
//
// Rank 1 here would mean REFUSING to deliver a handoff that carries no reach-back — refusing the
// wake, or refusing to open the ledger line. It was rejected on its failure mode, not on effort. A
// refusal's cost lands on whoever is waiting: the worker is never told, the orchestrator is
// mid-dispatch and has already moved on, and the block sits until a human notices. That silent
// stall is the EXACT outcome §11 was written to prevent (shwab_docker TR-027: "the PO finished a
// critical deploy but had no instruction to ring the trader back; the loop stalled until the human
// relayed manually"). A guard whose failure mode is the thing it guards against is not a guard.
//
// The deciding difference from CX-001 is that there, the right action was UNKNOWABLE to the tool —
// only the orchestrator knows what its context is worth, and a wrong `/clear` destroys something
// that cannot be rebuilt, so refusing was the only safe move. Here the right action is fully
// COMPUTABLE from facts this extension already holds: who the orchestrator is (`orchestrator.json`),
// the id file that addresses it (`<repo>/<role>.id`, which the tracker itself maintains — RB-001),
// the literal first line a watcher greps for (`# RESPONSE <id>`, from the inbox's own frontmatter)
// and the status.json fallback. Refusing to deliver something you could simply write is a worse
// trade than writing it. So: supply it, and produce no message at all.
//
// THAT LAST CLAUSE IS THE POINT. Ranks 1 and 2 are the two that add nothing to anybody's transcript.
// A bus full of reminders is the owner's own complaint moved off him and onto the agents, so a block
// that ends with FEWER messages than it started is the better outcome. This file sends none.

import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { getOrchestrator } from "./orchestrator";
import { frontmatter } from "./models";

const LOOM_ROOT = path.join(os.homedir(), ".claude", "loom");

/** The marker a supplied block carries, so a second pass can recognise its own work and never
 *  append twice. It is also what a human grepping a bus can search for. */
export const REACHBACK_MARK = "<!-- loom-reachback -->";

/**
 * Does this inbox text ALREADY tell the worker how to reach back?
 *
 * Deliberately generous. The question this answers is "would a worker reading this file know how to
 * answer", and an orchestrator that wrote its own block in its own words has done the right thing —
 * appending a second, differently-worded block underneath it would be the tool arguing with a
 * session that already complied. False NEGATIVES here cost one redundant block in a file; false
 * POSITIVES cost a stalled round-trip. So anything that names the reach tool, names an id file, or
 * heads a section with the words of §11 counts as present.
 */
export function hasReachBack(text: string): boolean {
  const t = String(text || "");
  if (!t.trim()) return false;
  if (t.includes(REACHBACK_MARK)) return true;
  if (/reach_po\.py|safe_inject\.py|ring\.py/i.test(t)) return true;
  if (/how to reach (me|us) back|reach[- ]back|reaching me back/i.test(t)) return true;
  // An `@<repo>/<role>.id` reference IS an address, whatever prose surrounds it.
  if (/@[\w.-]+\/[\w.-]+\.id\b/.test(t)) return true;
  return false;
}

/** Everything the block is built from. All of it is observed; none of it is asked for. */
export interface ReachBackFacts {
  repo: string;
  /** The role the handoff is FOR — the reader of the block. */
  role: string;
  /** The orchestrator that wrote it, from `orchestrator.json`. */
  sender: string;
  /** The handoff's own id, from the inbox frontmatter. `# RESPONSE <id>` is what a watcher greps. */
  id: string;
}

/**
 * The block itself.
 *
 * It is instructions to a WORKER about mechanics, not a rule recited at an orchestrator, so the §21
 * reporting contract has no business here and `injectTo` never sees it — this text is written to a
 * file, not typed into anyone's composer.
 *
 * Every line is one the playbook's own §11 pays for in stalled loops:
 *  - the outbox FIRST and under the literal heading, because a fine reply under a different heading
 *    stalled ReciEats DEV-031 until a human noticed;
 *  - the ring ALWAYS, never "the outbox reached them" — a watcher dies with every context clear and
 *    the worker cannot observe that (DEV-041, finished and green at 22:38, picked up by a human);
 *  - the id FILE, never an id copied inline, because a webviewId dies with its session (DEV-047);
 *  - and the status.json fallback with the word REFUSED named, so a stale id is legible as staleness
 *    rather than as silence.
 */
export function reachBackBlock(f: ReachBackFacts): string {
  return [
    REACHBACK_MARK,
    "",
    "## HOW TO REACH ME BACK",
    "",
    `Supplied by loom-session-tracker from this bus's own records (playbook §11), not by ${f.sender}.`,
    "",
    `1. Write your response to \`~/.claude/loom/${f.repo}/${f.role}/outbox.md\`, and make its literal`,
    `   first line \`# RESPONSE ${f.id}\` — that exact string is what a watcher greps for.`,
    `2. Then ring me. This is mandatory, not a fallback — the outbox alone only reaches an`,
    "   orchestrator whose watcher is still alive, and you cannot see whether it is:",
    "",
    `       python3 ~/.claude/loom/reach_po.py @${f.repo}/${f.sender}.id "Loom ${f.role}: ${f.id} — <one-line gist>"`,
    "",
    "   Run it from your WORKTREE, so the return address derives from your cwd. Paste what it printed.",
    `3. If it prints REFUSED / NOT SENT, my id is stale: set \`status.json\`'s \`last_line\` to`,
    `   \`${f.sender.toUpperCase()} ATTENTION: <gist>\` AND say at the TOP of your outbox that the ring`,
    "   failed, so the stall is visible to whoever looks next.",
    "",
  ].join("\n");
}

function inboxFile(repo: string, role: string): string {
  return path.join(LOOM_ROOT, repo, role, "inbox.md");
}

export type SupplyOutcome =
  | { supplied: true; note: string }
  | { supplied: false; note: string };

/**
 * Append the block to a role's inbox, if and only if it is missing.
 *
 * `expectId` is re-checked against the file at write time and the write is tmp+rename, both for the
 * reason `rewriteHandoffModel` gives: playbook §12 step 2 has the orchestrator overwrite `inbox.md`
 * with the NEXT brief as its first move after banking, and a tick can land inside that window. A
 * half-written inbox must never be what a `/loom` bind reads, and a block appended to a brief that
 * has already been replaced would name the wrong id in its `# RESPONSE` line — worse than no block.
 *
 * WHAT THIS CANNOT PROMISE, said plainly. The supply lands on the first tick that sees the handoff,
 * which is up to one tick (15 s) after the orchestrator wrote it. §12's order gives that room — the
 * inbox is written, THEN the worker is cleared, THEN it is bound — but an orchestrator that writes
 * an inbox and binds the worker inside the same 15 seconds gets a worker that read the file before
 * the block landed. It is not silently ignored afterwards: the check runs on every tick the id is
 * still current, so the block is there for any later read, and the worker's own `/loom` re-bind
 * re-reads the file. A narrower window would need the tool to watch the file rather than the tick,
 * which is a bigger change than this block's evidence justifies.
 */
export function supplyReachBack(repo: string | null, role: string, expectId: string | null,
                                senderRole?: string | null): SupplyOutcome {
  if (!repo || !role) return { supplied: false, note: "no repo/role" };
  if (!expectId) return { supplied: false, note: "no handoff id in the inbox — nothing to address" };
  // The sender is the orchestrator of THIS bus. Untagged, there is no return address to supply and
  // nothing is written: an invented one would send a worker's reply into whatever frame answered,
  // which is the fingerprint route §13 bans outright.
  const tag = senderRole ? { role: senderRole } : getOrchestrator(repo);
  if (!tag || !tag.role) {
    return { supplied: false, note: "bus has no tagged orchestrator — no return address to supply" };
  }
  // A role does not write handoffs to itself.
  if (tag.role === role) return { supplied: false, note: "role is the orchestrator — not a handoff" };
  const f = inboxFile(repo, role);
  let text: string;
  try { text = fs.readFileSync(f, "utf8"); }
  catch { return { supplied: false, note: "no readable inbox.md" }; }
  // THE ID RE-CHECK, against the very bytes about to be rewritten. Not a formality: the block names
  // `# RESPONSE <expectId>`, so appending it to a brief that has already been replaced would hand
  // the worker the PREVIOUS block's reply heading — a reply nobody's watcher greps for, which is
  // DEV-031's stall with the tool's own fingerprints on it. Worse than supplying nothing.
  if (String(frontmatter(text)["id"] || "") !== expectId) {
    return { supplied: false, note: "inbox holds a different handoff now — not appending" };
  }
  if (hasReachBack(text)) return { supplied: false, note: "already carries a reach-back" };
  const block = reachBackBlock({ repo, role, sender: tag.role, id: expectId });
  const next = text.replace(/\s*$/, "") + "\n\n" + block;
  try {
    const tmp = f + ".tmp." + process.pid;
    fs.writeFileSync(tmp, next);
    fs.renameSync(tmp, f);
  } catch { return { supplied: false, note: "inbox not writable" }; }
  return { supplied: true, note: `reach-back supplied for ${expectId} -> ${tag.role}` };
}
