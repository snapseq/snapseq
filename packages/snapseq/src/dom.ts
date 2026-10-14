import type { Page } from "@playwright/test";

/**
 * Inject CSS into the current document and into every document this page
 * navigates to afterwards. `addStyleTag` styles the page now (and throws if a
 * CSP rejects it); the init script re-adds the rules to each new document
 * before its own scripts run. Call once per capture.
 */
export async function addPersistentStyle(page: Page, css: string): Promise<void> {
  await page.addInitScript((css) => {
    // Runs before <head> exists. No named inner functions here: bundlers that
    // keep names wrap them in a helper the page does not have.
    const style = document.createElement("style");
    style.textContent = css;
    if (document.head) document.head.appendChild(style);
    else {
      document.addEventListener("DOMContentLoaded", () => document.head.appendChild(style), {
        once: true,
      });
    }
  }, css);
  await page.addStyleTag({ content: css });
}

// Pseudo-elements that can carry a transition of their own: a <details> fold
// (::details-content, Chromium 131+) and a <dialog> backdrop. Each in its own
// rule: one unsupported pseudo-element would drop a shared selector list whole.
const NO_MOTION_CSS = `*, *::before, *::after { transition: none !important; animation: none !important; }
*::details-content { transition: none !important; animation: none !important; }
*::backdrop { transition: none !important; animation: none !important; }
html { scroll-behavior: auto !important; }`;

/**
 * Freeze motion so screenshots are deterministic: no transitions, animations or
 * smooth scrolling, on this document and every later one. `animation: none`
 * (rather than a paused play-state) resets each element to its un-animated base
 * state instead of freezing it at an arbitrary keyframe.
 */
export function disableTransitions(page: Page): Promise<void> {
  return addPersistentStyle(page, NO_MOTION_CSS);
}
