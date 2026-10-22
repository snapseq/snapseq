import { sequence } from "snapseq";

sequence(async ({ page, seq, env, device }) => {
  await page.goto(`/offer?env=${env}&device=${device}`);
  await seq.snap({ label: "Offer" });
  await seq.snap();
});
