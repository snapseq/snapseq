/**
 * A terminal row's label, the identity the screenshots folder uses: `nested/pricing / desktop`, then ` (uat)` when the
 * env is shown. The orchestration parent measures its parts with it, so the children's rows line up.
 */
export function rowLabel(sequence: string, device: string, env?: string): string {
  return `${sequence} / ${device}${env ? ` (${env})` : ""}`.normalize("NFC"); // macOS hands file names over decomposed
}
