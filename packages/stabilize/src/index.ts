import type { Route } from "@playwright/test";
import { addPersistentStyle, type Plugin } from "snapseq";

export interface StabilizeOptions {
  /** Freeze viewport-height units to px at the shot's viewport, so `snapPage` can grow the viewport without the layout following it. Default true. */
  viewportUnits?: boolean;
  /** No transitions; animations finished, or cancelled when they cannot finish, before each shot and after `snapPage` grows the viewport; SVG and video paused. Default true. */
  motion?: boolean;
  /** Emulate `prefers-reduced-motion: reduce` for the sequence. Default false: the page's own preference stays. */
  reducedMotion?: boolean;
  /** Move the pointer off the page before each shot, so what a click left under it is not drawn in `:hover`. `snap({ hover: "keep" })` skips it for one shot. Default true. */
  hover?: boolean;
  /** For a shot with `fullPage: true`: scroll from the top to the end first, so reveals on scroll and lazy loaders fire. Default false. */
  scroll?: boolean;
  /** A scroll event after `snapPage` grows the viewport and again once it is restored, so the page is back in its viewport state for what the sequence does next, for UI that follows scroll events only (a tray that hides once its inline counterpart is in view, a back-to-top button). Default true. */
  scrollEvent?: boolean;
  /** For `snapPage`: a `position: fixed` element keeps the top it had at the device viewport, instead of following its `bottom` inset to the end of the grown page (a promo drawer, a chat bubble, a cookie banner). Default true. */
  floating?: boolean;
}

declare module "snapseq" {
  interface SnapOptions {
    /** `"keep"`: leave the pointer where the sequence put it for this shot. Needs `@snapseq/stabilize` in `plugins`. */
    hover?: "keep";
  }
}

// snapseq's disableTransitions without its `animation: none`, which would hold a reveal at its base state (a bar
// chart at zero width): animations run, and stopMotion brings each to its end.
const NO_TRANSITIONS = `*, *::before, *::after { transition: none !important; }
*::details-content { transition: none !important; }
*::backdrop { transition: none !important; }
html { scroll-behavior: auto !important; }`;

// The functions below run in the page. Arrow functions only: a bundler wraps
// named inner functions in a helper the page does not have.

// Resolves once the DOM has been quiet for 200 ms, 2 s at most: what a script inserts after domcontentloaded
// (hydration), or what an observer reveals after a grow, has landed.
const quiet = () =>
  new Promise<void>((done) => {
    let timer = 0;
    const observer = new MutationObserver(() => {
      window.clearTimeout(timer);
      timer = window.setTimeout(end, 200);
    });
    const end = () => {
      observer.disconnect();
      window.clearTimeout(timer);
      window.clearTimeout(cap);
      done();
    };
    const cap = window.setTimeout(end, 2000);
    timer = window.setTimeout(end, 200);
    observer.observe(document, { childList: true, subtree: true, attributes: true, characterData: true });
  });

// The document from its top down to its end, one viewport at a time, a frame on each stop: what waits for
// the viewport (an IntersectionObserver reveal, a data-src loader) fires on the way. The end is read
// again on every stop, so growth that lands during the pass is followed, up to the caps. The position
// the page had comes back at the end.
const scrollPass = async () => {
  const root = document.scrollingElement ?? document.documentElement;
  const origin = window.scrollY;
  const height = window.innerHeight;
  const deadline = Date.now() + 5000;
  let steps = 0;
  let capped = false;
  const go = async (top: number) => {
    capped = steps >= 60 || Date.now() > deadline;
    if (capped) return false;
    window.scrollTo({ top, behavior: "instant" });
    await new Promise<void>((done) => requestAnimationFrame(() => done()));
    steps++;
    return true;
  };
  try {
    await go(0);
    while (window.scrollY + height < root.scrollHeight - 1) if (!(await go(window.scrollY + height))) break;
  } finally {
    window.scrollTo({ top: origin, behavior: "instant" });
  }
  return { steps, capped };
};

// What the browser sends when the document scrolls: a scroll event at the document, bubbling to the window.
const fireScroll = () => document.dispatchEvent(new Event("scroll", { bubbles: true }));

// Web Animations: a finite one is finished, an infinite one (or one that cannot
// finish) is cancelled. A finish handler can start another, so go round again.
const stopMotion = async () => {
  for (let round = 0; round < 5; round++) {
    for (const animation of document.getAnimations()) {
      try {
        if (Number.isFinite(animation.effect?.getComputedTiming().endTime) && animation.playbackRate !== 0) animation.finish();
        else animation.cancel();
      } catch {
        animation.cancel();
      }
    }
    await new Promise<void>((done) => requestAnimationFrame(() => done()));
    if (document.getAnimations().every((animation) => animation.playState === "finished")) break;
  }
  for (const svg of Array.from(document.querySelectorAll("svg"))) {
    if (!(svg instanceof SVGSVGElement)) continue; // an HTML element named svg has no animations to pause
    svg.pauseAnimations(); // where it is, like a video: a draw-in that finished stays drawn
  }
  for (const video of Array.from(document.querySelectorAll("video"))) video.pause();
};

// The links to fetch again, as hrefs without the fragment, which no request URL has: an unreadable,
// enabled, non-alternate stylesheet link not warned about yet. The links themselves wait in a property for swapLinks.
const findLinks = () => {
  const warned = (window as unknown as { __snapseqViewportUnits?: { warned: Set<string> } }).__snapseqViewportUnits?.warned;
  const links = Array.from(document.styleSheets).flatMap((sheet) => {
    const link = sheet.ownerNode;
    let readable = true;
    try {
      readable = !!sheet.cssRules;
    } catch {
      readable = false;
    }
    return !readable &&
      !sheet.disabled &&
      link instanceof HTMLLinkElement &&
      !link.disabled &&
      link.relList.contains("stylesheet") &&
      !link.relList.contains("alternate") &&
      !warned?.has(link.href)
      ? [link]
      : [];
  });
  (window as unknown as { __snapseqRefetch?: HTMLLinkElement[] }).__snapseqRefetch = links;
  return links.map((link) => link.href.replace(/#.*/, ""));
};

// Fetches each of those again as a CORS request, through a clone beside the original; the
// original goes once the clone loaded, and stays when it did not (a 500, a timeout).
// The plugin's route supplies the header the server did not.
const swapLinks = async () => {
  const host = window as unknown as { __snapseqRefetch?: HTMLLinkElement[] };
  const links = (host.__snapseqRefetch ?? []).filter((link) => link.isConnected); // the page may have removed one since findLinks
  delete host.__snapseqRefetch;
  const cap = new Promise<boolean>((done) => window.setTimeout(() => done(false), 5000));
  const swaps = links.map((link) => {
    const clone = link.cloneNode() as HTMLLinkElement;
    clone.crossOrigin = "anonymous";
    const loaded = new Promise<boolean>((done) => {
      clone.addEventListener("load", () => done(true), { once: true });
      clone.addEventListener("error", () => done(false), { once: true });
    });
    link.after(clone);
    return { link, clone, loaded };
  });
  const ok = await Promise.all(swaps.map((swap) => Promise.race([swap.loaded, cap])));
  swaps.forEach((swap, i) => (ok[i] ? swap.link : swap.clone).remove());
};

// Rewrites every viewport-height unit (vh, svh, lvh, dvh, vmin, vmax, vb and
// their variants) in the page's CSS to px, at the viewport as it is now. The
// page's own value is kept per declaration, so the next shot freezes it again at
// the viewport of that shot. Open shadow roots and adopted stylesheets are reached. Resolves to the hrefs unreadable now that may hold a viewport unit.
const freezeUnits = async () => {
  type Saved = { value: string; priority: string; frozen: string };
  type State = {
    originals: WeakMap<CSSStyleDeclaration, Map<string, Saved>>;
    bases: Record<string, number>;
    warned: Set<string>;
    unreadable: Set<string>;
    checked: Map<string, boolean>; // href: true keeps the note, false is harmless
    observer?: MutationObserver;
  };
  const host = window as unknown as { __snapseqViewportUnits?: State };
  const state = (host.__snapseqViewportUnits ??= { originals: new WeakMap(), bases: {}, warned: new Set(), unreadable: new Set(), checked: new Map<string, boolean>() });

  // Reported on every call, so every shot says it; `warned` is for findLinks, which tries a sheet once per document.
  const note = (href: string) => {
    state.warned.add(href);
    state.unreadable.add(href);
  };
  // A sheet from another origin has no readable rules unless it was fetched with CORS.
  const readable = (sheet: CSSStyleSheet) => {
    try {
      return !!sheet.cssRules;
    } catch {
      return false;
    }
  };

  // What the fetch again above could not make readable. The run below finds the imports again.
  state.unreadable.clear();
  for (const sheet of Array.from(document.styleSheets)) {
    if (sheet.href && !sheet.disabled && !readable(sheet)) note(sheet.href);
  }

  // What 100 of each unit is in px. Width-only units (vw, vi) are not frozen: the width never changes.
  // An element of its own name, reset by `all`: no rule of the page's can reach it.
  const probe = document.createElement("snapseq-probe");
  probe.style.cssText = "all:initial!important;display:block!important;position:fixed!important;visibility:hidden!important;width:0!important";
  document.documentElement.append(probe);
  state.bases = {};
  for (const prefix of ["", "s", "l", "d"]) {
    for (const axis of ["h", "min", "max", "b"]) {
      const unit = `${prefix}v${axis}`;
      probe.style.setProperty("height", `100${unit}`, "important");
      state.bases[unit] = parseFloat(getComputedStyle(probe).height); // not the bounding rect: a transform on an ancestor scales that
    }
  }
  probe.remove();
  state.observer?.takeRecords(); // the probe's own mutations; the run below covers everything present

  // Quoted strings and url(...) are left alone: split() keeps them at the odd indexes.
  const protectedText = /("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|url\([^)]*\))/i;
  const viewportUnit = /(?<![\w-])(-?\d*\.?\d+(?:e[+-]?\d+)?)(s|l|d)?v(h|min|max|b)\b/gi;
  const convert = (value: string) =>
    value
      .split(protectedText)
      .map((part, i) =>
        i % 2
          ? part
          : part.replace(viewportUnit, (match, n: string, prefix: string | undefined, axis: string) => {
              const base = state.bases[`${prefix ?? ""}v${axis}`.toLowerCase()];
              return base === undefined ? match : `${+((parseFloat(n) / 100) * base).toFixed(3)}px`;
            }),
      )
      .join("");

  const apply = (style: CSSStyleDeclaration) => {
    for (const name of Array.from(style)) {
      let value = style.getPropertyValue(name);
      let priority = style.getPropertyPriority(name);
      const prev = state.originals.get(style)?.get(name);
      // Still what this script set, value and priority: freeze the page's own value again, at the viewport of now.
      // Anything else is a value the page wrote since, and is its own original.
      if (prev && value === prev.frozen && priority === prev.priority) ({ value, priority } = prev);
      const next = convert(value);
      if (next === value) {
        state.originals.get(style)?.delete(name);
        continue;
      }
      style.setProperty(name, next, priority);
      if (!state.originals.has(style)) state.originals.set(style, new Map());
      state.originals.get(style)!.set(name, { value, priority, frozen: style.getPropertyValue(name) });
    }
  };
  // A rule with a style is a declaration block; one with rules (media, supports, layer,
  // container, scope, nesting) or an imported sheet holds more.
  const walk = (rules: CSSRuleList): void => {
    for (const rule of Array.from(rules)) {
      const r = rule as CSSRule & { style?: CSSStyleDeclaration; cssRules?: CSSRuleList; styleSheet?: CSSStyleSheet | null };
      if (r.style) apply(r.style);
      if (r.cssRules) walk(r.cssRules);
      if (r.styleSheet) {
        try {
          walk(r.styleSheet.cssRules);
        } catch {
          if (r.styleSheet.href) note(r.styleSheet.href); // a cross-origin import cannot be fetched again
        }
      }
    }
  };
  // What the observer below watches: anything that can carry CSS, in the document and in every open shadow root.
  const watch = { childList: true, subtree: true, attributes: true, attributeFilter: ["style"], characterData: true };
  // The document, then every open shadow root in it, nested ones included: its sheets, its adopted
  // sheets and the style attributes inside it. A sheet shared by several roots is walked once per run.
  // One pass over all elements per root. Closed roots are out of reach. A sheet link that has not loaded
  // yet runs this again when it does; a root found is watched.
  const run = () => {
    const seen = new Set<CSSStyleSheet>();
    const walkRoot = (root: Document | ShadowRoot) => {
      for (const sheet of [...Array.from(root.styleSheets), ...root.adoptedStyleSheets]) {
        if (seen.has(sheet)) continue;
        seen.add(sheet);
        try {
          walk(sheet.cssRules);
        } catch {
          // unreadable: noted above
        }
      }
      for (const el of Array.from(root.querySelectorAll<HTMLElement>("*"))) {
        if (el.hasAttribute("style") && el.style) apply(el.style);
        if (el instanceof HTMLLinkElement && !el.sheet && el.relList.contains("stylesheet")) el.addEventListener("load", run, { once: true });
        if (el.shadowRoot) {
          state.observer?.observe(el.shadowRoot, watch);
          walkRoot(el.shadowRoot);
        }
      }
    };
    walkRoot(document);
    state.observer?.takeRecords(); // the inline styles written above are ours, not the page's
  };

  // CSS that arrives later, such as a resize handler adding a widget while snapPage has
  // the viewport grown, is frozen at the bases saved above, not at the grown viewport.
  // A <style> or a <link> added, alone or inside an added subtree, the text of a <style> edited, or a node added
  // that carries a shadow root, walks everything again with run. A style attribute written, which a script that
  // animates does every frame, and a node added with style attributes but no sheet, only get apply on their own elements.
  if (!state.observer) {
    const css = "style, link[rel~=stylesheet]";
    state.observer = new MutationObserver((records) => {
      let dirty = false;
      const written = new Set<HTMLElement>();
      for (const record of records) {
        if (record.type === "attributes") {
          written.add(record.target as HTMLElement);
          continue;
        }
        const target = record.target instanceof Element ? record.target : record.target.parentElement;
        if (target?.matches("style")) dirty = true;
        for (const node of Array.from(record.addedNodes)) {
          if (!(node instanceof Element)) continue;
          if (node.matches(css) || node.querySelector(css) || node.shadowRoot) dirty = true;
          else for (const el of [node, ...Array.from(node.querySelectorAll("[style]"))]) written.add(el as HTMLElement);
        }
      }
      if (dirty) {
        run();
      } else {
        for (const el of written) if (el.style) apply(el.style);
        state.observer?.takeRecords(); // the inline styles written above are ours, not the page's
      }
    });
    state.observer.observe(document, watch);
  }
  run();

  // An unreadable sheet no refetch can open (a cross-origin @import loads without CORS) is fetched as text, once per
  // document, at most 10 per call, 512 K characters each and 3 s in all. Best effort: this anonymous fetch may not get
  // what the page applied. It is harmless (false) only for a text/css answer that, with comments and strings taken out,
  // has no viewport unit outside url(), no escape and no @import (whose sheet would stay unseen). Anything else, or
  // not checked yet (over the 10, or found while these were out), keeps the note.
  const deadline = AbortSignal.timeout(3000);
  const todo = Array.from(state.unreadable).filter((href) => !state.checked.has(href)).slice(0, 10);
  await Promise.all(
    todo.map(async (href) => {
      let harmless = false;
      try {
        const response = await fetch(href, { signal: deadline });
        if (response.ok && response.body && response.headers.get("content-type")?.toLowerCase().startsWith("text/css")) {
          const reader = response.body.getReader();
          const decoder = new TextDecoder();
          let text = "";
          for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) {
            text += decoder.decode(chunk.value, { stream: true });
            if (text.length > 512 * 1024) {
              await reader.cancel();
              throw new Error("too long");
            }
          }
          // An unquoted url() goes too, so a /* inside it is not taken for a comment; one with a backslash stays.
          const bare = (text + decoder.decode()).replace(/\/\*[\s\S]*?\*\/|"(?:[^"\\\n]|\\[\s\S])*"|'(?:[^'\\\n]|\\[\s\S])*'|url\(\s*[^\s"'()\\]*\s*\)/gi, " ");
          harmless = !bare.includes("\\") && !/@import/i.test(bare) && convert(bare) === bare;
        }
      } catch {
        // no answer in time, too long, refused by CORS or the page's CSP: unknown
      }
      state.checked.set(href, !harmless);
    }),
  );
  return { unreadable: Array.from(state.unreadable).filter((href) => state.checked.get(href) !== false) };
};

// Fixed elements keep the top they had at the device viewport. "discover" records them at the end of beforeSnap, "pin" sets an
// override on each at the end of afterGrow, "release" takes the page's inline values back and forgets them. The records live in
// the page, per document, never in the DOM. Elements never cross evaluate: each call finds the map itself.
const fixedElements = (mode: string) => {
  type Side = "top" | "bottom";
  type Entry = { top: number; width: number; height: number; sig: string; pin?: { was: Record<Side, [string, string]>; wrote: Record<Side, string> } };
  const host = window as unknown as Record<symbol, Map<HTMLElement, Entry> | undefined>;
  const records = (host[Symbol.for("snapseq.floating")] ??= new Map());
  const shows = (el: HTMLElement) => el.checkVisibility({ visibilityProperty: true, opacityProperty: true });
  const onScreen = (r: DOMRect) => r.width > 0 && r.height > 0 && r.bottom > 0 && r.top < window.innerHeight && r.right > 0 && r.left < window.innerWidth;
  // What the page sets on the element itself. Different at the grown viewport: the page placed it (a menu under its trigger,
  // a tray it moved by class), and the plugin leaves it where the page put it.
  const signature = (el: HTMLElement) => [el.style.cssText, getComputedStyle(el).transform, el.getAttribute("class")].join("\n");

  // Each side goes back only while it still holds what was written, value and priority: a page that wrote its own since keeps
  // it, and an element whose side the page took places itself: it is not pinned again.
  const restore = (el: HTMLElement, entry: Entry) => {
    for (const side of ["top", "bottom"] as const) {
      if (!entry.pin) continue;
      if (el.style.getPropertyValue(side) !== entry.pin.wrote[side] || el.style.getPropertyPriority(side) !== "important") {
        records.delete(el);
        continue;
      }
      const [value, priority] = entry.pin.was[side];
      if (value) el.style.setProperty(side, value, priority);
      else el.style.removeProperty(side);
    }
    delete entry.pin;
  };
  // The viewport-unit step watches style attributes for the page's writes; ours are not the page's, or it would forget the
  // vh value it keeps for an inline `bottom` and not freeze it again at the next viewport.
  const ours = () => (window as unknown as { __snapseqViewportUnits?: { observer?: MutationObserver } }).__snapseqViewportUnits?.observer?.takeRecords();

  // A shot that threw leaves a pin behind; the next discovery starts clean. Pinning again starts from the page's own layout.
  for (const [el, entry] of records) restore(el, entry);
  ours();
  if (mode !== "pin") records.clear();
  if (mode === "release") return;

  if (mode === "discover") {
    // Only fixed elements are measured. One parked off the screen (a hidden drawer) is not recorded: pinning it would pull it in.
    // One that is only partly on the screen (a bottom sheet peeking) stays as clipped as the device viewport clipped it.
    const walk = (root: Document | ShadowRoot) => {
      for (const el of Array.from(root.querySelectorAll<HTMLElement>("*"))) {
        if (el.shadowRoot) walk(el.shadowRoot);
        if (!el.style || getComputedStyle(el).position !== "fixed" || !shows(el)) continue;
        const r = el.getBoundingClientRect();
        if (onScreen(r) && r.bottom <= window.innerHeight + 1) records.set(el, { top: r.top, width: r.width, height: r.height, sig: signature(el) });
      }
    };
    walk(document);
    return;
  }

  // Not pinned: gone, no longer fixed, hidden, moved off the screen by the page (a tray slid or dropped out of view), placed by
  // the page itself, or resized by the grow (a `top: 10%; bottom: 0` panel stretched: it has its own layout, and clearing its
  // bottom would collapse it). Everything is read before anything is written.
  const todo: { el: HTMLElement; entry: Entry; top: number }[] = [];
  for (const [el, entry] of records) {
    if (!el.isConnected) continue;
    const style = getComputedStyle(el);
    if (style.position !== "fixed" || !shows(el)) continue;
    if (signature(el) !== entry.sig) {
      records.delete(el);
      continue;
    }
    const r = el.getBoundingClientRect();
    if (!onScreen(r) || Math.abs(r.width - entry.width) >= 1 || Math.abs(r.height - entry.height) >= 1) continue;
    const used = parseFloat(style.top);
    if (!Number.isFinite(used) || Math.abs(entry.top - r.top) < 1) continue;
    todo.push({ el, entry, top: +(used + entry.top - r.top).toFixed(3) });
  }
  for (const { el, entry, top } of todo) {
    const was = { top: [el.style.getPropertyValue("top"), el.style.getPropertyPriority("top")], bottom: [el.style.getPropertyValue("bottom"), el.style.getPropertyPriority("bottom")] } as Record<Side, [string, string]>;
    el.style.setProperty("top", `${top}px`, "important");
    el.style.setProperty("bottom", "auto", "important");
    entry.pin = { was, wrote: { top: el.style.getPropertyValue("top"), bottom: el.style.getPropertyValue("bottom") } };
  }
  // A containing block that is not the viewport (a transformed, filtered or contained ancestor) puts the override
  // elsewhere, and a fixed child of a pinned fixed ancestor would move twice: whatever did not land is put back.
  const misses = todo.filter(({ el, entry }) => {
    const r = el.getBoundingClientRect();
    return Math.abs(r.top - entry.top) >= 1 || Math.abs(r.width - entry.width) >= 1 || Math.abs(r.height - entry.height) >= 1;
  });
  for (const { el, entry } of misses) {
    restore(el, entry);
    records.delete(el);
  }
  ours();
};

// What goes into the manifest and the terminal: no credentials, query string or fragment (a signed CDN URL), at most 80 characters.
const shown = (href: string) => {
  try {
    const u = new URL(href);
    u.username = u.password = u.search = u.hash = "";
    return u.href.slice(0, 80);
  } catch {
    return href.slice(0, 80);
  }
};

/**
 * Makes `snapPage` work on pages with viewport-height units, and holds the page
 * still for each shot: pointer off the content, motion stopped. Each step has its own switch.
 */
export function stabilize({
  viewportUnits = true,
  motion = true,
  reducedMotion = false,
  hover = true,
  scroll = false,
  scrollEvent = true,
  floating = true,
}: StabilizeOptions = {}): Plugin {
  return {
    name: "stabilize",
    async begin({ page }) {
      if (reducedMotion) await page.emulateMedia({ reducedMotion: "reduce" });
      if (motion) await addPersistentStyle(page, NO_TRANSITIONS);
    },
    async beforeSnap(shot, { page }) {
      // A pin left behind goes first, before the freeze meets it: afterRestore takes it off, so this is for a restore that itself failed.
      if (floating) await page.evaluate(fixedElements, "release");
      // The pointer stays where the last click left it, and whatever moved under it (a card, a menu) is drawn in
      // :hover. Off the viewport nothing is hovered; the page's mouseleave handlers run. Out through the left
      // edge at mid-height, not the top: exit-intent scripts watch for a leave with clientY <= 0. (0, 0)
      // would leave the element in the corner hovered.
      if (hover && shot.options.hover !== "keep") {
        const v = page.viewportSize();
        await page.mouse.move(-1, v ? Math.round(v.height / 2) : 0);
      }
      // Native full page does not scroll, so what waits for the viewport never fires. snapPage and a plain snap show what they take.
      if (scroll && shot.options.fullPage) {
        await page.evaluate(quiet);
        const { steps, capped } = await page.evaluate(scrollPass);
        if (capped) shot.notes.push(`scroll pass stopped after ${steps} steps`);
      }
      if (motion) {
        await page.evaluate(stopMotion);
        // Playwright also finishes or cancels an animation that starts after this pass (a resize handler, a late
        // script) as it takes the screenshot. A sequence's own setting wins.
        shot.options.animations ??= "disabled";
      }
      if (viewportUnits) {
        // Script can read a cross-origin stylesheet's rules only if it was fetched with CORS: swapLinks does that.
        // While the route exists the HTTP cache is off and only the matching URLs are intercepted; outside that
        // window nothing is routed. Its handler adds the header the server did not, to one text/css response per URL
        // and nothing else (the hrefs come from the page, which may lie about them); anything else, and a fetch error,
        // falls back to the routes registered before it, or to the browser.
        const hrefs = new Set(await page.evaluate(findLinks));
        if (hrefs.size > 0) {
          // A RegExp, not a function: Playwright cannot tell a function's URLs in advance, and would intercept every request.
          const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
          const match = new RegExp("^(?:" + Array.from(hrefs).map(escape).join("|") + ")$");
          const served = new Set<string>();
          const serve = async (route: Route) => {
            const request = route.request();
            // The clone is anonymous, so the browser sends it no cookie: a request that has one is not the clone's.
            if (served.has(request.url()) || request.headers().cookie) return route.fallback();
            // An empty cookie header, which Playwright takes as set: it does not add the context's cookies to this fetch.
            // A redirect is not followed (the body would be served at the old URL, where a relative url() in it
            // resolves wrongly, and the fetch would leave the URL that was routed); it is no 2xx, so it falls back.
            const response = await route.fetch({ maxRedirects: 0, headers: { ...request.headers(), cookie: "" } }).catch(() => undefined);
            // Not a stylesheet, or no answer: the browser makes its own CORS request, which fails without the header
            // and leaves the original sheet in place; freezeUnits notes it.
            if (!response?.ok() || !response.headers()["content-type"]?.toLowerCase().startsWith("text/css")) return route.fallback();
            served.add(request.url());
            return route.fulfill({ response, headers: { ...response.headers(), "access-control-allow-origin": "*" } }).catch(() => {});
          };
          await page.route(match, serve);
          let timer: ReturnType<typeof setTimeout> | undefined;
          try {
            // The page ends the swap itself after 5 s; this bounds the route from here, too.
            await Promise.race([page.evaluate(swapLinks), new Promise<void>((done) => (timer = setTimeout(done, 6000)))]);
          } finally {
            clearTimeout(timer);
            await page.unroute(match, serve);
          }
        }
        const { unreadable } = await page.evaluate(freezeUnits);
        for (const href of unreadable) shot.notes.push(`cannot read ${shown(href)}: its viewport units stay live`);
      }
      // Last, so the page is in the state it wants at this viewport and the vh insets are frozen.
      if (floating) await page.evaluate(fixedElements, "discover");
    },
    // Grown from the top, nothing scrolls, so no scroll event fires. What the grow brought into view (an observer adding
    // .inView) may start an animation, which grows the page while it runs: once the DOM is quiet it is finished, so
    // snapPage measures the page at its end state. freezeUnits does not run again: it would freeze at the grown viewport.
    // The fixed elements go back to their top last, once the page has settled, from the baseline beforeSnap took.
    async afterGrow(_shot, { page }) {
      if (scrollEvent) await page.evaluate(fireScroll);
      if (floating || motion) await page.evaluate(quiet);
      if (motion) await page.evaluate(stopMotion);
      if (floating) await page.evaluate(fixedElements, "pin");
    },
    // The viewport and the scroll position are back, the shot taken or failed: the page's own insets come back, then the page
    // hears the scroll event for its own viewport, so what the sequence does next finds it as it was (a tray the grow hid shows
    // again). If the restore itself failed this does not run, and the next shot's beforeSnap releases the pin.
    async afterRestore(_shot, { page }) {
      // The page may have navigated by now (a timer): that is not the shot's failure.
      if (floating) await page.evaluate(fixedElements, "release").catch(() => undefined);
      if (scrollEvent) await page.evaluate(fireScroll).catch(() => undefined);
    },
  };
}
