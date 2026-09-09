// fake-devtools.js — a minimal server that speaks enough of the Chrome DevTools Protocol to drive
// cdp.ts for real: the HTTP discovery endpoints plus a websocket that answers auto-attach and
// Runtime.evaluate. This is what lets the protocol half of cdp.ts be tested without a browser.
//
// It deliberately models the shape that matters to the reader: targets attach as EVENTS after
// Target.setAutoAttach (they are not in /json/list), and a child only reveals its own children
// after that child session is itself armed — the OOPIF grandchild case the reader exists for.
const http = require("http");
const WebSocket = require("ws");

/**
 * @param {object} o
 *  targets:      [{ sessionId, url, type, text | texts[], contextPct }]  attached at the root
 *                contextPct makes the target answer with the real envelope {t,c} that the reader
 *                sends (innerText + the compact button's "% context used"); without it the target
 *                answers a bare string, which the reader must still accept.
 *  grandchildren:{ [parentSessionId]: [{ sessionId, url, type, text }] } revealed once the parent is armed
 *  dropEvaluate: never answer Runtime.evaluate
 *  detachAfterAttach: [sessionId] emit Target.detachedFromTarget right after attaching
 *  chatter:      keep emitting junk events so the settle window never elapses (exercises the hard cap)
 *  badVersion:   /json/version returns something with no webSocketDebuggerUrl
 *  listTargets:  what /json/list returns (for closeWebview)
 */
async function startFakeDevTools(o = {}) {
  const targets = o.targets || [];
  const grandchildren = o.grandchildren || {};
  const closed = [];
  let chatterTimer = null;

  const server = http.createServer((req, res) => {
    const url = req.url || "";
    const json = (body) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
    if (url.startsWith("/json/version")) {
      if (o.badVersion) return json({ Browser: "fake", note: "no debugger url" });
      return json({ Browser: "fake", webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/browser/fake` });
    }
    if (url.startsWith("/json/list")) return json(o.listTargets || []);
    if (url.startsWith("/json/close/")) {
      closed.push(decodeURIComponent(url.slice("/json/close/".length)));
      res.writeHead(200, { "content-type": "text/plain" });
      return res.end("Target is closing");
    }
    res.writeHead(404); res.end("nope");
  });

  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;

  const wss = new WebSocket.Server({ server });
  wss.on("connection", (sock) => {
    const evalCounts = new Map();     // sessionId -> how many evaluates it has answered
    const attach = (t) => sock.send(JSON.stringify({
      method: "Target.attachedToTarget",
      params: { sessionId: t.sessionId, targetInfo: { url: t.url, type: t.type || "iframe" } },
    }));
    if (o.chatter) {
      chatterTimer = setInterval(() => {
        try { sock.send(JSON.stringify({ method: "Runtime.consoleAPICalled", params: { noise: Date.now() } })); }
        catch { /* closed */ }
      }, 30);
    }
    sock.on("message", (raw) => {
      let m; try { m = JSON.parse(raw.toString()); } catch { return; }
      const reply = (result) => sock.send(JSON.stringify({ id: m.id, result: result || {} }));
      if (m.method === "Target.setAutoAttach") {
        reply();
        if (!m.sessionId) {
          for (const t of targets) attach(t);
          for (const sid of o.detachAfterAttach || []) {
            sock.send(JSON.stringify({ method: "Target.detachedFromTarget", params: { sessionId: sid } }));
          }
        } else {
          // the parent has been re-armed -> now its own children can attach
          for (const t of grandchildren[m.sessionId] || []) attach(t);
        }
        return;
      }
      if (m.method === "Runtime.enable") return reply();
      if (m.method === "Runtime.evaluate") {
        if (o.dropEvaluate) return;                       // silence: the reader must still finish
        const sid = m.sessionId;
        const all = [...targets, ...Object.values(grandchildren).flat()];
        const t = all.find((x) => x.sessionId === sid) || {};
        const n = evalCounts.get(sid) || 0;
        evalCounts.set(sid, n + 1);
        // `texts` lets a target answer differently on the first and second pass
        const text = Array.isArray(t.texts) ? (t.texts[Math.min(n, t.texts.length - 1)] || "") : (t.text || "");
        const pcts = Array.isArray(t.contextPcts) ? t.contextPcts[Math.min(n, t.contextPcts.length - 1)] : t.contextPct;
        const value = (t.contextPct !== undefined || t.contextPcts !== undefined)
          ? JSON.stringify({ t: text, c: pcts === undefined ? null : pcts })
          : text;
        return reply({ result: { type: "string", value } });
      }
      reply();
    });
  });

  return {
    port,
    closed,
    async close() {
      if (chatterTimer) clearInterval(chatterTimer);
      for (const c of wss.clients) { try { c.terminate(); } catch { /* */ } }
      await new Promise((r) => wss.close(r));
      await new Promise((r) => server.close(r));
    },
  };
}

module.exports = { startFakeDevTools };
