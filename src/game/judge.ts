import type { ChartNote } from './types';

export type Verdict = 'perfect' | 'good';

export interface WindowSpec {
  perfect: number;
  good: number;
}

export interface PressResult {
  kind: Verdict | 'stray';
  note?: ChartNote;
  delta?: number;
}

/**
 * Giudizio delle note. Ogni nota e' un singolo colpo (il fight originale non ha
 * accordi): conta il colpo piu' vicino dentro la finestra "good".
 */
export class Judge {
  readonly notes: readonly ChartNote[];
  /** 0 = in attesa, 1 = colpita, 2 = mancata. */
  readonly state: Int8Array;
  private next = 0;
  perfect = 0;
  good = 0;
  miss = 0;
  combo = 0;
  maxCombo = 0;
  onMiss: ((note: ChartNote, at: number) => void) | null = null;

  constructor(notes: readonly ChartNote[]) {
    this.notes = notes;
    this.state = new Int8Array(notes.length);
  }

  get finished(): boolean {
    return this.next >= this.notes.length;
  }

  get judged(): number {
    return this.perfect + this.good + this.miss;
  }

  reset(): void {
    this.state.fill(0);
    this.next = 0;
    this.perfect = 0;
    this.good = 0;
    this.miss = 0;
    this.combo = 0;
    this.maxCombo = 0;
  }

  /** Fa scadere le note non colpite oltre la finestra. */
  advance(chartTime: number, windows: WindowSpec): void {
    while (this.next < this.notes.length) {
      const note = this.notes[this.next]!;
      if (note.t + windows.good >= chartTime) break;
      this.state[this.next] = 2;
      this.miss += 1;
      this.combo = 0;
      this.next += 1;
      this.onMiss?.(note, chartTime);
    }
  }

  press(chartTime: number, windows: WindowSpec): PressResult {
    this.advance(chartTime, windows);

    let best = -1;
    let bestDelta = Number.POSITIVE_INFINITY;
    for (let i = this.next; i < this.notes.length; i += 1) {
      const note = this.notes[i]!;
      if (note.t - chartTime > windows.good) break;
      const delta = chartTime - note.t;
      if (Math.abs(delta) <= windows.good && Math.abs(delta) < Math.abs(bestDelta)) {
        best = i;
        bestDelta = delta;
      }
    }

    if (best < 0) return { kind: 'stray' };

    const note = this.notes[best]!;
    this.state[best] = 1;
    const kind: Verdict = Math.abs(bestDelta) <= windows.perfect ? 'perfect' : 'good';
    if (kind === 'perfect') this.perfect += 1;
    else this.good += 1;
    this.combo += 1;
    if (this.combo > this.maxCombo) this.maxCombo = this.combo;

    while (this.next < this.notes.length && this.state[this.next] !== 0) this.next += 1;
    return { kind, note, delta: bestDelta };
  }

  accuracy(): number {
    const total = this.judged;
    if (total === 0) return 100;
    return ((this.perfect + this.good * 0.65) / total) * 100;
  }
}
