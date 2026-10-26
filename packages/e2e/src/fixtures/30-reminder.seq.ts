import { sequence } from "snapseq";

// The page records what the sequence saw of the stabilize setting in its URL, for the server's log.
sequence(async ({ page, seq, device }) => {
  await page.goto("/reminder");
  const reduced = await page.evaluate(() => matchMedia("(prefers-reduced-motion: reduce)").matches);
  await page.goto(`/reminder?device=${device}&reduced=${reduced}`);
  await seq.snap({ label: "Reminder" });
  await seq.snap();
});
