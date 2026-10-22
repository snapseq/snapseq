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

const SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"] as const;

/** Ctrl-C, a kill or a closed terminal, and errors nothing caught go to these instead of Node's default exit; returns the undo. */
export function trap(onInterrupt: () => void, onError: (error: unknown) => void): () => void {
  for (const signal of SIGNALS) process.on(signal, onInterrupt);
  process.on("unhandledRejection", onError);
  process.on("uncaughtException", onError);
  return () => {
    for (const signal of SIGNALS) process.off(signal, onInterrupt);
    process.off("unhandledRejection", onError);
    process.off("uncaughtException", onError);
  };
}
