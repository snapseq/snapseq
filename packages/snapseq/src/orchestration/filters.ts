/** What the command line asked to reshoot: substrings of sequence ids and exact device names. */
export interface Filters {
  readonly sequences: readonly string[];
  readonly devices: readonly string[];
}

export const filtering = (f: Filters): boolean => f.sequences.length > 0 || f.devices.length > 0;

/** A part matches when its sequence contains one of the substrings and its device is one of the names; an empty list matches all. */
export const matches = (f: Filters, sequence: string, device: string): boolean =>
  (f.sequences.length === 0 || f.sequences.some((s) => sequence.includes(s))) &&
  (f.devices.length === 0 || f.devices.includes(device));

/** `"12346" --device mobile`, as typed, for `no part matched …`. */
export const describeFilters = (f: Filters): string =>
  [...f.sequences.map((s) => JSON.stringify(s)), ...f.devices.map((d) => `--device ${d}`)].join(" ");
