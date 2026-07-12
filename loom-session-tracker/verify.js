const { Tracker } = require("./out/tracker");
(async () => {
  for (const repo of ["funisland", "shwab_docker", null]) {
    const t = new Tracker(repo);
    const r = await t.tick();
    const roles = t.view().map(a => `${a.repo}/${a.role}`).sort();
    console.log(`\n=== filter=${repo || "ALL"} ===  ok=${r.ok}`);
    console.log("  agents:", roles.join(", ") || "(none)");
  }
  process.exit(0);
})().catch(e => { console.error("THREW:", e); process.exit(1); });
