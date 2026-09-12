// window-close.test.js — nothing in this extension may close an editor window by accident.
//
// 2026-09-12: the restart path closed three "blank" Claude panels over CDP `/json/close` and three
// editor WINDOWS closed with them (Gaming, funisland, shwab_docker). A Claude panel is an
// out-of-process iframe; closing its target closes the WebContents that owns it, i.e. the window.
// These tests pin the two defences: the call refuses by default, and the restart path cannot even
// reach it.
const { suite, ok, eq, match, load } = require("./harness");
const fs = require("fs"), path = require("path");
const cdp = load("cdp.js");

// The refusal itself is asserted in cdp.test.js under a fake CDP server, where the module is under
// controlled conditions. An earlier draft asserted it here too and read ok:true — another suite had
// left cdp.closeWebview stubbed — so this file keeps only the check no stub can fake:
suite("window-close: the restart path cannot reach closeWebview at all", () => {
  // Source-level: extension.js must not import it. A path that cannot name the function cannot call
  // it, whatever a future edit does to the logic around it.
  const src = fs.readFileSync(path.join(__dirname, "..", "out", "extension.js"), "utf8");
  ok(!/closeWebview/.test(src), "out/extension.js references closeWebview — the window-killing path is reachable again");
});
