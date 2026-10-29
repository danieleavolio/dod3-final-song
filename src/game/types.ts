export type Mode = 'authentic' | 'practice';

export interface ChartSection {
  id: string;
  name: string;
  bpm: number;
  start: number;
  end: number;
  count: number;
}

export interface ChartNote {
  t: number;
  section: string;
  index: number;
  finale: boolean;
}

export interface TempoSegment {
  start: number;
  end: number;
  bpm: number;
  bpmTo?: number;
}

export interface Chart {
  duration: number;
  finaleT: number;
  circleT: number;
  sections: ChartSection[];
  tempo: TempoSegment[];
  notes: ChartNote[];
}

export interface Settings {
  audioSyncMs: number;
  outputDelayMs: number;
  reduceMotion: boolean;
  practiceSpeed: number;
  practiceSection: string;
  sfxEnabled: boolean;
  ringFlightMs: number;
  skipIntro: boolean;
  sectionOffsets: Record<string, number>;
  /** Spostamenti delle singole note, per indice globale del chart. */
  noteOffsets: Record<string, number>;
}

export interface BestRun {
  accuracy: number;
  maxCombo: number;
  miss: number;
  when: number;
}

export type FinaleOutcome = 'hit' | 'miss' | null;

export interface RunResult {
  mode: Mode;
  cleared: boolean;
  accuracy: number;
  perfect: number;
  good: number;
  miss: number;
  maxCombo: number;
  total: number;
  section: string | null;
  finale: FinaleOutcome;
  newBest: boolean;
  best: BestRun | null;
}
