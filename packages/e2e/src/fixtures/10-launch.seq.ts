import { sequence } from "snapseq";

sequence(async ({ page, seq, env, device }) => {
  await page.goto(`/launch?env=${env}&device=${device}`);
  await seq.snap({ label: "Launch, top" });
  await seq.snapPage();
});
