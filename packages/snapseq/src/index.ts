export { defineConfig } from "./define.js";
export type { DeviceConfig, EnvConfig, SnapseqConfig } from "./define.js";

export { sequence, skipIf } from "./fixtures.js";
export type { SequenceArgs, SequenceContext, SequenceFn } from "./fixtures.js";

export type { Sequence, ShotFormat, SnapOptions } from "./sequence.js";

export type { Plugin, Shot } from "./plugin.js";

export { addPersistentStyle, disableTransitions } from "./dom.js";
