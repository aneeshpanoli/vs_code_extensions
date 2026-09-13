// return-address.test.js — every message the extension sends says who it is from and how to answer.
// User rule 2026-09-12: "any time any session communicates with another, it should always broadcast
// its ID and how to communicate back." loom_cdp.py adds the header; this side must always hand it the
// sender and the reply channel, on EVERY inject path — including the two that bypass injectTo.
const { suite, ok, eq, match, load } = require("./harness");
const { senderArgs, setSenderWindow, REPLY_FOR } = load("inject.js");
const fs = require("fs"), path = require("path");

suite("return-address: the extension names itself, its window, its project, and a reply channel", () => {
  setSenderWindow("tfg_ua");
  const a = senderArgs("notify-debug.json", "tfg_ua");
  eq(a[0], "--from"); match(a[1], /loom-session-tracker/); match(a[1], /window tfg_ua/); match(a[1], /project tfg_ua/);
  eq(a[2], "--reply"); match(a[3], /reads no chat/, "a session is told the tool will not read a chat reply");
  match(senderArgs("restart-debug.json", "ReciEats")[3], /ReciEats\/open-requests\.json/, "the restart wake points at the channel that IS read");
  match(senderArgs("something-new", null)[3], /not a session/, "an unknown kind still gets an honest reply line");
  for (const k of Object.keys(REPLY_FOR)) ok(REPLY_FOR[k].length > 10, `${k} has a real reply line`);
});

suite("return-address: every inject the extension performs carries --from", () => {
  // Source-level, over the COMPILED output: the three inject sites (injectTo, models.ts, limits.ts)
  // must all pass senderArgs. A new inject site that forgets it fails here.
  const out = path.join(__dirname, "..", "out");
  for (const f of ["inject.js", "models.js", "limits.js"]) {
    const src = fs.readFileSync(path.join(out, f), "utf8");
    const sites = (src.match(/"inject",\s*"--role"/g) || []).length;
    ok(sites >= 1, `${f} has an inject site`);
    // The CALL SITE, not the mere presence of the name: inject.js defines senderArgs, so a stripped
    // call there still left the word in the file and a mutant survived. tsc emits an imported call as
    // `(0, inject_1.senderArgs)(...)` and a local one as `senderArgs(...)`; either must follow the
    // spread inside the argv array.
    ok(/\.\.\.(?:\(0,\s*\w+\.)?senderArgs\)?\s*\(/.test(src),
      `${f}: the inject argv spreads senderArgs(...) — the return address is actually passed`);
  }
});
