import { spawn } from "node:child_process";

/** Over this the result document is not read: it carries paths, never bytes. */
const MAX_REPORT = 8 * 1024 * 1024;

export interface Closed {
  code: number | null;
  signal: NodeJS.Signals | null;
  /** The result reporter's document, when fd 3 reached its end within the size limit. */
  report?: string;
  /** Why there is no `report` although bytes arrived. */
  incomplete?: string;
}

export interface Child {
  kill(signal: NodeJS.Signals): void;
  /** Settles once the child exited and fd 3 closed. */
  closed: Promise<Closed>;
}

/** One `playwright test` on this terminal, fd 3 a pipe drained while it runs for the result reporter's document. */
export function spawnChild(argv: readonly string[], env: NodeJS.ProcessEnv): Child {
  const child = spawn(argv[0]!, argv.slice(1), { stdio: ["inherit", "inherit", "inherit", "pipe"], env });
  const pipe = child.stdio[3]!;
  const chunks: Buffer[] = [];
  let size = 0;
  let ended = false;
  pipe.on("data", (chunk: Buffer) => {
    size += chunk.length;
    if (size <= MAX_REPORT) chunks.push(chunk);
  });
  pipe.on("end", () => (ended = true));
  pipe.on("error", () => {});
  const closed = new Promise<Closed>((done) => {
    child.on("error", () => done({ code: null, signal: null }));
    child.on("close", (code, signal) => {
      if (size > MAX_REPORT) done({ code, signal, incomplete: "its report was over 8 MiB" });
      else if (!ended && size > 0) done({ code, signal, incomplete: "its report was cut off" });
      else done({ code, signal, ...(size > 0 ? { report: Buffer.concat(chunks).toString("utf8") } : {}) });
    });
  });
  return { kill: (signal) => void child.kill(signal), closed };
}
