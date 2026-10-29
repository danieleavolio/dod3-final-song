import raw from '../data/chart.json';
import type { Chart, ChartNote, ChartSection } from './types';

export const chart = raw as unknown as Chart;
export const allNotes: readonly ChartNote[] = chart.notes;

const byId = new Map<string, ChartSection>(chart.sections.map((s) => [s.id, s]));

export function sectionById(id: string): ChartSection | undefined {
  return byId.get(id);
}

/** Sezione corrente secondo i tempi delle note (le sezioni sono ordinate). */
export function sectionAt(t: number): ChartSection {
  let current = chart.sections[0]!;
  for (const section of chart.sections) {
    if (section.start <= t) current = section;
    else break;
  }
  return current;
}

export function sectionLabel(t: number): string {
  return sectionAt(t).name;
}

export const lastAllEnd = sectionById('all')?.end ?? chart.finaleT;
