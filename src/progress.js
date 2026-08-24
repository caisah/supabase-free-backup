/**
 * Small shared helpers for the backup progress transcript (`starting …` /
 * `completed …` pairs emitted through the injectable `onProgress` seam).
 */

/**
 * Emit an optional progress message without letting an observer failure abort
 * the caller. Used at mandatory cleanup boundaries: observability must never
 * skip confidentiality cleanup, and a reporting failure must never replace
 * the primary operational error.
 */
export function reportProgressSafely(onProgress, message) {
  try {
    onProgress?.(message);
  } catch {
    // Reporting is best-effort; the caller's cleanup continues regardless.
  }
}

/** `1-based/total` ordinal for a zero-based index (display only). */
export function ordinal(index, total) {
  return `${index + 1}/${total}`;
}
