// model-busy.test.js — a command is only typed into an IDLE composer.
const { suite, ok, eq, load, makeRepo } = require("./harness");
const { Tracker } = load("tracker.js"); const cdp = load("cdp.js"); const { isBusy } = load("sessions.js");
suite("tracker: a mid-turn worker is reported busy, an idle one is not", async () => {
  const repo = makeRepo({ developer: {}, designer: {} }, "busy");
  const busyTail = "Bash Summarize the failing tests\nIN\n...\nClaude is working\nRemote Control\nFable 5.1\nMedium\nBypass permissions";
  ok(isBusy(busyTail), "fixture must read as busy under sessions.isBusy");
  const frames = [
    { webviewId: "w-b", type: "iframe", targetUrl: "u", text: "x\nLOOMROLE=developer\n" + busyTail },
    { webviewId: "w-i", type: "iframe", targetUrl: "u", text: "done\nLOOMROLE=designer\nReady for your input.\nFable 5.1\nMedium\nBypass permissions" },
  ];
  const t = new Tracker(repo); const real = cdp.readFrames; cdp.readFrames = async () => frames;
  try { await t.tick(); } finally { cdp.readFrames = real; }
  eq([...t.busyRoles], ["developer"], "only the mid-turn role is busy");
  eq(t.modelState().get("developer").model, "Fable 5.1", "its footer is still read");
});
