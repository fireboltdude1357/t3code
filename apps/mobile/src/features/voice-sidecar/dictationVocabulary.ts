import type { LunaDictionaryEntry } from "./lunaHostApi";

/**
 * Turns the Luna dictionary into inputs for on-device dictation. Both helpers
 * mirror the host's behavior for the cloud path (keywords() and
 * applyCorrections() in luna-host) so the two transcription routes agree.
 */

/** Apple documents this ceiling for contextual strings. */
const MAX_CONTEXTUAL_STRINGS = 100;

/**
 * Picks the recognition-bias terms: canonical spellings, deduplicated,
 * host-ranked order preserved (learned first, then Wispr by usage), capped at
 * Apple's limit.
 */
export function selectDictationTerms(entries: ReadonlyArray<LunaDictionaryEntry>): string[] {
  const seen = new Set<string>();
  const terms: string[] = [];
  for (const entry of entries) {
    const preferred = (
      entry.kind === "correction" ? (entry.replacement ?? entry.phrase) : entry.phrase
    ).trim();
    if (preferred.length === 0) continue;
    const key = preferred.normalize("NFKC").toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    terms.push(preferred);
    if (terms.length >= MAX_CONTEXTUAL_STRINGS) break;
  }
  return terms;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Applies stored corrections to a transcript, longest phrase first, matching
 * whole words case-insensitively. Written without lookbehind for Hermes.
 */
export function applyDictionaryCorrections(
  text: string,
  entries: ReadonlyArray<LunaDictionaryEntry>,
): string {
  const corrections = entries
    .filter((entry) => entry.kind === "correction" && (entry.replacement ?? "").trim().length > 0)
    .toSorted((a, b) => b.phrase.length - a.phrase.length);
  let result = text;
  for (const entry of corrections) {
    const escaped = escapeRegExp(entry.phrase.trim());
    if (escaped.length === 0) continue;
    const pattern = new RegExp(`(^|[^\\p{L}\\p{N}])(${escaped})(?=$|[^\\p{L}\\p{N}])`, "giu");
    result = result.replace(pattern, (_match, prefix: string) => prefix + entry.replacement);
  }
  return result;
}
