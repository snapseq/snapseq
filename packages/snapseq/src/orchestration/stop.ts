import type { Child } from "./spawn.js";

// Playwright closes its browsers, runs teardown and reports on SIGINT; give it that long before insisting.
const INTERRUPT_WAIT = 10_000;
const TERMINATE_WAIT = 5_000;

/**
 * Stop a child the way Ctrl-C does, then insist: SIGINT, a bounded wait, SIGTERM, another, SIGKILL; resolves once
 * it closed. A SIGINT the terminal already sent it is harmless: Playwright ignores a second one within a second.
 */
export async function stopChild(child: Child): Promise<void> {
  const within = (ms: number): Promise<boolean> =>
    new Promise((done) => {
      const timer = setTimeout(() => done(false), ms);
      void child.closed.then(() => {
        clearTimeout(timer);
        done(true);
      });
    });
  child.kill("SIGINT");
  if (await within(INTERRUPT_WAIT)) return;
  child.kill("SIGTERM");
  if (await within(TERMINATE_WAIT)) return;
  child.kill("SIGKILL");
  await child.closed;
}

/** Ctrl-C and errors nothing caught go to these instead of Node's default exit; returns the undo. */
export function trap(onInterrupt: () => void, onError: (error: unknown) => void): () => void {
  const interrupt = (): void => onInterrupt();
  const error = (e: unknown): void => onError(e);
  process.on("SIGINT", interrupt);
  process.on("unhandledRejection", error);
  process.on("uncaughtException", error);
  return () => {
    process.off("SIGINT", interrupt);
    process.off("unhandledRejection", error);
    process.off("uncaughtException", error);
  };
}
