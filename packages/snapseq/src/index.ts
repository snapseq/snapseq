export { defineConfig } from "./define.js";
export type { DeviceConfig, EnvConfig, SnapseqConfig } from "./define.js";

export { capture, skipIf } from "./fixtures.js";
export type { CaptureArgs, CaptureContext, CaptureFn } from "./fixtures.js";

export type { Sequence, ShotFormat, SnapOptions } from "./sequence.js";

export type { Plugin, Shot } from "./plugin.js";

export { addPersistentStyle, disableTransitions } from "./dom.js";
