import { spawn } from "node:child_process";
import { existsSync } from "node:fs";

/** Show a directory in Finder, Explorer or the desktop's file manager; silent when there is none. */
export function openInFileManager(dir: string): void {
  const command =
    process.platform === "darwin" ? "open" : process.platform === "win32" ? "explorer" : "xdg-open";
  spawn(command, [dir], { detached: true, stdio: "ignore" })
    .on("error", () => {})
    .unref();
}

/** Someone is watching: show them the run. Pipes and CI never get a window; SNAPSEQ_OPEN=0 (or false) keeps it closed. */
export function openRun(out: { isTTY?: boolean }, dir: string, open: (dir: string) => void = openInFileManager): void {
  if (out.isTTY && !process.env.CI && !/^(0|false)$/i.test(process.env.SNAPSEQ_OPEN ?? "") && existsSync(dir)) open(dir);
}
