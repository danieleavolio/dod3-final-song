import type { ChartNote } from './types';

export interface SectionAlignment {
  id: string;
  delta: number;
  count: number;
}

export interface AlignmentReport {
  /** Scarto mediano tra il colpo atteso e l'attacco piu' forte vicino. */
  globalDelta: number;
  used: number;
  sections: SectionAlignment[];
}

const median = (values: number[]): number => {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)]!;
};

/**
 * Misura dove cadono davvero gli attacchi rispetto ai colpi del chart.
 *
 * Usa l'energia della derivata prima (attacchi, non armonia) su un inviluppo
 * a 5 ms, cerca il picco piu' "sporgente" entro ±180 ms da ogni nota e prende
 * la mediana degli scarti. Non si appoggia ai suoni di gioco ne' al sync
 * dichiarato: serve a capire se il sync e' sbagliato o se il chart e' fuori.
 */
export function measureAlignment(
  buffer: AudioBuffer,
  syncMs: number,
  notes: readonly ChartNote[],
): AlignmentReport {
  const sr = buffer.sampleRate;
  const channels = buffer.numberOfChannels;
  const length = buffer.length;
  const mono = new Float32Array(length);
  for (let c = 0; c < channels; c += 1) {
    const data = buffer.getChannelData(c);
    for (let i = 0; i < length; i += 1) mono[i] += data[i]! / channels;
  }

  const hop = Math.max(1, Math.round(sr * 0.005));
  const frames = Math.floor(length / hop);
  const env = new Float32Array(frames);
  let prev = 0;
  for (let f = 0; f < frames; f += 1) {
    let energy = 0;
    const start = f * hop;
    for (let i = 0; i < hop; i += 1) {
      const sample = mono[start + i]!;
      const diff = sample - prev;
      prev = sample;
      energy += diff * diff;
    }
    env[f] = Math.sqrt(energy / hop);
  }

  const frameMs = (hop / sr) * 1000;
  const half = 180;
  const bySection = new Map<string, number[]>();
  const all: number[] = [];

  for (const note of notes) {
    if (note.finale) continue;
    const expected = syncMs + note.t;
    const f0 = Math.max(2, Math.floor((expected - half) / frameMs));
    const f1 = Math.min(frames - 3, Math.ceil((expected + half) / frameMs));
    if (f1 <= f0) continue;

    let mean = 0;
    for (let f = f0; f <= f1; f += 1) mean += env[f]!;
    mean = Math.max(1e-9, mean / (f1 - f0 + 1));

    let bestScore = 0;
    let bestFrame = -1;
    for (let f = f0; f <= f1; f += 1) {
      // Picco che sporge dalla media locale: premia l'attacco, non il volume.
      const score = env[f]! / mean;
      if (score > bestScore) {
        bestScore = score;
        bestFrame = f;
      }
    }
    if (bestFrame < 0) continue;

    const delta = bestFrame * frameMs - expected;
    all.push(delta);
    if (!bySection.has(note.section)) bySection.set(note.section, []);
    bySection.get(note.section)!.push(delta);
  }

  return {
    globalDelta: Math.round(median(all)),
    used: all.length,
    sections: [...bySection.entries()].map(([id, values]) => ({
      id,
      delta: Math.round(median(values)),
      count: values.length,
    })),
  };
}
