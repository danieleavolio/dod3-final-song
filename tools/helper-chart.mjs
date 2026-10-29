/**
 * Costruisce i tempi del chart dai pallini del video "Final Song with Input
 * Prompts" (m9IHeSP71gI), allineati alla canzone ufficiale.
 *
 * - canzone = video - 15.439 s (misurato, drift < 10 ms su 440 s)
 * - i pallini cadono sul bersaglio: il loro arrivo e' il momento del colpo
 * - le poche note senza pallino si riempiono coi timestamp grezzi della
 *   community, corretti con la mediana locale dei pallini
 *
 * Scrive data/derived/aligned-timings.json (tempi relativi alla prima nota)
 * e stampa il rapporto.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OFFSET_MS = 15_439;
const RAW_SYNC = 24_918;

const raw = JSON.parse(readFileSync('data/derived/helper-dots.json', 'utf8')).notes.map((n) => n.t * 1000 - OFFSET_MS);
const chart = JSON.parse(readFileSync(resolve(root, 'src/data/chart.json'), 'utf8'));
const rawTimings = readFileSync(resolve(root, 'data/raw/timings.txt'), 'utf8')
  .split(/\s+/).filter(Boolean).map(Number);

const rawSong = rawTimings.map((t) => t + RAW_SYNC);
const anchor = raw[0];

// DP pallini <-> grezzi
const N = raw.length;
const M = rawSong.length;
const INF = 1e18;
const dp = Array.from({ length: N + 1 }, () => new Float64Array(M + 1).fill(INF));
const back = Array.from({ length: N + 1 }, () => new Int8Array(M + 1));
dp[0][0] = 0;
const SKIP = 350;
for (let i = 0; i <= N; i += 1) {
  for (let j = 0; j <= M; j += 1) {
    if (i === 0 && j === 0) continue;
    let best = INF;
    let dir = 0;
    if (i > 0 && dp[i - 1][j] + SKIP < best) { best = dp[i - 1][j] + SKIP; dir = 1; }
    if (j > 0 && dp[i][j - 1] + SKIP < best) { best = dp[i][j - 1] + SKIP; dir = 2; }
    if (i > 0 && j > 0) {
      const cost = Math.abs(raw[i - 1] - rawSong[j - 1]);
      if (cost < 700 && dp[i - 1][j - 1] + cost < best) { best = dp[i - 1][j - 1] + cost; dir = 3; }
    }
    dp[i][j] = best;
    back[i][j] = dir;
  }
}
const pairs = [];
let i = N;
let j = M;
while (i > 0 || j > 0) {
  const dir = back[i][j];
  if (dir === 3) { pairs.push({ dot: raw[i - 1], raw: rawSong[j - 1], index: j - 1 }); i -= 1; j -= 1; }
  else if (dir === 1) i -= 1;
  else if (dir === 2) j -= 1;
  else break;
}
pairs.reverse();
console.log(`pallini ${N} · note ${M} · coppie ${pairs.length}`);

const byIndex = new Map(pairs.map((p) => [p.index, p]));
const deltasBySection = new Map();
for (const p of pairs) {
  const section = chart.notes[p.index].section;
  if (!deltasBySection.has(section)) deltasBySection.set(section, []);
  deltasBySection.get(section).push(p.raw - p.dot);
}
const medians = new Map();
for (const [s, ds] of deltasBySection) {
  const sorted = [...ds].sort((a, b) => a - b);
  medians.set(s, sorted[Math.floor(sorted.length / 2)]);
}

const times = [];
let filled = 0;
let outliers = 0;
for (let k = 0; k < M; k += 1) {
  const p = byIndex.get(k);
  if (p) {
    let t = p.dot - anchor;
    // In ALL i pallini sono fitti e qualche rilevamento si aggancia alla nota
    // sbagliata: se si discosta troppo dal grezzo (griglia di frame), vince il
    // grezzo. Fuori da ALL i due concordano e resta il pallino.
    if (chart.notes[k].section === 'all') {
      const rawT = rawSong[k] - anchor;
      if (Math.abs(t - rawT) > 150) {
        t = rawT;
        outliers += 1;
      }
    }
    times.push(t);
  } else {
    const section = chart.notes[k].section;
    const med = medians.get(section) ?? 0;
    times.push(rawSong[k] - med - anchor);
    filled += 1;
  }
}
// monotonia
for (let k = 1; k < times.length; k += 1) {
  if (times[k] <= times[k - 1] + 10) times[k] = times[k - 1] + 10;
}

const absDeltas = [];
for (const p of pairs) absDeltas.push(Math.abs(p.raw - p.dot));
absDeltas.sort((a, b) => a - b);
console.log(
  `riempite ${filled} · scartati ${outliers} pallini anomali · |grezzo-pallino| mediana ${absDeltas[Math.floor(absDeltas.length / 2)].toFixed(0)} ms · p90 ${absDeltas[Math.floor(absDeltas.length * 0.9)].toFixed(0)} ms`,
);
console.log(`ancora (prima nota in canzone): ${anchor.toFixed(0)} ms`);
for (const [s, med] of medians) console.log(`  ${s.padEnd(7)} mediana grezzo-pallino ${med.toFixed(0)} ms`);
console.log(`primi: ${times.slice(0, 6).map((t) => t.toFixed(0)).join(' ')}`);
console.log(`ultimi: ${times.slice(-4).map((t) => t.toFixed(0)).join(' ')}`);

writeFileSync(
  resolve(root, 'data/derived/aligned-timings.json'),
  `${JSON.stringify({
    source: 'helper video m9IHeSP71gI (falling dots), aligned to the official upload (offset 15439 ms)',
    generatedBy: 'tools/helper-chart.mjs',
    anchorSongMs: Math.round(anchor),
    stats: {
      notes: times.length,
      dots: N,
      filled,
      outliers,
      medianAbsDeltaVsRawMs: Math.round(absDeltas[Math.floor(absDeltas.length / 2)]),
    },
    times: times.map((t) => Math.round(t)),
  }, null, 2)}\n`,
);
