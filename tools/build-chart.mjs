/**
 * Costruisce src/data/chart.json dai dati grezzi in data/raw/.
 *
 * Fonti:
 *  - data/raw/timings.txt: 235 timestamp (ms) del boss finale di Drakengard 3,
 *    catturati dal tool della community (Noremos/Drakengard3-helper e port web
 *    dieg-go/dod3-helper-web) con rilevamento pixel da video 59.94 fps.
 *  - data/raw/timings_grouping.txt: sezioni di tempo (BPM) della canzone.
 *  - Conteggio note per sezione dalla guida GameFAQs di rojotrece
 *    ("Drakengard 3 - End Boss Guide"): ZERO 25, FIVE 19, FOUR 18, THREE 21,
 *    TWO 31, ONE 34, ALL 86, piu' il chime finale (1) = 235.
 *
 * La verifica incrociata e' esatta: i 235 timestamp coincidono 1:1 con le 234
 * note della guida piu' il chime finale.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(resolve(root, p), 'utf8');

const rawTimings = read('data/raw/timings.txt')
  .split(/\s+/)
  .filter(Boolean)
  .map(Number);

if (rawTimings.length !== 235) {
  throw new Error(`attesi 235 timestamp, trovati ${rawTimings.length}`);
}

// Se esiste l'allineamento agli attacchi reali (tools/align-chart.mjs) si usa
// quello: i tempi sono gia' definitivi e non serve nessuna correzione.
const derivedPath = resolve(root, 'data/derived/aligned-timings.json');
let timings;
if (existsSync(derivedPath)) {
  const derived = JSON.parse(readFileSync(derivedPath, 'utf8'));
  if (!Array.isArray(derived.times) || derived.times.length !== 235) {
    throw new Error('data/derived/aligned-timings.json non contiene 235 tempi');
  }
  timings = derived.times.map(Number);
  console.log(
    `[chart] tempi dai pallini del video di riferimento (ancora ${derived.anchorSongMs ?? '?'} ms, ` +
      `${derived.stats?.dots ?? '?'} pallini, ${derived.stats?.filled ?? '?'} note riempite)`,
  );
} else {
  // Fallback: dati grezzi + correzione storica.
  // I timestamp della community hanno un salto di ~160 ms dal quinto anello in
  // poi (verificato con la registrazione: le prime 4 note sono sulla griglia,
  // dalla quinta tutto il resto e' ~160 ms in anticipo). Riallinea il chart.
  const CORRECTION_FROM = 4;
  const CORRECTION_MS = 160;
  timings = rawTimings.map((t, index) => (index >= CORRECTION_FROM ? t + CORRECTION_MS : t));
  if (CORRECTION_MS !== 0) {
    console.log(`[chart] correzione +${CORRECTION_MS} ms dal quinto anello (indice ${CORRECTION_FROM})`);
  }
}

const DEFS = [
  { id: 'zero', name: 'ZERO', bpm: 120, count: 25 },
  { id: 'five', name: 'FIVE', bpm: 132, count: 19 },
  { id: 'four', name: 'FOUR', bpm: 144, count: 18 },
  { id: 'three', name: 'THREE', bpm: 154, count: 21 },
  { id: 'two', name: 'TWO', bpm: 164, count: 31 },
  { id: 'one', name: 'ONE', bpm: 176, count: 34 },
  { id: 'all', name: 'ALL', bpm: 128, count: 86 },
];

const songNotes = timings.slice(0, -1);
const finaleT = timings[timings.length - 1];
const expected = DEFS.reduce((acc, d) => acc + d.count, 0);
if (songNotes.length !== expected) {
  throw new Error(`attese ${expected} note di canzone, trovate ${songNotes.length}`);
}

// Sezioni: assegnazione 1:1 in ordine, validata dai confini BPM del file di raggruppamento.
const BPM_BOUNDS = [0, 70_000, 112_000, 152_000, 194_000, 234_000, 261_000, 340_000];

const notes = [];
const sections = [];
let cursor = 0;
DEFS.forEach((def, i) => {
  const times = songNotes.slice(cursor, cursor + def.count);
  cursor += def.count;
  const start = times[0];
  const end = times[times.length - 1];
  const bound = BPM_BOUNDS[i] ?? 0;
  if (start < bound - 10_000 || start > bound + 30_000) {
    console.warn(
      `[chart] attenzione: ${def.name} inizia a ${(start / 1000).toFixed(2)}s, ` +
        `atteso intorno a ${(bound / 1000).toFixed(2)}s`,
    );
  }
  sections.push({ id: def.id, name: def.name, bpm: def.bpm, start, end, count: times.length });
  for (const t of times) {
    notes.push({ t, section: def.id, index: notes.length, finale: false });
  }
});

const lastAllEnd = sections[sections.length - 1].end;
sections.push({
  id: 'finale',
  name: 'FINALE',
  bpm: 46,
  start: lastAllEnd + 1000,
  end: finaleT,
  count: 1,
});
notes.push({ t: finaleT, section: 'finale', index: notes.length, finale: true });

// Il cerchio bianco del finale esce 4 battiti (una misura) prima del chime,
// al tempo finale di ~46 BPM.
const CIRCLE_LEAD_MS = (4 * 60_000) / 46;
const circleT = finaleT - CIRCLE_LEAD_MS;

// Segmenti di tempo (BPM) per il battito visivo, letti dal file della community.
const parseStamp = (s) => {
  const [m, sec] = s.trim().split(':');
  return Math.round((Number(m) * 60 + Number(sec)) * 1000);
};
const tempo = read('data/raw/timings_grouping.txt')
  .split(/\r?\n/)
  .map((line) => line.trim())
  .filter((line) => line && !line.startsWith('#'))
  .map((line) => {
    const m = line.match(/^(.+?)\s*-\s*(.+?)\s*\/\/\s*([\d.]+)\s*(?:->\s*([\d.]+))?$/);
    if (!m) return null;
    return {
      start: parseStamp(m[1]),
      end: parseStamp(m[2]),
      bpm: Number(m[3]),
      ...(m[4] ? { bpmTo: Number(m[4]) } : {}),
    };
  })
  .filter(Boolean);

const chart = {
  generatedBy: 'tools/build-chart.mjs',
  source: {
    timings: 'dieg-go/dod3-helper-web (timings.txt) / Noremos/Drakengard3-helper',
    chart: 'GameFAQs - Drakengard 3 End Boss Guide by rojotrece',
    tempo: 'dieg-go/dod3-helper-web (timings_grouping.txt)',
  },
  duration: finaleT,
  finaleT,
  circleT,
  sections,
  tempo,
  notes,
};

writeFileSync(resolve(root, 'src/data/chart.json'), JSON.stringify(chart, null, 2) + '\n');

const fmt = (ms) => `${Math.floor(ms / 60000)}:${((ms % 60000) / 1000).toFixed(2).padStart(5, '0')}`;
console.log(`[chart] ${notes.length} note totali (${songNotes.length} + chime)`);
for (const s of sections) console.log(`  ${s.name.padEnd(6)} ${String(s.count).padStart(3)} note  ${fmt(s.start)} -> ${fmt(s.end)}`);
console.log(`[chart] chime finale a ${fmt(finaleT)}, cerchio bianco a ${fmt(circleT)}`);
