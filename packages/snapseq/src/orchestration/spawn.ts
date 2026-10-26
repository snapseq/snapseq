import { spawn } from "node:child_process";

/** Past this the result document is not read: it carries paths, never bytes. run.ts names it in its message. */
const MAX_REPORT = 8 * 1024 * 1024;

// Playwright closes its browsers, runs teardown and reports on SIGINT; give it that long before insisting.
const INTERRUPT_WAIT = 10_000;
const TERMINATE_WAIT = 5_000;

export interface Closed {
  code: number | null;
  signal: NodeJS.Signals | null;
  /** What arrived on fd 3 for the result reporter's document; none when it went over the size limit. */
  report?: string;
  /** More than the size limit arrived: not read, even if what came first parses. */
  oversize?: true;
  /** Why the child could not be started. */
  error?: string;
}

export interface Child {
  /**
   * Stop it the way Ctrl-C does, then insist: SIGINT, a bounded wait, SIGTERM, another, SIGKILL; resolves once it
   * closed. A SIGINT the terminal already sent it is harmless: Playwright ignores a second one within a second.
   */
  stop(): Promise<void>;
  /** Settles once the child exited and fd 3 closed. */
  closed: Promise<Closed>;
}

/** One `playwright test` on this terminal, fd 3 a pipe drained while it runs for the result reporter's document. */
export function spawnChild(argv: readonly string[], env: NodeJS.ProcessEnv): Child {
  const child = spawn(argv[0]!, argv.slice(1), { stdio: ["inherit", "inherit", "inherit", "pipe"], env });
  const pipe = child.stdio[3]!;
  const chunks: Buffer[] = [];
  let size = 0;
  pipe.on("data", (chunk: Buffer) => {
    size += chunk.length;
    if (size <= MAX_REPORT) chunks.push(chunk);
  });
  pipe.on("error", () => {});
  let spawned = false;
  child.on("spawn", () => (spawned = true));
  const closed = new Promise<Closed>((done) => {
    // Only a failed start settles it here; a later error (a kill that fails) leaves it to the close.
    child.on("error", (err) => spawned || done({ code: null, signal: null, error: err.message }));
    child.on("close", (code, signal) =>
      done({ code, signal, ...(size > MAX_REPORT ? { oversize: true } : size > 0 ? { report: Buffer.concat(chunks).toString("utf8") } : {}) }),
    );
  });
  const within = (ms: number): Promise<boolean> =>
    new Promise((done) => {
      const timer = setTimeout(() => done(false), ms);
      void closed.then(() => {
        clearTimeout(timer);
        done(true);
      });
    });
  const stop = async (): Promise<void> => {
    child.kill("SIGINT");
    if (await within(INTERRUPT_WAIT)) return;
    child.kill("SIGTERM");
    if (await within(TERMINATE_WAIT)) return;
    child.kill("SIGKILL");
    await closed;
  };
  return { stop, closed };
}
