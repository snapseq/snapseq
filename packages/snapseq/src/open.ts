import { spawn } from "node:child_process";

/** Show a directory in Finder, Explorer or the desktop's file manager; silent when there is none. */
export function openInFileManager(dir: string): void {
  const command =
    process.platform === "darwin" ? "open" : process.platform === "win32" ? "explorer" : "xdg-open";
  spawn(command, [dir], { detached: true, stdio: "ignore" })
    .on("error", () => {})
    .unref();
}
