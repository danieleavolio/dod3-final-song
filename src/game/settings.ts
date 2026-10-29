import type { BestRun, Mode, Settings } from './types';

const SETTINGS_KEY = 'dod3fs.settings.v1';
const OFFSETS_RESET_KEY = 'dod3fs.offsetsReset.v1';
const bestKey = (mode: Mode, section: string | null): string => `dod3fs.best.${mode}.${section ?? 'full'}.v1`;

export const DEFAULT_SETTINGS: Settings = {
  audioSyncMs: 0,
  outputDelayMs: 0,
  reduceMotion: false,
  practiceSpeed: 0.85,
  practiceSection: 'zero',
  sfxEnabled: true,
  ringFlightMs: 2000,
  skipIntro: false,
  sectionOffsets: {},
  noteOffsets: {},
};

/**
 * Gli offset per sezione che il gioco usava prima erano un errore: il chart
 * era gia' allineato alla registrazione. Se ne troviamo ancora uno dei valori
 * grandi salvati, azzeriamo tutto il blocco (sync e volo restano).
 */
const isLegacyOffsets = (offsets: Record<string, number> | undefined): boolean =>
  !!offsets && ((offsets.five ?? 0) >= 200 || (offsets.four ?? 0) >= 150 || (offsets.three ?? 0) >= 200);

export function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return { ...DEFAULT_SETTINGS };
    const parsed = JSON.parse(raw) as Partial<Settings>;
    // Pulizia una tantum: gli offset sbagliati salvati dalle versioni
    // precedenti vengono azzerati al primo avvio, poi non si tocca piu' nulla.
    if (!localStorage.getItem(OFFSETS_RESET_KEY)) {
      if (isLegacyOffsets(parsed.sectionOffsets)) parsed.sectionOffsets = {};
      localStorage.setItem(OFFSETS_RESET_KEY, '1');
    }
    return { ...DEFAULT_SETTINGS, ...parsed };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function saveSettings(settings: Settings): void {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch {
    // storage non disponibile: la scelta vale per la sessione corrente
  }
}

export function loadBest(mode: Mode, section: string | null = null): BestRun | null {
  try {
    const raw = localStorage.getItem(bestKey(mode, section));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as BestRun;
    return typeof parsed.accuracy === 'number' ? parsed : null;
  } catch {
    return null;
  }
}

export function saveBest(mode: Mode, section: string | null, run: BestRun): void {
  try {
    localStorage.setItem(bestKey(mode, section), JSON.stringify(run));
  } catch {
    // storage non disponibile
  }
}

export function isBetter(previous: BestRun | null, next: BestRun): boolean {
  if (!previous) return true;
  if (next.accuracy > previous.accuracy + 0.0001) return true;
  if (Math.abs(next.accuracy - previous.accuracy) <= 0.0001 && next.maxCombo > previous.maxCombo) return true;
  return false;
}
