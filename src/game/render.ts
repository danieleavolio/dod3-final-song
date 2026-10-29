import { chart, lastAllEnd } from './chart';
import { flightMsFor } from './constants';
import type { ChartNote, Mode } from './types';

export interface JudgmentBanner {
  verdict: 'perfect' | 'good' | 'miss' | 'stray';
  delta: number;
  at: number;
}

export interface RenderState {
  chartTime: number;
  startT: number;
  endT: number;
  notes: readonly ChartNote[];
  state: Int8Array;
  mode: Mode;
  paused: boolean;
  section: string;
  paletteId?: string;
  flightMs: number;
  combo: number;
  accuracy: number;
  judged: number;
  total: number;
  lastJudgment: JudgmentBanner | null;
  finaleHit: 'hit' | 'miss' | null;
  hasAudio: boolean;
  reduceMotion: boolean;
  demo: boolean;
}

interface Palette {
  bg1: string;
  bg2: string;
  accent: string;
  ring: string;
}

interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  size: number;
  rot: number;
  spin: number;
  alpha: number;
}

interface DepthParticle {
  x: number;
  y: number;
  z: number;
  size: number;
}

interface Shard {
  x: number;
  y: number;
  z: number;
  rot: number;
  spin: number;
  size: number;
}

const W = 1600;
const H = 900;
const CX = W / 2;
const CY = 430;
const HIT_R = 330;
const TAU = Math.PI * 2;

const PALETTES: Record<string, Palette> = {
  zero: { bg1: '#06070a', bg2: '#121721', accent: '#e8eef7', ring: '#ffffff' },
  five: { bg1: '#08070b', bg2: '#191723', accent: '#e2d8ea', ring: '#fbf7ff' },
  four: { bg1: '#05090a', bg2: '#101d20', accent: '#d8ece8', ring: '#f4fffc' },
  three: { bg1: '#090806', bg2: '#1c1a15', accent: '#efe3c6', ring: '#fff9ec' },
  two: { bg1: '#0a0708', bg2: '#1c1519', accent: '#e9d6d9', ring: '#fff6f7' },
  one: { bg1: '#0a0707', bg2: '#1b1512', accent: '#ead9d0', ring: '#fffaf6' },
  all: { bg1: '#060506', bg2: '#181316', accent: '#efe6da', ring: '#ffffff' },
  finale: { bg1: '#000000', bg2: '#000000', accent: '#ffffff', ring: '#ffffff' },
};

/** Spaziatura tra lettere per il testo su canvas (dove supportata). */
const tracking = (c: CanvasRenderingContext2D, value: string): void => {
  const ctx = c as CanvasRenderingContext2D & { letterSpacing?: string };
  if ('letterSpacing' in ctx) ctx.letterSpacing = value;
};

const FALLBACK: Palette = PALETTES.zero!;

const rgbCache = new Map<string, [number, number, number]>();

function hexToRgb(hex: string): [number, number, number] {
  const cached = rgbCache.get(hex);
  if (cached) return cached;
  const value = hex.replace('#', '');
  const out: [number, number, number] = [
    Number.parseInt(value.slice(0, 2), 16),
    Number.parseInt(value.slice(2, 4), 16),
    Number.parseInt(value.slice(4, 6), 16),
  ];
  rgbCache.set(hex, out);
  return out;
}

function mix(a: string, b: string, k: number): string {
  const [r1, g1, b1] = hexToRgb(a);
  const [r2, g2, b2] = hexToRgb(b);
  const t = Math.min(1, Math.max(0, k));
  return `rgb(${Math.round(r1 + (r2 - r1) * t)}, ${Math.round(g1 + (g2 - g1) * t)}, ${Math.round(b1 + (b2 - b1) * t)})`;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** Indice di battito continuo, con gestione del tratto finale in decelerazione. */
function beatIndex(t: number): number {
  let beats = 0;
  for (const segment of chart.tempo) {
    if (t <= segment.start) break;
    const end = Math.min(t, segment.end);
    if (end <= segment.start) continue;
    const durationMinutes = (segment.end - segment.start) / 60_000;
    const k = clamp((end - segment.start) / (segment.end - segment.start), 0, 1);
    if (segment.bpmTo === undefined) {
      beats += durationMinutes * segment.bpm * k;
    } else {
      beats += durationMinutes * (segment.bpm * k + ((segment.bpmTo - segment.bpm) * k * k) / 2);
    }
  }
  return beats;
}

function sectionIdAt(t: number): string {
  let id = chart.sections[0]?.id ?? 'zero';
  for (const section of chart.sections) {
    if (section.start <= t) id = section.id;
    else break;
  }
  return id;
}

export class Renderer {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private dpr = 1;
  private scale = 1;
  private ox = 0;
  private oy = 0;
  private clock = 0;
  private particles: Particle[] = [];
  private depth: DepthParticle[] = [];
  private shards: Shard[] = [];
  private city: { angle: number; radius: number; w: number; h: number; seed: number }[] = [];

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    const ctx = canvas.getContext('2d', { alpha: false });
    if (!ctx) throw new Error('Canvas 2D non disponibile');
    this.ctx = ctx;
    this.resize();
    window.addEventListener('resize', () => this.resize());
    this.seedParticles();
  }

  private resize(): void {
    const width = window.innerWidth;
    const height = window.innerHeight;
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.canvas.width = Math.max(1, Math.round(width * this.dpr));
    this.canvas.height = Math.max(1, Math.round(height * this.dpr));
    this.scale = Math.min(width / W, height / H);
    this.ox = (width - W * this.scale) / 2;
    this.oy = (height - H * this.scale) / 2;
  }

  private seedParticles(): void {
    this.particles = Array.from({ length: 90 }, () => ({
      x: Math.random() * W,
      y: Math.random() * H,
      vx: (Math.random() - 0.5) * 0.02,
      vy: -0.008 - Math.random() * 0.022,
      size: 1.2 + Math.random() * 2.6,
      rot: Math.random() * TAU,
      spin: (Math.random() - 0.5) * 0.0012,
      alpha: 0.06 + Math.random() * 0.18,
    }));
    this.depth = Array.from({ length: 150 }, () => ({
      x: Math.random() * 2 - 1,
      y: Math.random() * 2 - 1,
      z: 40 + Math.random() * 960,
      size: 0.5 + Math.random() * 2,
    }));
    this.shards = Array.from({ length: 20 }, () => ({
      x: Math.random() * 2 - 1,
      y: (Math.random() * 2 - 1) * 0.75,
      z: 80 + Math.random() * 920,
      rot: Math.random() * TAU,
      spin: (Math.random() - 0.5) * 0.0016,
      size: 14 + Math.random() * 46,
    }));
    // Citta' 3D: edifici su un anello attorno al centro, la camera ci orbita.
    this.city = Array.from({ length: 110 }, (_, index) => ({
      angle: (index / 110) * TAU + Math.random() * 0.03,
      radius: 760 + Math.random() * 620,
      w: 30 + Math.random() * 52,
      h: 45 + Math.random() * 195,
      seed: Math.random(),
    }));
  }

  draw(state: RenderState, dt: number): void {
    this.clock += dt;
    const c = this.ctx;

    c.setTransform(1, 0, 0, 1, 0, 0);
    c.fillStyle = '#000000';
    c.fillRect(0, 0, this.canvas.width, this.canvas.height);
    c.setTransform(this.dpr * this.scale, 0, 0, this.dpr * this.scale, this.dpr * this.ox, this.dpr * this.oy);

    const palette = this.paletteFor(state.chartTime, state.paletteId);

    this.drawBackground(palette);
    this.drawCity();
    this.drawDepthField(palette, state, dt);
    this.drawParticles(palette, state.reduceMotion, dt);
    this.drawEye(palette, state);

    const finaleK = clamp((state.chartTime - (lastAllEnd + 400)) / 3000, 0, 1);
    this.drawFinaleBackdrop(finaleK);
    this.drawFlower(finaleK);

    if (finaleK < 0.75) this.drawTargetRing(palette, state);
    this.drawNotes(palette, state, finaleK);
    this.drawForeground(palette, state);
    this.drawFinaleCue(state);
    this.drawBanner(state);
    if (!state.demo) this.drawCountdown(palette, state);
    if (!state.demo && !state.paused) this.drawHud(palette, state);
    if (state.paused) {
      c.fillStyle = 'rgba(6, 5, 4, 0.58)';
      c.fillRect(0, 0, W, H);
    }
  }

  private paletteFor(t: number, forced?: string): Palette {
    if (forced && PALETTES[forced]) return PALETTES[forced]!;
    const sections = chart.sections;
    let index = 0;
    for (let i = 0; i < sections.length; i += 1) {
      if (sections[i]!.start <= t) index = i;
      else break;
    }
    const current = PALETTES[sections[index]!.id] ?? FALLBACK;
    const previous = index > 0 ? (PALETTES[sections[index - 1]!.id] ?? current) : current;
    const k = clamp((t - sections[index]!.start) / 1600, 0, 1);
    return {
      bg1: mix(previous.bg1, current.bg1, k),
      bg2: mix(previous.bg2, current.bg2, k),
      accent: mix(previous.accent, current.accent, k),
      ring: mix(previous.ring, current.ring, k),
    };
  }

  private drawBackground(palette: Palette): void {
    const c = this.ctx;
    const sky = c.createRadialGradient(CX, CY - 60, 40, CX, CY, 1020);
    sky.addColorStop(0, palette.bg2);
    sky.addColorStop(0.55, palette.bg2);
    sky.addColorStop(1, palette.bg1);
    c.fillStyle = sky;
    c.fillRect(0, 0, W, H);

    const haze = c.createLinearGradient(0, 0, 0, H);
    haze.addColorStop(0, 'rgba(255, 255, 255, 0.03)');
    haze.addColorStop(0.5, 'rgba(0, 0, 0, 0)');
    haze.addColorStop(1, 'rgba(0, 0, 0, 0.55)');
    c.fillStyle = haze;
    c.fillRect(0, 0, W, H);

    const vignette = c.createRadialGradient(CX, CY, 320, CX, CY, 980);
    vignette.addColorStop(0, 'rgba(0, 0, 0, 0)');
    vignette.addColorStop(1, 'rgba(0, 0, 0, 0.7)');
    c.fillStyle = vignette;
    c.fillRect(0, 0, W, H);

    const moon = c.createRadialGradient(CX, 780, 20, CX, 780, 460);
    moon.addColorStop(0, 'rgba(226, 230, 234, 0.07)');
    moon.addColorStop(0.5, 'rgba(160, 168, 176, 0.03)');
    moon.addColorStop(1, 'rgba(0, 0, 0, 0)');
    c.fillStyle = moon;
    c.fillRect(0, 0, W, H);
  }

  /** Campo di profondita' 3D: cenere in avvicinamento e frammenti fluttuanti. */
  private drawDepthField(palette: Palette, state: RenderState, dt: number): void {
    const c = this.ctx;
    const focal = 640;
    const speed = state.reduceMotion ? 0.012 : 0.035;

    c.save();
    for (const p of this.depth) {
      p.z -= dt * speed;
      if (p.z < 30) {
        p.z += 970;
        p.x = Math.random() * 2 - 1;
        p.y = Math.random() * 2 - 1;
      }
      const s = focal / (focal + p.z);
      const x = CX + p.x * 760 * s;
      const y = CY + p.y * 460 * s;
      const r = Math.max(0.3, p.size * s);
      c.globalAlpha = 0.28 * s;
      c.fillStyle = p.size > 1.6 ? palette.ring : palette.accent;
      c.beginPath();
      c.arc(x, y, r, 0, TAU);
      c.fill();
    }

    for (const shard of this.shards) {
      shard.z -= dt * speed * 0.5;
      if (shard.z < 60) {
        shard.z += 900;
        shard.x = Math.random() * 2 - 1;
        shard.y = (Math.random() * 2 - 1) * 0.75;
      }
      shard.rot += shard.spin * dt;
      const s = focal / (focal + shard.z);
      const x = CX + shard.x * 700 * s;
      const y = CY + shard.y * 420 * s;
      const size = shard.size * s;
      c.save();
      c.translate(x, y);
      c.rotate(shard.rot);
      c.globalAlpha = 0.32 * s;
      for (let petal = 0; petal < 5; petal += 1) {
        c.save();
        c.rotate((petal * TAU) / 5);
        c.fillStyle = petal === 0 ? 'rgba(255, 252, 246, 0.95)' : 'rgba(236, 226, 210, 0.75)';
        c.beginPath();
        c.ellipse(0, -size * 0.5, size * 0.22, size * 0.5, 0, 0, TAU);
        c.fill();
        c.restore();
      }
      c.fillStyle = 'rgba(190, 160, 110, 0.9)';
      c.beginPath();
      c.arc(0, 0, size * 0.16, 0, TAU);
      c.fill();
      c.restore();
    }
    c.restore();
  }

  /** Citta' 3D: edifici su un anello, camera che ci orbita attorno. */
  private drawCity(): void {
    const c = this.ctx;
    const cam = this.clock * 0.00005;
    const baseY = 842;
    const items = this.city.map((b) => {
      const phi = b.angle - cam;
      const depth = Math.cos(phi); // 1 = davanti, -1 = dietro
      const scale = 0.45 + 0.55 * ((depth + 1) / 2);
      const x = CX + Math.sin(phi) * b.radius * 0.55 * (0.55 + 0.45 * ((depth + 1) / 2));
      return { b, phi, depth, scale, x, ground: baseY + depth * 140 };
    });
    items.sort((a, b) => a.depth - b.depth);

    for (const item of items) {
      const { b, phi, scale, x, ground } = item;
      const w = b.w * scale;
      const h = b.h * scale;
      const y = ground - h;
      // Profondita': le facciate lontane sbiadiscono nella foschia.
      c.globalAlpha = 0.5 + 0.4 * ((item.depth + 1) / 2);
      c.fillStyle = 'rgba(9, 10, 15, 0.9)';
      c.fillRect(x - w / 2, y, w, h);

      // Faccia laterale: la profondita' cambia con l'angolo.
      const side = Math.sin(phi) * w * 0.65;
      if (Math.abs(side) > 0.5) {
        c.fillStyle = 'rgba(4, 5, 8, 0.94)';
        c.beginPath();
        c.moveTo(x + w / 2, y);
        c.lineTo(x + w / 2 + side, y + h * 0.08);
        c.lineTo(x + w / 2 + side, y + h + h * 0.08);
        c.lineTo(x + w / 2, y + h);
        c.closePath();
        c.fill();
      }

      // Finestre accese, poche e larghe.
      const cols = Math.max(2, Math.floor(w / 14));
      const rows = Math.max(2, Math.floor(h / 20));
      for (let row = 0; row < rows; row += 1) {
        for (let col = 0; col < cols; col += 1) {
          const seed = Math.sin(b.seed * 91.7 + row * 7.3 + col * 13.1) * 43758.5453;
          const lit = seed - Math.floor(seed) > 0.58;
          if (!lit) continue;
          const wx = x - w / 2 + 5 + col * ((w - 10) / cols);
          const wy = y + 8 + row * ((h - 12) / rows);
          c.fillStyle = row % 3 === 0 ? 'rgba(238, 224, 196, 0.42)' : 'rgba(214, 200, 176, 0.24)';
          c.fillRect(wx, wy, Math.max(1.5, w / cols - 5), Math.max(1.8, h / rows - 6));
        }
      }

      // Bordo illuminato in alto.
      c.fillStyle = 'rgba(226, 216, 196, 0.08)';
      c.fillRect(x - w / 2, y, w, 1);
    }
    c.globalAlpha = 1;

    const horizon = c.createLinearGradient(0, 760, 0, 900);
    horizon.addColorStop(0, 'rgba(240, 232, 214, 0)');
    horizon.addColorStop(1, 'rgba(240, 232, 214, 0.06)');
    c.fillStyle = horizon;
    c.fillRect(0, 760, W, 140);
  }

  /** Impedimenti in primo piano: colonne e petali che coprono gli anelli. */
  private drawForeground(palette: Palette, state: RenderState): void {
    if (state.demo || state.paused) return;
    const t = state.chartTime;
    if (t < 0) return;
    const cycle = 12_000;
    const sweep = 1350;
    const phase = ((t % cycle) + cycle) % cycle;
    if (phase > sweep) return;
    const k = phase / sweep;
    const c = this.ctx;
    const forward = Math.floor(t / cycle) % 2 === 0;
    const x = forward ? -440 + (W + 880) * k : W + 440 - (W + 880) * k;

    c.save();
    const veil = c.createLinearGradient(x - 330, 0, x + 330, 0);
    veil.addColorStop(0, 'rgba(7, 6, 5, 0)');
    veil.addColorStop(0.24, 'rgba(7, 6, 5, 0.9)');
    veil.addColorStop(0.76, 'rgba(7, 6, 5, 0.9)');
    veil.addColorStop(1, 'rgba(7, 6, 5, 0)');
    c.fillStyle = veil;
    c.fillRect(x - 330, 0, 660, H);

    c.fillStyle = 'rgba(17, 15, 13, 0.97)';
    c.beginPath();
    c.moveTo(x - 96, 0);
    c.lineTo(x + 96, 0);
    c.lineTo(x + 62, H);
    c.lineTo(x - 62, H);
    c.closePath();
    c.fill();

    c.strokeStyle = palette.accent;
    c.globalAlpha = 0.22;
    c.lineWidth = 1.4;
    c.beginPath();
    c.moveTo(x - 96, 0);
    c.lineTo(x - 62, H);
    c.moveTo(x + 96, 0);
    c.lineTo(x + 62, H);
    c.stroke();
    c.globalAlpha = 1;

    for (let i = 0; i < 6; i += 1) {
      const px = x - 150 + i * 60;
      const py = 90 + ((i * 137 + k * 520) % (H - 200));
      c.fillStyle = 'rgba(11, 9, 8, 0.9)';
      c.beginPath();
      c.ellipse(px, py, 30, 17, i * 0.8 + k * 2.2, 0, TAU);
      c.fill();
    }
    c.restore();
  }

  private drawParticles(palette: Palette, reduceMotion: boolean, dt: number): void {
    const c = this.ctx;
    c.save();
    c.fillStyle = palette.accent;
    this.particles.forEach((particle, index) => {
      if (reduceMotion && index % 2 === 1) return;
      particle.x += particle.vx * dt;
      particle.y += particle.vy * dt;
      particle.rot += particle.spin * dt;
      if (particle.y < -20) {
        particle.y = H + 20;
        particle.x = Math.random() * W;
      }
      if (particle.x < -20) particle.x = W + 20;
      if (particle.x > W + 20) particle.x = -20;

      c.globalAlpha = particle.alpha;
      c.beginPath();
      c.ellipse(particle.x, particle.y, particle.size * 0.6, particle.size * 1.7, particle.rot, 0, TAU);
      c.fill();
    });
    c.restore();
  }

  private drawEye(palette: Palette, state: RenderState): void {
    const intensity: Record<string, number> = { two: 0.22, three: 0.3, one: 0.5, all: 0.66, finale: 0.5 };
    const id = state.paletteId ?? sectionIdAt(state.chartTime);
    const target = intensity[id] ?? 0;
    if (target === 0 && state.demo) return;

    const section = chart.sections.find((entry) => entry.id === id);
    const ramp = section ? clamp((state.chartTime - section.start) / 1400, 0, 1) : 0;
    const alpha = target * ramp;
    if (alpha <= 0.002) return;

    const c = this.ctx;
    c.save();
    c.translate(CX, -40);

    const sclera = c.createRadialGradient(0, 0, 60, 0, 0, 660);
    sclera.addColorStop(0, `rgba(238, 242, 246, ${0.1 * alpha})`);
    sclera.addColorStop(1, 'rgba(238, 242, 246, 0)');
    c.fillStyle = sclera;
    c.beginPath();
    c.ellipse(0, 0, 780, 430, 0, 0, TAU);
    c.fill();

    const iris = c.createRadialGradient(0, 190, 12, 0, 190, 210);
    iris.addColorStop(0, `rgba(198, 204, 208, ${0.4 * alpha})`);
    iris.addColorStop(1, 'rgba(44, 46, 50, 0)');
    c.fillStyle = iris;
    c.beginPath();
    c.arc(0, 190, 210, 0, TAU);
    c.fill();

    c.fillStyle = `rgba(4, 4, 5, ${0.5 * alpha})`;
    c.beginPath();
    c.ellipse(0, 190, 46, 112, 0, 0, TAU);
    c.fill();

    c.strokeStyle = palette.ring;
    c.globalAlpha = 0.16 * alpha;
    c.lineWidth = 2;
    c.beginPath();
    c.ellipse(0, 0, 780, 430, 0, 0.16 * Math.PI, 0.84 * Math.PI);
    c.stroke();

    c.restore();
  }

  /**
   * Fiore al centro del bersaglio: petali a strati con ombre e venature,
   * non il solito fiorellino a quattro petali.
   */
  private drawFlower(finaleK: number): void {
    const c = this.ctx;
    const t = this.clock;
    const alpha = 0.56 * (1 - finaleK * 0.75);
    if (alpha <= 0.01) return;

    c.save();
    c.translate(CX, CY + 8);
    // Vista a ~45 gradi: il fiore gira su se stesso dentro il piano inclinato.
    c.scale(0.72, 0.92);
    const spin = Math.sin(t * 0.00011) * 0.04 + t * 0.00018;
    c.rotate(spin);

    const shadow = c.createRadialGradient(0, 0, 12, 0, 0, 205);
    shadow.addColorStop(0, `rgba(18, 14, 12, ${0.3 * alpha})`);
    shadow.addColorStop(1, 'rgba(18, 14, 12, 0)');
    c.fillStyle = shadow;
    c.beginPath();
    c.arc(0, 0, 205, 0, TAU);
    c.fill();

    const layers = [
      { n: 16, len: 172, wid: 48, rot: 0.0, a: 0.55, dark: 0.2 },
      { n: 14, len: 150, wid: 43, rot: 0.22, a: 0.66, dark: 0.17 },
      { n: 12, len: 128, wid: 38, rot: 0.45, a: 0.76, dark: 0.14 },
      { n: 10, len: 106, wid: 33, rot: 0.68, a: 0.85, dark: 0.11 },
      { n: 8, len: 84, wid: 27, rot: 0.92, a: 0.92, dark: 0.08 },
      { n: 6, len: 62, wid: 21, rot: 1.18, a: 0.97, dark: 0.05 },
    ];

    for (const layer of layers) {
      for (let i = 0; i < layer.n; i += 1) {
        const angle = (i / layer.n) * TAU + layer.rot + Math.sin(t * 0.00035 + i * 1.7) * 0.012;
        // Profondita': i petali in basso sono vicini, quelli in alto lontani.
        const depth = -Math.cos(angle + spin);
        const depthScale = 1 + 0.09 * depth;
        const depthAlpha = 0.8 + 0.2 * (depth * 0.5 + 0.5);
        const a = alpha * depthAlpha;
        c.save();
        c.rotate(angle);
        c.scale(depthScale, depthScale);
        const gradient = c.createLinearGradient(0, 0, 0, -layer.len);
        gradient.addColorStop(0, `rgba(120, 102, 80, ${layer.dark * a})`);
        gradient.addColorStop(0.38, `rgba(226, 214, 192, ${0.62 * layer.a * a})`);
        gradient.addColorStop(1, `rgba(255, 252, 246, ${0.96 * layer.a * a})`);
        c.fillStyle = gradient;
        c.beginPath();
        c.moveTo(0, 0);
        c.bezierCurveTo(layer.wid, -layer.len * 0.22, layer.wid * 0.85, -layer.len * 0.72, 0, -layer.len);
        c.bezierCurveTo(-layer.wid * 0.85, -layer.len * 0.72, -layer.wid, -layer.len * 0.22, 0, 0);
        c.fill();
        c.strokeStyle = `rgba(255, 250, 240, ${0.14 * a})`;
        c.lineWidth = 1.1;
        c.stroke();
        c.strokeStyle = `rgba(150, 130, 100, ${0.22 * a})`;
        c.lineWidth = 1;
        c.beginPath();
        c.moveTo(0, -layer.len * 0.1);
        c.lineTo(0, -layer.len * 0.9);
        c.stroke();
        c.restore();
      }
    }

    const core = c.createRadialGradient(0, 0, 2, 0, 0, 36);
    core.addColorStop(0, `rgba(204, 166, 102, ${0.95 * alpha})`);
    core.addColorStop(0.55, `rgba(164, 124, 66, ${0.5 * alpha})`);
    core.addColorStop(1, 'rgba(120, 86, 40, 0)');
    c.fillStyle = core;
    c.beginPath();
    c.arc(0, 0, 36, 0, TAU);
    c.fill();

    // Stamì: posizioni deterministiche, niente sfarfallio.
    for (let i = 0; i < 46; i += 1) {
      const angle = i * 2.399963;
      const radius = 4 + Math.sqrt(i / 46) * 24;
      const x = Math.cos(angle) * radius;
      const y = Math.sin(angle) * radius;
      c.fillStyle = `rgba(238, 206, 146, ${0.85 * alpha})`;
      c.beginPath();
      c.arc(x, y, 1.5, 0, TAU);
      c.fill();
    }

    c.restore();
  }

  private drawFinaleBackdrop(k: number): void {
    if (k <= 0) return;
    const c = this.ctx;
    c.fillStyle = `rgba(0, 0, 0, ${0.94 * k})`;
    c.fillRect(0, 0, W, H);
  }

  private drawTargetRing(palette: Palette, state: RenderState): void {
    const c = this.ctx;
    const beats = beatIndex(state.chartTime);
    const phase = beats - Math.floor(beats);

    c.save();
    c.strokeStyle = palette.accent;
    c.globalAlpha = 0.07 * (1 - phase);
    c.lineWidth = 1.5;
    c.beginPath();
    c.arc(CX, CY, HIT_R + 46 + 34 * (1 - phase), 0, TAU);
    c.stroke();
    c.restore();

    c.save();
    c.strokeStyle = palette.ring;
    c.globalAlpha = state.demo ? 0.1 : 0.22;
    c.lineWidth = 2;
    c.beginPath();
    c.arc(CX, CY, HIT_R, 0, TAU);
    c.stroke();

    c.globalAlpha = 0.1;
    c.lineWidth = 1;
    c.beginPath();
    c.arc(CX, CY, HIT_R - 9, 0, TAU);
    c.stroke();

    for (let i = 0; i < 4; i += 1) {
      const angle = (i * TAU) / 4 + Math.PI / 4;
      const inner = HIT_R - 14;
      const outer = HIT_R + 14;
      c.globalAlpha = 0.2;
      c.beginPath();
      c.moveTo(CX + Math.cos(angle) * inner, CY + Math.sin(angle) * inner);
      c.lineTo(CX + Math.cos(angle) * outer, CY + Math.sin(angle) * outer);
      c.stroke();
    }
    c.restore();
  }

  private drawNotes(palette: Palette, state: RenderState, finaleK: number): void {
    const c = this.ctx;
    state.notes.forEach((note, index) => {
      const status = state.state[index] ?? 0;
      const delta = state.chartTime - note.t;
      const section = chart.sections.find((entry) => entry.id === note.section);
      const flight = Math.max(500, flightMsFor(state.flightMs, section?.bpm ?? 120));

      if (note.finale) {
        this.drawFinaleNote(state, palette, status, delta);
        return;
      }

      if (delta < -flight - 50 || delta > 520) return;

      if (status === 0) {
        const progress = (state.chartTime - (note.t - flight)) / flight;
        if (progress < 0) return;
        // Lineare di proposito: l'anello arriva a velocita' costante e il
        // momento del colpo e' leggibile. L'easing precedente rallentava
        // negli ultimi 300 ms e faceva sembrare l'arrivo in anticipo.
        const eased = progress <= 1 ? progress : 1;
        const radius =
          progress <= 1 ? 16 + (HIT_R - 16) * eased : HIT_R + (progress - 1) * 300;
        const alpha =
          progress <= 1
            ? clamp(progress * 4, 0, 1) * 0.92
            : clamp(1 - (progress - 1) * 6.6, 0, 1) * 0.75;
        const finalAlpha = alpha * (1 - finaleK);

        // Anello in 3D: parte di taglio (ellisse schiacciata) e si apre fino
        // al cerchio quando arriva sul bersaglio.
        const p = clamp(progress, 0, 1);
        const squash = 0.07 + 0.93 * Math.pow(p, 1.35);
        const tilt = (1 - p) * 0.16;
        const wobble = Math.sin(progress * 7 + index * 1.7) * 0.02 * (1 - p);
        c.save();
        c.translate(CX, CY);
        c.rotate(-tilt + wobble);
        c.strokeStyle = palette.ring;
        c.shadowColor = palette.accent;
        c.shadowBlur = 20;
        // bordo posteriore (spessore del toro)
        c.globalAlpha = finalAlpha * 0.38;
        c.lineWidth = 1.8;
        c.beginPath();
        c.ellipse(0, -2.5 * (1 - p), radius * 0.995, Math.max(1, radius * squash), 0, 0, TAU);
        c.stroke();
        // bordo frontale
        c.globalAlpha = finalAlpha;
        c.lineWidth = 3.2;
        c.beginPath();
        c.ellipse(0, 2.5 * (1 - p), radius, Math.max(1, radius * squash), 0, 0, TAU);
        c.stroke();
        c.restore();

        this.drawRosette(palette, radius, index, finalAlpha * 0.85, squash);
      } else if (status === 1) {
        const fade = clamp(1 - delta / 340, 0, 1);
        if (fade <= 0) return;
        c.save();
        c.globalAlpha = fade;
        c.strokeStyle = '#ffffff';
        c.lineWidth = 5;
        c.shadowColor = palette.accent;
        c.shadowBlur = 30;
        c.beginPath();
        c.arc(CX, CY, HIT_R, 0, TAU);
        c.stroke();

        c.lineWidth = 2;
        c.globalAlpha = fade * 0.75;
        for (let i = 0; i < 10; i += 1) {
          const angle = (i * TAU) / 10 + index * 0.6;
          const length = 26 + 46 * fade;
          c.beginPath();
          c.moveTo(CX + Math.cos(angle) * HIT_R, CY + Math.sin(angle) * HIT_R);
          c.lineTo(CX + Math.cos(angle) * (HIT_R + length), CY + Math.sin(angle) * (HIT_R + length));
          c.stroke();
        }
        c.restore();
      } else {
        const fade = clamp(1 - delta / 420, 0, 1);
        if (fade <= 0) return;
        c.save();
        c.globalAlpha = fade * 0.9;
        c.strokeStyle = '#c46a6a';
        c.lineWidth = 3;
        c.shadowColor = '#a34a4a';
        c.shadowBlur = 16;
        c.beginPath();
        c.arc(CX, CY, HIT_R, 0, TAU);
        c.stroke();
        c.restore();
      }
    });
  }

  private drawFinaleNote(state: RenderState, palette: Palette, status: number, delta: number): void {
    const c = this.ctx;
    const practice = state.mode === 'practice';

    if (status === 0 && practice && delta > -2400 && delta <= 0) {
      // Aiuto solo in pratica: anello che si chiude sul chime.
      const progress = (state.chartTime - (chart.finaleT - 2400)) / 2400;
      const radius = HIT_R + 220 * (1 - progress);
      c.save();
      c.globalAlpha = 0.22;
      c.strokeStyle = palette.ring;
      c.lineWidth = 2;
      c.setLineDash([10, 12]);
      c.beginPath();
      c.arc(CX, CY, radius, 0, TAU);
      c.stroke();
      c.restore();
    }

    if (status === 1) {
      const fade = clamp(1 - delta / 1000, 0, 1);
      if (fade > 0) {
        c.save();
        c.globalAlpha = fade * 0.9;
        c.fillStyle = '#ffffff';
        c.fillRect(0, 0, W, H);
        c.restore();
      }
    }
    if (status === 2) {
      const fade = clamp(1 - delta / 1200, 0, 1);
      if (fade > 0) {
        c.save();
        const g = c.createRadialGradient(CX, CY, 120, CX, CY, 900);
        g.addColorStop(0, 'rgba(80, 30, 30, 0)');
        g.addColorStop(1, `rgba(160, 70, 70, ${0.45 * fade})`);
        c.fillStyle = g;
        c.fillRect(0, 0, W, H);
        c.restore();
      }
    }
  }

  private drawRosette(
    palette: Palette,
    radius: number,
    index: number,
    alpha: number,
    squash = 1,
  ): void {
    const c = this.ctx;
    const rotation = this.clock * 0.0004 + index * 0.8;
    c.save();
    c.fillStyle = palette.accent;
    c.globalAlpha = alpha * 0.9;
    for (let i = 0; i < 4; i += 1) {
      const angle = rotation + (i * TAU) / 4;
      const x = CX + Math.cos(angle) * radius * 0.94;
      const y = CY + Math.sin(angle) * radius * squash * 0.94;
      c.save();
      c.translate(x, y);
      c.rotate(angle + Math.PI / 2);
      c.beginPath();
      c.ellipse(0, 0, 4.5, 9 * squash, 0, 0, TAU);
      c.fill();
      c.restore();
    }
    c.restore();
  }

  private drawFinaleCue(state: RenderState): void {
    const c = this.ctx;
    const age = state.chartTime - chart.circleT;
    if (age < -400) return;
    if (age >= 0) {
      const pulse = 0.5 + 0.5 * Math.sin(age * 0.004);
      c.save();
      c.globalAlpha = clamp(age / 320, 0, 1) * (0.65 + 0.35 * pulse);
      c.fillStyle = '#ffffff';
      c.shadowColor = '#ffffff';
      c.shadowBlur = 30;
      c.beginPath();
      c.arc(CX, CY - 30, 13 + 3 * pulse, 0, TAU);
      c.fill();
      c.globalAlpha *= 0.35;
      c.lineWidth = 1.5;
      c.strokeStyle = '#ffffff';
      c.beginPath();
      c.arc(CX, CY - 30, 30 + 10 * pulse, 0, TAU);
      c.stroke();
      c.restore();
    }
  }

  private drawBanner(state: RenderState): void {
    const banner = state.lastJudgment;
    if (!banner) return;
    const age = state.chartTime - banner.at;
    if (age < 0 || age > 700) return;
    const fade = 1 - age / 700;

    const labels: Record<JudgmentBanner['verdict'], string> = {
      perfect: 'PERFECT',
      good: 'GOOD',
      miss: 'MISS',
      stray: 'FUORI TEMPO',
    };
    const colors: Record<JudgmentBanner['verdict'], string> = {
      perfect: '#f6e7c8',
      good: '#dbe4ee',
      miss: '#c46a6a',
      stray: '#8c857b',
    };
    const c = this.ctx;
    c.save();
    c.globalAlpha = fade;
    c.textAlign = 'center';
    c.textBaseline = 'middle';
    c.fillStyle = colors[banner.verdict];
    tracking(c, '5px');
    c.font = '500 24px Cinzel, Georgia, serif';
    c.fillText(labels[banner.verdict], CX, CY + HIT_R + 52);
    tracking(c, '0px');
    if (banner.verdict === 'perfect' || banner.verdict === 'good') {
      const delta = Math.round(banner.delta);
      c.globalAlpha = fade * 0.6;
      c.font = 'italic 15px Garamond, Georgia, serif';
      c.fillText(`${delta > 0 ? '+' : ''}${delta} ms`, CX, CY + HIT_R + 78);
    }
    c.restore();
  }

  /** Conto alla rovescia sull'attacco del primo anello della run. */
  private drawCountdown(palette: Palette, state: RenderState): void {
    const first = state.notes[0];
    if (!first || first.finale) return;
    const lead = first.t - state.chartTime;
    if (lead < -700) return;

    const c = this.ctx;
    c.save();
    c.textAlign = 'center';
    c.textBaseline = 'middle';

    if (lead > 3400) {
      c.globalAlpha = 0.42;
      c.fillStyle = palette.accent;
      tracking(c, '4px');
      c.font = '500 11px Cinzel, Georgia, serif';
      c.fillText('INTRO', CX, 180);
      c.globalAlpha = 0.3;
      c.fillStyle = '#ffffff';
      tracking(c, '0px');
      c.font = 'italic 13px Garamond, Georgia, serif';
      c.fillText(`la canzone sta per iniziare · ${Math.ceil(lead / 1000)}s`, CX, 205);
      c.restore();
      return;
    }

    const label = lead > 0 ? String(Math.min(3, Math.max(1, Math.ceil(lead / 1000)))) : 'VIA';
    const alpha = lead > 0 ? 0.9 : clamp(1 + lead / 700, 0, 1) * 0.95;
    c.globalAlpha = alpha;
    c.fillStyle = palette.accent;
    c.shadowColor = palette.accent;
    c.shadowBlur = 26;
    tracking(c, '2px');
    c.font = '500 100px Cinzel, Georgia, serif';
    c.fillText(label, CX, 142);
    c.shadowBlur = 0;
    c.globalAlpha = alpha * 0.6;
    c.fillStyle = '#ffffff';
    tracking(c, '3px');
    c.font = '500 10px Cinzel, Georgia, serif';
    c.fillText(label === 'VIA' ? 'ORA' : 'ASPETTA IL PRIMO COLPO', CX, 204);
    c.restore();
  }


  private drawHud(palette: Palette, state: RenderState): void {
    const c = this.ctx;
    c.save();
    c.textBaseline = 'alphabetic';

    c.textAlign = 'start';
    c.fillStyle = 'rgba(255, 255, 255, 0.55)';
    tracking(c, '2.4px');
    c.font = '500 11px Cinzel, Georgia, serif';
    c.fillText(state.mode === 'authentic' ? 'AUTENTICA' : 'PRATICA', 54, 58);
    c.globalAlpha = 0.5;
    tracking(c, '0px');
    c.font = 'italic 13px Garamond, Georgia, serif';
    c.fillText(state.mode === 'authentic' ? 'un errore = game over' : 'nessun game over', 54, 78);

    c.textAlign = 'center';
    c.globalAlpha = 0.92;
    c.fillStyle = palette.accent;
    tracking(c, '8px');
    c.font = '500 23px Cinzel, Georgia, serif';
    c.fillText(state.section, CX, 64);
    const titleWidth = c.measureText(state.section).width;
    tracking(c, '0px');
    c.globalAlpha = 0.32;
    c.strokeStyle = palette.accent;
    c.lineWidth = 1;
    c.beginPath();
    c.moveTo(CX - titleWidth / 2 - 46, 57);
    c.lineTo(CX - titleWidth / 2 - 18, 57);
    c.moveTo(CX + titleWidth / 2 + 18, 57);
    c.lineTo(CX + titleWidth / 2 + 46, 57);
    c.stroke();

    if (state.combo >= 2) {
      c.textAlign = 'end';
      c.globalAlpha = 0.92;
      c.fillStyle = '#ffffff';
      tracking(c, '2px');
      c.font = '500 54px Cinzel, Georgia, serif';
      c.fillText(String(state.combo), W - 54, 96);
      tracking(c, '3px');
      c.globalAlpha = 0.45;
      c.font = '500 10px Cinzel, Georgia, serif';
      c.fillText('COMBO', W - 54, 116);
      tracking(c, '0px');
    }

    c.textAlign = 'start';
    c.globalAlpha = 0.45;
    c.fillStyle = '#ffffff';
    tracking(c, '1.6px');
    c.font = '500 12px Cinzel, Georgia, serif';
    c.fillText(`${state.judged} / ${state.total}`, 54, H - 44);

    c.textAlign = 'end';
    c.fillText(`${state.accuracy.toFixed(1)}%`, W - 54, H - 44);
    tracking(c, '0px');

    const progress = clamp((state.chartTime - state.startT) / Math.max(1, state.endT - state.startT), 0, 1);
    const barW = 560;
    const barX = CX - barW / 2;
    const barY = H - 34;
    c.globalAlpha = 0.14;
    c.fillStyle = '#ffffff';
    c.fillRect(barX, barY, barW, 1);
    c.globalAlpha = 0.7;
    c.fillStyle = palette.accent;
    c.fillRect(barX, barY, barW * progress, 1);
    c.beginPath();
    c.moveTo(barX + barW * progress - 3, barY - 3);
    c.lineTo(barX + barW * progress + 3, barY - 3);
    c.lineTo(barX + barW * progress, barY + 3);
    c.closePath();
    c.fill();

    c.textAlign = 'center';
    c.globalAlpha = 0.3;
    c.fillStyle = '#ffffff';
    tracking(c, '3px');
    c.font = '500 9px Cinzel, Georgia, serif';
    c.fillText(state.hasAudio ? 'AUDIO' : 'SINTETICO', CX, barY - 12);

    c.restore();
  }
}
