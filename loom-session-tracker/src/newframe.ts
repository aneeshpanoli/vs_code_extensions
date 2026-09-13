// newframe.ts — ONE JOB: open ONE tab, then say which frame it turned out to be. Nothing else.
//
// WHY IT IS SHARED. `serveOpenRequests` already did this inline: snapshot every webviewId, open a
// tab, wait, read again, and if EXACTLY ONE id is new, that is the tab. `restartReopen` did not — it
// opened every previously-live role in a loop and never learned which frame any of them was, which
// is half of why the bus was left holding dead ids after the 2026-09-13 restart. One implementation
// now, so the two paths cannot drift, and so the rule below is stated once.
//
// AMBIGUITY REPORTS NOTHING. Zero new frames (the open failed, or the panel has not rendered yet) and
// two or more (something else opened a tab in the same window of time) both yield null. A wrong
// answer here is written to `bindings.json`, `board.json` and an id file and then injected into; a
// null merely means the tracker's session-id match heals it on the next tick instead.

export interface FrameLike { webviewId?: string | null }

export interface FrameWatcher {
  /** Take the "before" snapshot. Call once, before opening anything. */
  seed(): Promise<void>;
  /** Adopt a snapshot already read for another purpose, instead of paying for a second CDP read. */
  seedFrom(frames: FrameLike[]): void;
  /** After ONE open: the id of the single new frame, or null if it cannot be told apart. */
  next(): Promise<string | null>;
}

export interface WatchOpts {
  /** How long to let the new panel render before reading. Production is 2500 ms. */
  settleMs?: number;
  /** Injected so tests do not sleep. */
  sleep?: (ms: number) => Promise<void>;
}

/** One role to bring back: its name and the transcript to reopen it from. */
export interface OpenOne { role: string; sessionId: string }

/** What `openAndIdentify` reports as it goes. Every outcome is named; none is silent. */
export interface OpenSink {
  /** Exactly one new frame appeared after opening this role — this is its webviewId. */
  identified(role: string, webviewId: string): void;
  /** The open command itself threw. */
  failed(role: string, error: string): void;
  /** The tab opened but 0 or ≥2 frames appeared, so which one it is cannot be known. */
  ambiguous(role: string): void;
}

/**
 * Open each role's transcript ONE AT A TIME and say which frame each turned out to be.
 *
 * One at a time is the whole point: the previous restart path opened every previously-live role in a
 * tight loop and then diffed nothing, so it could never attribute a frame to a role and left the bus
 * holding dead ids. Interleaving opens would make the diff ambiguous by construction — two tabs
 * appearing between two reads are indistinguishable — so the loop is deliberately serial and slow.
 *
 * Returns how many opens actually succeeded (the count the status bar reports).
 */
export async function openAndIdentify(todo: OpenOne[], open: (sessionId: string) => PromiseLike<unknown>,
                                      watcher: FrameWatcher, sink: OpenSink): Promise<number> {
  let n = 0;
  for (const m of todo) {
    try { await open(m.sessionId); n++; }
    catch (e: any) { sink.failed(m.role, String(e && e.message || e)); continue; }
    const wid = await watcher.next();
    if (wid) sink.identified(m.role, wid); else sink.ambiguous(m.role);
  }
  return n;
}

export function frameWatcher(read: () => Promise<FrameLike[]>, opts: WatchOpts = {}): FrameWatcher {
  const settleMs = opts.settleMs ?? 2500;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const seen = new Set<string>();
  const absorb = (frames: FrameLike[]) => { for (const f of frames) if (f.webviewId) seen.add(String(f.webviewId)); };
  return {
    async seed(): Promise<void> {
      try { absorb(await read()); } catch { /* no baseline -> every later frame looks new -> ambiguous -> null */ }
    },
    seedFrom(frames: FrameLike[]): void { absorb(frames); },
    async next(): Promise<string | null> {
      await sleep(settleMs);
      try {
        const now = (await read()).filter((f) => f.webviewId && !seen.has(String(f.webviewId)))
          .map((f) => String(f.webviewId));
        // Every id seen this round is absorbed even when the answer is ambiguous, so that the NEXT
        // open in the loop is not told about tabs that were already there.
        for (const w of now) seen.add(w);
        return now.length === 1 ? now[0] : null;
      } catch { return null; }
    },
  };
}
