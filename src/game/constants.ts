/** Tempo di volo dell'anello: il campanello segna la comparsa, il colpo arriva dopo. */
export const RING_FLIGHT_MS = 2000;

/** Silenzio/lead-in prima della prima nota nelle run complete. */
export const PREROLL_MS = 3500;

/**
 * Sync della registrazione ufficiale (video usgNkiExsCM): il chart e' agganciato
 * ai pallini del video di riferimento, allineati a questa registrazione.
 */
export const OFFICIAL_SYNC_MS = 24_728;
export const OFFICIAL_DURATION_S = 475.5;

/** Il volo dell'anello segue il tempo: la base e' espressa a 120 BPM. */
export const flightMsFor = (baseMs: number, bpm: number): number =>
  Math.max(600, Math.round((baseMs * 120) / Math.max(40, bpm)));
