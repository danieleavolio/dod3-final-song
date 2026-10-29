import { RING_FLIGHT_MS } from './constants';
import { measureAlignment, type AlignmentReport } from './align';
import type { ChartNote } from './types';

interface Click {
  osc: OscillatorNode;
  gain: GainNode;
}

export interface StartOptions {
  fromChartMs: number;
  speed: number;
  syncMs: number;
  flightMs?: number;
  /** Volo effettivo per sezione (ms). Se manca si usa flightMs. */
  flightBySection?: Record<string, number>;
  notes?: readonly ChartNote[];
  cueT?: number;
  /** Ritardo dell'uscita audio dichiarato dall'utente (cuffie/TV), in ms. */
  outputDelayMs?: number;
  /** Suona il campione del colpo sul tempo di ogni nota (vista Chart). */
  hitClicks?: boolean;
}

/**
 * Orologio master + riproduzione.
 *
 * Il tempo del chart e' sempre `startChart + (ctxTime - startCtx) * 1000 * speed`,
 * quindi audio e note restano sincronizzati anche a velocita' ridotta.
 * Senza file audio viene riprodotto un click sintetico per ogni nota.
 */
export class AudioEngine {
  private ctx: AudioContext | null = null;
  private buffer: AudioBuffer | null = null;
  private source: AudioBufferSourceNode | null = null;
  private sourceGain: GainNode | null = null;
  private clicks: Click[] = [];
  private startCtx = 0;
  private startChart = 0;
  private speed = 1;
  private running = false;
  private pausedAt = 0;
  private sfxBus: DynamicsCompressorNode | null = null;
  private latencyMs = 0;
  private waveform: { peaks: Float32Array; bucketMs: number } | null = null;
  private sampleSources: AudioBufferSourceNode[] = [];

  /** Campioni personalizzati (presi dal file dell'utente). */
  launchSample: AudioBuffer | null = null;
  hitSample: AudioBuffer | null = null;
  private defaultLaunch: AudioBuffer | null = null;
  private defaultHit: AudioBuffer | null = null;

  /** Offset suggerito (ms) ricavato dal silenzio iniziale del file caricato. */
  suggestedSyncMs = 0;
  /** Diagnostica: campanelli programmati e suoni di colpo riprodotti. */
  scheduledBells = 0;
  hitSounds = 0;

  get context(): AudioContext | null {
    return this.ctx;
  }

  get hasFile(): boolean {
    return this.buffer !== null;
  }

  get fileDuration(): number {
    return this.buffer?.duration ?? 0;
  }

  get isRunning(): boolean {
    return this.running;
  }

  /** Posizione nel chart in ms (anche da fermo: ultima posizione nota). */
  get chartTime(): number {
    if (!this.running || !this.ctx) return this.pausedAt;
    return this.startChart + (this.ctx.currentTime - this.startCtx) * 1000 * this.speed;
  }

  ensureContext(): AudioContext {
    if (!this.ctx) this.ctx = new AudioContext({ latencyHint: 'interactive' });
    return this.ctx;
  }

  async loadFile(file: File): Promise<void> {
    const ctx = this.ensureContext();
    const data = await file.arrayBuffer();
    const decoded = await ctx.decodeAudioData(data);
    this.stop();
    this.buffer = decoded;
    this.suggestedSyncMs = detectLeadInMs(decoded);
    this.waveform = null;
  }

  clearFile(): void {
    this.stop();
    this.buffer = null;
    this.suggestedSyncMs = 0;
    this.waveform = null;
  }

  /** Misura gli attacchi reali del file caricato rispetto ai colpi del chart. */
  measure(syncMs: number, notes: readonly ChartNote[]): AlignmentReport | null {
    if (!this.buffer) return null;
    return measureAlignment(this.buffer, syncMs, notes);
  }

  /** Envelope di picco dell'audio per il visualizzatore (bucket in ms). */
  getWaveform(bucketMs = 2): { peaks: Float32Array; bucketMs: number } | null {
    if (!this.buffer) return null;
    if (this.waveform && this.waveform.bucketMs === bucketMs) return this.waveform;
    const data = this.buffer.getChannelData(0);
    const samplesPerBucket = Math.max(1, Math.round((this.buffer.sampleRate * bucketMs) / 1000));
    const count = Math.floor(data.length / samplesPerBucket);
    const peaks = new Float32Array(count);
    for (let i = 0; i < count; i += 1) {
      let max = 0;
      const start = i * samplesPerBucket;
      for (let j = 0; j < samplesPerBucket; j += 1) {
        const value = Math.abs(data[start + j] ?? 0);
        if (value > max) max = value;
      }
      peaks[i] = max;
    }
    this.waveform = { peaks, bucketMs };
    return this.waveform;
  }

  start(opts: StartOptions): void {
    const ctx = this.ensureContext();
    void ctx.resume().catch(() => undefined);
    this.stopNodes();
    this.scheduledBells = 0;
    this.hitSounds = 0;
    this.latencyMs =
      Math.round(Math.min(250, Math.max(0, (ctx.outputLatency || ctx.baseLatency || 0) * 1000))) +
      Math.max(0, Math.min(500, opts.outputDelayMs ?? 0));

    this.speed = opts.speed;
    this.startChart = opts.fromChartMs;
    this.pausedAt = opts.fromChartMs;
    const lead = 0.08;
    this.startCtx = ctx.currentTime + lead;

    // Il buffer parte dalla posizione che corrisponde a `fromChartMs + syncMs`.
    // La latenza di uscita va anticipata: si parte piu' avanti nel brano di
    // `latencyMs`, cosi' il suono arriva insieme al visuale.
    const syncEff = opts.syncMs + this.latencyMs;
    const audioStartChart = Math.max(opts.fromChartMs, -syncEff);
    const delay = (audioStartChart - opts.fromChartMs) / 1000 / opts.speed;
    const offset = (audioStartChart + syncEff) / 1000;

    if (this.buffer) {
      if (offset < this.buffer.duration) {
        const src = ctx.createBufferSource();
        src.buffer = this.buffer;
        src.playbackRate.value = opts.speed;
        const gain = ctx.createGain();
        gain.gain.value = 1;
        src.connect(gain).connect(ctx.destination);
        src.start(this.startCtx + delay, Math.max(0, offset));
        this.source = src;
        this.sourceGain = gain;
      }
    }
    if (opts.notes) {
      this.scheduleSpawnBells(
        opts.notes,
        opts.fromChartMs,
        opts.speed,
        opts.cueT,
        this.latencyMs,
        opts.flightMs ?? RING_FLIGHT_MS,
        opts.flightBySection,
        opts.hitClicks ?? false,
      );
    }

    this.running = true;
  }

  /** Riproduzione libera (per la sincronizzazione manuale). */
  playPreview(fromMs: number, rate = 1): { stop: () => void; positionMs: () => number } | null {
    if (!this.buffer) return null;
    const ctx = this.ensureContext();
    void ctx.resume().catch(() => undefined);
    const source = ctx.createBufferSource();
    source.buffer = this.buffer;
    source.playbackRate.value = Math.max(0.25, Math.min(2, rate));
    source.connect(ctx.destination);
    const startAt = ctx.currentTime + 0.06;
    const clamped = Math.max(0, Math.min(fromMs / 1000, Math.max(0, this.buffer.duration - 1)));
    source.start(startAt, clamped);
    return {
      positionMs: () => Math.round(clamped * 1000 + (ctx.currentTime - startAt) * 1000 * rate),
      stop: () => {
        try {
          source.stop();
        } catch {
          // gia' fermo
        }
        try {
          source.disconnect();
        } catch {
          // gia' disconnesso
        }
      },
    };
  }

  pause(): void {
    if (!this.running) return;
    this.pausedAt = this.chartTime;
    this.stopNodes();
    this.running = false;
  }

  stop(): void {
    if (this.running) this.pausedAt = this.chartTime;
    this.stopNodes();
    this.running = false;
  }

  private ensureSfxBus(): DynamicsCompressorNode {
    if (this.sfxBus) return this.sfxBus;
    const ctx = this.ensureContext();
    const compressor = ctx.createDynamicsCompressor();
    compressor.threshold.value = -14;
    compressor.knee.value = 24;
    compressor.ratio.value = 6;
    compressor.attack.value = 0.003;
    compressor.release.value = 0.25;
    const gain = ctx.createGain();
    gain.gain.value = 1;
    compressor.connect(gain).connect(ctx.destination);
    this.sfxBus = compressor;
    return compressor;
  }

  private scheduleSpawnBells(
    notes: readonly ChartNote[],
    from: number,
    speed: number,
    cueT: number | undefined,
    latencyMs: number,
    flightMs: number,
    flightBySection: Record<string, number> | undefined,
    hitClicks = false,
  ): void {
    const ctx = this.ensureContext();
    const earliest = ctx.currentTime + 0.03;
    const at = (chartMs: number): number =>
      Math.max(this.startCtx + (chartMs - latencyMs - from) / 1000 / speed, earliest);

    for (const note of notes) {
      if (note.finale) continue;
      const flight = flightBySection?.[note.section] ?? flightMs;
      const spawn = note.t - flight;
      if (spawn < from - 100) continue;
      if (this.launchSample) {
        this.playSample(this.launchSample, at(spawn), 0.85, true);
      } else {
        this.bell(at(spawn), 1760, 0.32, 0.8, [1, 2.0, 2.76, 3.0, 4.07], true);
      }
      this.scheduledBells += 1;
    }

    if (hitClicks) {
      for (const note of notes) {
        if (note.finale) continue;
        if (note.t < from - 100) continue;
        if (this.hitSample) {
          this.playSample(this.hitSample, at(note.t), 0.95, true);
        } else {
          this.bell(at(note.t), 2400, 0.16, 0.4, [1, 2], true);
        }
        this.hitSounds += 1;
      }
    }

    // Il finale: il "ping" acuto del cerchio bianco (quattro battiti prima del chime).
    if (typeof cueT === 'number' && cueT >= from) {
      this.bell(at(cueT), 2637, 0.3, 0.7, [1, 2.4], true);
      this.scheduledBells += 1;
    }
  }

  private playSample(buffer: AudioBuffer, when: number, level: number, track: boolean): void {
    const ctx = this.ensureContext();
    const source = ctx.createBufferSource();
    const gain = ctx.createGain();
    source.buffer = buffer;
    gain.gain.value = level;
    source.connect(gain).connect(this.ensureSfxBus());
    source.start(when);
    if (track) this.sampleSources.push(source);
  }

  /** Carica i due suoni originali (Otoge) usati come default. */
  async loadDefaultSamples(launchUrl: string, hitUrl: string): Promise<void> {
    const ctx = this.ensureContext();
    try {
      const [launchData, hitData] = await Promise.all([
        fetch(launchUrl).then((response) => response.arrayBuffer()),
        fetch(hitUrl).then((response) => response.arrayBuffer()),
      ]);
      this.defaultLaunch = await ctx.decodeAudioData(launchData);
      this.defaultHit = await ctx.decodeAudioData(hitData);
      if (!this.launchSample) this.launchSample = this.defaultLaunch;
      if (!this.hitSample) this.hitSample = this.defaultHit;
    } catch {
      // restano i suoni sintetici
    }
  }

  private bell(
    t0: number,
    base: number,
    level: number,
    decay: number,
    partials: number[],
    track = false,
  ): void {
    const ctx = this.ensureContext();
    const bus = this.ensureSfxBus();
    partials.forEach((ratio, index) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.value = base * ratio;
      const amp = level / (1 + index * 0.7);
      const life = Math.max(0.06, decay * (1 - index * 0.16));
      gain.gain.setValueAtTime(0.0001, t0);
      gain.gain.exponentialRampToValueAtTime(amp, t0 + 0.004);
      gain.gain.exponentialRampToValueAtTime(0.0001, t0 + life);
      osc.connect(gain).connect(bus);
      osc.start(t0);
      osc.stop(t0 + life + 0.05);
      if (track) this.clicks.push({ osc, gain });
    });
  }

  /** Suono del colpo andato a segno (l'"invio"). */
  playHit(kind: 'perfect' | 'good'): void {
    const ctx = this.ensureContext();
    void ctx.resume().catch(() => undefined);
    if (this.hitSample) {
      this.playSample(this.hitSample, ctx.currentTime + 0.005, 0.9, false);
    } else {
      const base = kind === 'perfect' ? 2637 : 2349;
      this.bell(ctx.currentTime + 0.005, base, kind === 'perfect' ? 0.55 : 0.45, 0.16, [1, 1.5, 2]);
    }
    this.hitSounds += 1;
  }

  /** Suono del colpo mancato. */
  playMiss(): void {
    const ctx = this.ensureContext();
    void ctx.resume().catch(() => undefined);
    const t0 = ctx.currentTime + 0.005;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'triangle';
    osc.frequency.setValueAtTime(220, t0);
    osc.frequency.exponentialRampToValueAtTime(110, t0 + 0.16);
    gain.gain.setValueAtTime(0.0001, t0);
    gain.gain.exponentialRampToValueAtTime(0.28, t0 + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.2);
    osc.connect(gain).connect(this.ensureSfxBus());
    osc.start(t0);
    osc.stop(t0 + 0.25);
  }

  /** Chime finale, più grande e lungo. */
  playFinale(): void {
    const ctx = this.ensureContext();
    void ctx.resume().catch(() => undefined);
    this.bell(ctx.currentTime + 0.01, 1568, 0.5, 1.4, [1, 1.5, 2, 2.5]);
  }

  private stopNodes(): void {
    if (this.source) {
      try {
        this.source.stop();
      } catch {
        // gia' fermo
      }
      try {
        this.source.disconnect();
      } catch {
        // gia' disconnesso
      }
      this.source = null;
    }
    if (this.sourceGain) {
      try {
        this.sourceGain.disconnect();
      } catch {
        // gia' disconnesso
      }
      this.sourceGain = null;
    }
    for (const click of this.clicks) {
      try {
        click.osc.stop();
      } catch {
        // gia' fermo
      }
      try {
        click.osc.disconnect();
        click.gain.disconnect();
      } catch {
        // gia' disconnesso
      }
    }
    this.clicks.length = 0;
    for (const source of this.sampleSources) {
      try {
        source.stop();
      } catch {
        // gia' fermo
      }
      try {
        source.disconnect();
      } catch {
        // gia' disconnesso
      }
    }
    this.sampleSources.length = 0;
  }
}

/**
 * Il chart usa come zero il PRIMO ANELLO (come il tool della community), non
 * l'inizio della traccia. Se il file parte con silenzio/lead-in, la prima nota
 * cadrebbe prima della musica: qui si misura il primo suono sostenuto.
 * Restituisce 0 se la traccia comincia subito.
 */
export function detectLeadInMs(buffer: AudioBuffer): number {
  const channel = buffer.getChannelData(0);
  const sampleRate = buffer.sampleRate;
  const frame = Math.max(1, Math.round(sampleRate * 0.01));
  const frames = Math.floor(channel.length / frame);
  if (frames === 0) return 0;

  const rms = new Float32Array(frames);
  let peak = 0;
  for (let f = 0; f < frames; f += 1) {
    let sum = 0;
    const start = f * frame;
    for (let i = 0; i < frame; i += 1) {
      const sample = channel[start + i] ?? 0;
      sum += sample * sample;
    }
    const value = Math.sqrt(sum / frame);
    rms[f] = value;
    if (value > peak) peak = value;
  }

  const threshold = Math.max(0.0015, peak * 0.03);
  for (let f = 0; f < frames; f += 1) {
    if (rms[f]! < threshold) continue;
    let sustained = 0;
    for (let k = 0; k < 5 && f + k < frames; k += 1) {
      if (rms[f + k]! >= threshold * 0.5) sustained += 1;
    }
    if (sustained >= 4) return Math.round(f * 10);
  }
  return 0;
}
