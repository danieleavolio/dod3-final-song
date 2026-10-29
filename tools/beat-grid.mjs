/**
 * Stima tempo e fase reali di ogni sezione dalla registrazione ufficiale,
 * con un pettine di battute sull'inviluppo di attacco (spectral flux).
 * Scrive src/data/beat-grid.json, usato dalla vista Chart.
 *
 * Uso: node tools/beat-grid.mjs <pcm> [syncMs]
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pcmPath = process.argv[2];
const syncMs = Number(process.argv[3] ?? 24_918);
if (!pcmPath || !existsSync(pcmPath)) {
  console.error('uso: node tools/beat-grid.mjs <pcm-s16le-mono-11025> [syncMs]');
  process.exit(1);
}

const SR = 11025;
const raw = readFileSync(pcmPath);
const n = raw.length / 2;
const pcm = new Float32Array(n);
for (let i = 0; i < n; i += 1) pcm[i] = raw.readInt16LE(i * 2) / 32768;

const fft = (re, im) => {
  const N = re.length;
  for (let i = 1, j = 0; i < N; i += 1) {
    let bit = N >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let len = 2; len <= N; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang);
    const wi = Math.sin(ang);
    for (let i = 0; i < N; i += len) {
      let cr = 1;
      let ci = 0;
      for (let k = 0; k < len / 2; k += 1) {
        const ur = re[i + k];
        const ui = im[i + k];
        const vr = re[i + k + len / 2] * cr - im[i + k + len / 2] * ci;
        const vi = re[i + k + len / 2] * ci + im[i + k + len / 2] * cr;
        re[i + k] = ur + vr;
        im[i + k] = ui + vi;
        re[i + k + len / 2] = ur - vr;
        im[i + k + len / 2] = ui - vi;
        const ncr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = ncr;
      }
    }
  }
};

const WIN = 1024;
const HOP = 55;
const frames = Math.floor((n - WIN) / HOP);
const window = new Float64Array(WIN);
for (let i = 0; i < WIN; i += 1) window[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / WIN);
const flux = new Float32Array(frames);
let prev = new Float32Array(WIN / 2);
const re = new Float32Array(WIN);
const im = new Float32Array(WIN);
for (let f = 0; f < frames; f += 1) {
  const start = f * HOP;
  for (let i = 0; i < WIN; i += 1) {
    re[i] = pcm[start + i] * window[i];
    im[i] = 0;
  }
  fft(re, im);
  const mag = new Float32Array(WIN / 2);
  let sum = 0;
  for (let k = 2; k < WIN / 2; k += 1) {
    const m = Math.hypot(re[k], im[k]);
    mag[k] = m;
    const d = m - prev[k];
    if (d > 0) sum += d;
  }
  prev = mag;
  flux[f] = sum;
}
let maxFlux = 0;
for (let f = 0; f < frames; f += 1) maxFlux = Math.max(maxFlux, flux[f]);
const env = new Float32Array(frames);
for (let f = 0; f < frames; f += 1) env[f] = flux[f] / maxFlux;
const frameMs = (HOP / SR) * 1000;
const at = (ms) => {
  const x = ms / frameMs;
  const i = Math.floor(x);
  if (i < 1 || i >= frames - 1) return 0;
  const k = x - i;
  return env[i] * (1 - k) + env[i + 1] * k;
};

const chart = JSON.parse(readFileSync(resolve(root, 'src/data/chart.json'), 'utf8'));
const grid = [];

for (const section of chart.sections) {
  if (section.id === 'finale') continue;
  // Finestra interna alla sezione, in tempo di audio.
  const from = section.start + syncMs + 300;
  const to = section.end + syncMs - 300;
  if (to - from < 2000) continue;

  const base = section.bpm;
  let best = null;
  for (let bpm = base * 0.94; bpm <= base * 1.06; bpm += 0.01) {
    const beat = 60_000 / bpm;
    const count = Math.max(4, Math.round((to - from) / beat));
    for (let phase = 0; phase < beat; phase += 5) {
      let sum = 0;
      // Il pettine parte dal bordo sinistro della finestra.
      const origin = from + (phase % beat);
      for (let k = 0; k <= count; k += 1) {
        const t = origin + k * beat;
        if (t > to) break;
        sum += at(t);
      }
      // Penalizza i pettini che cadono troppo radi o troppo fitti.
      if (!best || sum > best.sum) best = { bpm, beat, phase: origin % beat, sum };
    }
  }

  grid.push({
    id: section.id,
    name: section.name,
    bpm: Number(best.bpm.toFixed(2)),
    phaseMs: Math.round(best.phase),
    strength: Number((best.sum / Math.max(1, (to - from) / best.beat)).toFixed(3)),
    statedBpm: base,
  });
  console.log(
    `${section.name.padEnd(6)} ${String(base).padStart(3)} -> ${best.bpm.toFixed(2)} BPM` +
      `  fase ${String(Math.round(best.phase)).padStart(4)} ms  forza ${(best.sum / Math.max(1, (to - from) / best.beat)).toFixed(2)}`,
  );
}

mkdirSync(resolve(root, 'data/derived'), { recursive: true });
writeFileSync(
  resolve(root, 'src/data/beat-grid.json'),
  `${JSON.stringify({ source: 'official upload, spectral-flux beat comb', syncMs, grid }, null, 2)}\n`,
);
console.log(`[beat] scritto src/data/beat-grid.json`);
