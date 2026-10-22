import { join } from "node:path";
import { defineOrchestration } from "snapseq";
import { label } from "@snapseq/label";
import { pdf } from "@snapseq/pdf";

// Three parts: one on a single device, one on another env, one with a device of its own and stabilize tuned.
export default defineOrchestration(async ({ run, config, dir }) => {
  const raw = [
    ...(await run("10-launch", { devices: ["desktop"] })),
    ...(await run("20-offer", { env: "uat" })),
    ...(await run("30-reminder", {
      devices: { ...config.devices, tablet: { viewport: { width: 500, height: 300 } } },
      stabilize: { reducedMotion: true },
    })),
  ];
  for (const c of raw) console.log(`part ${c.sequence}/${c.device} ${c.reused ? "reused" : "fresh"} env=${c.env}`);

  const labelled = await label(raw, { theme: "dark" });
  for (const device of new Set(labelled.map((c) => c.device))) {
    await pdf(labelled.filter((c) => c.device === device), join(dir, `${device}.pdf`));
  }
  console.log("steps done");
});
