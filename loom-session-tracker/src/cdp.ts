// cdp.ts — ONE JOB: read every live session frame's (webviewId, url, text) over CDP. Nothing else.
// FAIL-PROOF CONTRACT: readFrames() NEVER throws and NEVER hangs. On any error (endpoint down, socket
// wedged, timeout) it returns [] and the caller keeps its last-known-good map. Every socket op is
// hard-bounded by a wall clock; the socket is always closed in a finally.

import * as http from "http";
import * as fs from "fs";
import * as os from "os";
import WebSocket from "ws";

export interface Frame {
  webviewId: string | null; url: string; text: string;
  /** The panel's OWN "% context used", read off the compact button's title attribute. null when the
   *  button is absent — which the shipped webview does deliberately below 50% used (see CONTEXT_RE). */
  contextPct: number | null;
}

/** Timing overrides. Defaults are the production constants; tests drive the protocol fast. */
export interface ReadOpts { settleMs?: number; hardCapMs?: number; }

const HARD_CAP_MS = 20000;   // absolute wall clock for one readFrames() — it can never exceed this
const SETTLE_MS = 1800;      // stop early after this much silence (quiet roster returns fast)
const RECV_IDLE_MS = 1200;   // per-recv idle slice

// The IDE writes its live CDP port to DevToolsActivePort. Check known IDE dirs, else 9222.
export function cdpPort(): number {
  for (const cfg of ["VSCodium", "VSCodium - Insiders", "Antigravity", "Code", "Code - OSS", "Cursor"]) {
    try {
      const p = `${os.homedir()}/.config/${cfg}/DevToolsActivePort`;
      const n = parseInt(fs.readFileSync(p, "utf8").split("\n")[0].trim(), 10);
      if (Number.isFinite(n)) return n;
    } catch { /* try next */ }
  }
  return 9222;
}

function httpJson(host: string, port: number, path: string, timeoutMs: number): Promise<any> {
  return new Promise((resolve, reject) => {
    const req = http.get({ host, port, path, timeout: timeoutMs }, (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => { try { resolve(JSON.parse(body)); } catch (e) { reject(e); } });
    });
    req.on("error", reject);
    req.on("timeout", () => req.destroy(new Error("http timeout")));
  });
}

// Recursive innerText grab, descending into #active-frame and nested same-process iframes (depth 4) —
// the OOPIF conversation lives there, NOT in the empty webview shell body.
//
// It ALSO pulls the context-usage percentage, which innerText cannot see. Read out of the shipped
// webview bundle (2.1.263), the compact button renders as
//     <button title="73% context used — click to compact"><svg pie/></button>
// i.e. the number lives in an ATTRIBUTE and in a hover-only popup ("N% of context remaining until
// auto-compact." / "Click to compact now.") — never in text. The button is rendered only when
// `100 - used >= 50` is false, so its mere presence means the session is past 50% used, and its
// denominator is the app's own `contextWindow - maxOutputTokens - 13000`. That is a better number
// than anything computed outside the app, so it wins when it is there.
const DEEP_READ =
  "(function(){function g(d,k){var t=(d&&d.body)?(d.body.innerText||''):'';" +
  "if(k>0&&d&&d.querySelectorAll){var f=d.querySelectorAll('iframe');" +
  "for(var i=0;i<f.length;i++){try{var c=f[i].contentDocument;if(c)t+='\\n'+g(c,k-1);}catch(e){}}}return t;}" +
  "function p(d,k){try{var b=d.querySelectorAll('button[title]');" +
  "for(var i=0;i<b.length;i++){var m=/([0-9]{1,3})% context used/.exec(b[i].getAttribute('title')||'');" +
  "if(m)return parseInt(m[1],10);}}catch(e){}" +
  "if(k>0&&d&&d.querySelectorAll){var f=d.querySelectorAll('iframe');" +
  "for(var i=0;i<f.length;i++){try{var c=f[i].contentDocument;" +
  "if(c){var r=p(c,k-1);if(r!==null)return r;}}catch(e){}}}return null;}" +
  "return JSON.stringify({t:g(document,4),c:p(document,4)});})()";

/** The reader's payload. A plain string (no envelope) is still accepted as text with no percentage. */
export function parseRead(value: string): { text: string; contextPct: number | null } {
  if (value.charCodeAt(0) === 123 /* { */) {
    try {
      const o = JSON.parse(value);
      if (o && typeof o === "object" && typeof o.t === "string") {
        return { text: o.t, contextPct: typeof o.c === "number" && isFinite(o.c) ? o.c : null };
      }
    } catch { /* not our envelope — treat it as text */ }
  }
  return { text: value, contextPct: null };
}

const WEBVIEW_ID_RE = /[?&]id=([0-9a-f][0-9a-f-]+)/i;
function webviewId(url: string): string | null {
  const m = WEBVIEW_ID_RE.exec(url || "");
  return m ? m[1] : null;
}

const AUTO_ATTACH = {
  autoAttach: true, flatten: true, waitForDebuggerOnStart: false,
  filter: [{ type: "page", exclude: false }, { type: "iframe", exclude: false }, { type: "webview", exclude: false }],
};

/**
 * Read every attached frame over ONE browser websocket (recursive auto-attach reaches all windows/OOPIFs).
 * NEVER throws, NEVER hangs (bounded by HARD_CAP_MS). Returns [] on any failure.
 */
export async function readFrames(host = "127.0.0.1", port = cdpPort(), opts: ReadOpts = {}): Promise<Frame[]> {
  const settleMs = opts.settleMs ?? SETTLE_MS;
  const deadline = Date.now() + (opts.hardCapMs ?? HARD_CAP_MS);
  let ws: WebSocket | null = null;
  try {
    const ver = await httpJson(host, port, "/json/version", 3000);
    const wsUrl = ver && ver.webSocketDebuggerUrl;
    if (!wsUrl) return [];
    ws = await connect(wsUrl, deadline);
    if (!ws) return [];

    let idCtr = 1;
    const sessions = new Map<string, any>();   // sessionId -> targetInfo
    const armed = new Set<string>();
    const text = new Map<string, { text: string; contextPct: number | null }>();   // sessionId -> best read
    const socket = ws;

    const send = (method: string, params?: any, sessionId?: string): number => {
      const id = idCtr++;
      const msg: any = { id, method, params: params || {} };
      if (sessionId) msg.sessionId = sessionId;
      try { socket.send(JSON.stringify(msg)); } catch { /* ignore; pump will time out */ }
      return id;
    };
    const arm = (sid: string) => {
      if (armed.has(sid)) return;
      armed.add(sid);
      send("Runtime.enable", undefined, sid);
      send("Target.setAutoAttach", AUTO_ATTACH, sid);   // re-arm per child so grandchild OOPIFs attach
    };

    // pump: process events (register+arm children) + collect evaluate results, bounded by settle + deadline.
    const pump = (wantId: number | null): Promise<Map<number, any>> => new Promise((resolve) => {
      const results = new Map<number, any>();
      let last = Date.now();
      const onMsg = (raw: WebSocket.RawData) => {
        last = Date.now();
        let msg: any;
        try { msg = JSON.parse(raw.toString()); } catch { return; }
        if (typeof msg.id === "number") {
          results.set(msg.id, msg.result);
          if (wantId !== null && msg.id === wantId) finish();
          return;
        }
        if (msg.method === "Target.attachedToTarget") {
          const sid = msg.params.sessionId;
          if (!sessions.has(sid)) { sessions.set(sid, msg.params.targetInfo || {}); arm(sid); }
        } else if (msg.method === "Target.detachedFromTarget") {
          const sid = msg.params.sessionId; sessions.delete(sid); armed.delete(sid);
        }
      };
      // Poll finely enough that a short settle window is still observed.
      const tickMs = Math.max(10, Math.min(150, Math.floor(settleMs / 3)));
      const tick = setInterval(() => {
        const now = Date.now();
        if (now >= deadline) return finish();
        if (wantId === null && now - last >= settleMs) return finish();
      }, tickMs);
      let done = false;
      const finish = () => {
        if (done) return; done = true;
        clearInterval(tick);
        socket.off("message", onMsg);
        resolve(results);
      };
      socket.on("message", onMsg);
      // safety: also bound each pump by the idle slice via the interval above + the hard deadline.
      setTimeout(() => finish(), Math.max(0, deadline - Date.now()));
    });

    // root auto-attach, let the storm roll, then two-pass deep-text read.
    send("Target.setAutoAttach", AUTO_ATTACH);
    await pump(null);
    const pending = new Map<number, string>();
    for (const sid of Array.from(sessions.keys()))
      pending.set(send("Runtime.evaluate", { expression: DEEP_READ, returnByValue: true }, sid), sid);
    const r1 = await pump(null);
    for (const sid of Array.from(sessions.keys()))
      pending.set(send("Runtime.evaluate", { expression: DEEP_READ, returnByValue: true }, sid), sid);
    const r2 = await pump(null);
    const merged = new Map<number, any>([...r1, ...r2]);
    for (const [id, sid] of pending) {
      const res = merged.get(id);
      const val = res && res.result && res.result.type === "string" ? (res.result.value || "") : "";
      if (!val) continue;
      const read = parseRead(val);
      const prev = text.get(sid);
      // Longest text wins (a partial render must not beat a full one), but a percentage seen on
      // EITHER pass is kept: the button can be missing from one read and present in the next.
      if (!prev || read.text.length > prev.text.length) {
        text.set(sid, { text: read.text, contextPct: read.contextPct ?? (prev ? prev.contextPct : null) });
      } else if (prev.contextPct === null && read.contextPct !== null) {
        text.set(sid, { ...prev, contextPct: read.contextPct });
      }
    }

    const frames: Frame[] = [];
    for (const [sid, info] of sessions) {
      const url = (info && info.url) || "";
      const read = text.get(sid);
      frames.push({ webviewId: webviewId(url), url, text: read ? read.text : "",
                    contextPct: read ? read.contextPct : null });
    }
    return frames;
  } catch {
    return [];   // FAIL-PROOF: any error -> empty, caller keeps last-known-good
  } finally {
    try { ws && ws.close(); } catch { /* ignore */ }
  }
}

/**
 * Close the editor tab hosting a session, by its stable webviewId, via CDP Target.closeTarget.
 * NEVER throws. Returns {ok, note}. NOTE: closing a VS Code webview editor via CDP is UNPROVEN to be
 * clean — the caller MUST have verified it on a throwaway before trusting it. This only sends the close;
 * it does not decide WHAT may be closed (that boundary lives in the coordinator).
 */
export async function closeWebview(webviewId: string, host = "127.0.0.1", port = cdpPort()): Promise<{ ok: boolean; note: string }> {
  try {
    const targets = await httpJson(host, port, "/json/list", 3000);
    if (!Array.isArray(targets)) return { ok: false, note: "no target list" };
    const hit = targets.find((t: any) => {
      const m = WEBVIEW_ID_RE.exec(t.url || "");
      return m && m[1] === webviewId;
    });
    if (!hit) return { ok: false, note: `no live target for webviewId ${webviewId.slice(0, 8)}` };
    // CDP HTTP close endpoint (simplest, no socket): GET /json/close/<targetId>
    const res = await new Promise<string>((resolve, reject) => {
      const req = http.get({ host, port, path: `/json/close/${hit.id}`, timeout: 4000 }, (r) => {
        let b = ""; r.on("data", (c) => (b += c)); r.on("end", () => resolve(b));
      });
      req.on("error", reject);
      req.on("timeout", () => req.destroy(new Error("close timeout")));
    });
    return { ok: /closing|target is closing/i.test(res) || res.trim() === "", note: res.trim() || "closed" };
  } catch (e: any) {
    return { ok: false, note: String(e && e.message || e).slice(0, 100) };
  }
}

function connect(wsUrl: string, deadline: number): Promise<WebSocket | null> {
  return new Promise((resolve) => {
    let settled = false;
    let ws: WebSocket;
    try { ws = new WebSocket(wsUrl, { perMessageDeflate: false, maxPayload: 0 }); }
    catch { return resolve(null); }
    const done = (v: WebSocket | null) => { if (!settled) { settled = true; resolve(v); } };
    ws.once("open", () => done(ws));
    ws.once("error", () => { try { ws.close(); } catch { /* */ } done(null); });
    setTimeout(() => { if (!settled) { try { ws.close(); } catch { /* */ } done(null); } },
      Math.min(4000, Math.max(0, deadline - Date.now())));
  });
}
