import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defineConfig } from "../define.js";

const envs = {
  dev: { host: "http://localhost:3000" },
  staging: {
    host: "https://staging.example.com:8443/app",
    httpCredentials: { username: "u", password: "p" },
  },
};
const use = (config: ReturnType<typeof defineConfig>) =>
  config.use as {
    baseURL?: string;
    httpCredentials?: { origin?: string };
    navigationTimeout?: number;
    actionTimeout?: number;
    extraHTTPHeaders?: Record<string, string>;
    storageState?: string;
  };

beforeEach(() => {
  vi.stubEnv("SNAPSEQ_RUN", "run1");
  vi.stubEnv("SNAPSEQ_ENV", "");
  vi.stubEnv("SNAPSEQ_HOST", "");
  vi.stubEnv("SNAPSEQ_RECORD", "");
});
afterEach(() => vi.unstubAllEnvs());

describe("defineConfig", () => {
  it("bounds navigation on its own, apart from actions and the capture timeout", () => {
    const u = use(defineConfig({ envs }));
    expect(u.navigationTimeout).toBe(120_000);
    expect(u.actionTimeout).toBe(30_000);
  });

  it("offers env credentials to the resolved host's origin only, unless an origin is given", () => {
    vi.stubEnv("SNAPSEQ_ENV", "staging");
    expect(use(defineConfig({ envs })).httpCredentials).toEqual({
      origin: "https://staging.example.com:8443",
      username: "u",
      password: "p",
    });
    vi.stubEnv("SNAPSEQ_HOST", "http://127.0.0.1:4000/");
    expect(use(defineConfig({ envs })).httpCredentials?.origin).toBe("http://127.0.0.1:4000");
    const pinned = { ...envs, staging: { ...envs.staging, httpCredentials: { ...envs.staging.httpCredentials, origin: "https://sso.example.com" } } };
    expect(use(defineConfig({ envs: pinned })).httpCredentials?.origin).toBe("https://sso.example.com");
    vi.stubEnv("SNAPSEQ_ENV", "dev");
    expect(use(defineConfig({ envs })).httpCredentials).toBeUndefined();
  });

  it("merges an env's own Playwright use options over the defaults", () => {
    const u = use(
      defineConfig({
        envs: {
          dev: { host: "http://localhost:3000" },
          staging: {
            host: "https://staging.example.com",
            use: { extraHTTPHeaders: { authorization: "Bearer t" }, storageState: "s.json", actionTimeout: 5_000 },
          },
        },
      }),
    );
    expect(u.extraHTTPHeaders).toBeUndefined();
    vi.stubEnv("SNAPSEQ_ENV", "staging");
    const s = use(
      defineConfig({
        envs: {
          dev: { host: "http://localhost:3000" },
          staging: {
            host: "https://staging.example.com",
            use: { extraHTTPHeaders: { authorization: "Bearer t" }, storageState: "s.json", actionTimeout: 5_000 },
          },
        },
      }),
    );
    expect(s.extraHTTPHeaders).toEqual({ authorization: "Bearer t" });
    expect(s.storageState).toBe("s.json");
    expect(s.actionTimeout).toBe(5_000); // an env's own value wins over the default
    expect(s.baseURL).toBe("https://staging.example.com"); // the rest stays
    expect(s.navigationTimeout).toBe(120_000);
  });

  it("takes a run or device name, never a path: the directory it names is wiped", () => {
    for (const run of ["../outside", "a/b", "..", ".", "c\\d"]) {
      vi.stubEnv("SNAPSEQ_RUN", run);
      expect(() => defineConfig({ envs })).toThrow(`SNAPSEQ_RUN must be a directory name, not a path: "${run}"`);
    }
    vi.stubEnv("SNAPSEQ_RUN", "review 1");
    expect(() => defineConfig({ envs })).not.toThrow();
    expect(() => defineConfig({ envs, devices: { "../d": {} } })).toThrow("a device name must be a directory name");
    expect(() => defineConfig({ envs, devices: { "300x250": { viewport: { width: 300, height: 250 } } } })).not.toThrow();
  });

  it("carries the env's replay map and the record flag to the fixtures", () => {
    const meta = (c: ReturnType<typeof defineConfig>) =>
      (c.metadata as { snapseq: { replay?: unknown; record: boolean } }).snapseq;
    const replay = { "**/api": "captures/replay/api.json" };
    expect(meta(defineConfig({ envs: { ...envs, dev: { ...envs.dev, replay } } }))).toMatchObject({ replay, record: false });
    expect(meta(defineConfig({ envs }))).not.toHaveProperty("replay");
    vi.stubEnv("SNAPSEQ_RECORD", "1");
    expect(meta(defineConfig({ envs })).record).toBe(true);
  });

  it("takes a numbering of zeros, 00 by default, and carries it in the metadata", () => {
    const numbering = (c: ReturnType<typeof defineConfig>) =>
      (c.metadata as { snapseq: { numbering: string } }).snapseq.numbering;
    expect(numbering(defineConfig({ envs }))).toBe("00");
    expect(numbering(defineConfig({ envs, numbering: "0000" }))).toBe("0000");
    for (const bad of ["", "00x", "1", "0 0"]) {
      expect(() => defineConfig({ envs, numbering: bad })).toThrow(`numbering must be zeros, like "00", not "${bad}"`);
    }
  });

  it("carries the format, Playwright's type and quality, to the fixtures; {} by default", () => {
    const format = (c: ReturnType<typeof defineConfig>) =>
      (c.metadata as { snapseq: { format: unknown } }).snapseq.format;
    expect(format(defineConfig({ envs }))).toEqual({});
    expect(format(defineConfig({ envs, format: { type: "jpeg", quality: 60 } }))).toEqual({ type: "jpeg", quality: 60 });
  });
});
