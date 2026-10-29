import { AudioEngine } from './audio';
import { chart, sectionById, sectionLabel } from './chart';
import { PREROLL_MS, flightMsFor } from './constants';
import { InputManager } from './input';
import { Judge } from './judge';
import { Renderer, type JudgmentBanner } from './render';
import { isBetter, loadBest, saveBest } from './settings';
import type { BestRun, ChartNote, Mode, RunResult, Settings } from './types';

const WINDOWS: Record<Mode, { perfect: number; good: number }> = {
  authentic: { perfect: 70, good: 150 },
  practice: { perfect: 95, good: 220 },
};

export type GameState = 'idle' | 'running' | 'paused' | 'ended';

const EMPTY_STATE = new Int8Array(0);

export class Game {
  readonly audio = new AudioEngine();

  private readonly canvas: HTMLCanvasElement;
  private readonly renderer: Renderer;
  private readonly input = new InputManager();
  private settings: Settings;
  private judge: Judge | null = null;
  private runNotes: ChartNote[] = [];
  private state: GameState = 'idle';
  mode: Mode = 'authentic';
  private speed = 1;
  private startT = 0;
  private endT = chart.finaleT;
  private sectionId: string | null = null;
  private lastJudgment: JudgmentBanner | null = null;
  private finaleHit: 'hit' | 'miss' | null = null;
  private finishAt = 0;
  private lastFrame = 0;
  private previewToken = 0;

  onEnd: (result: RunResult) => void = () => {};
  onPause: () => void = () => {};
  onResume: () => void = () => {};
  onRestart: () => void = () => {};

  constructor(canvas: HTMLCanvasElement, settings: Settings) {
    this.canvas = canvas;
    this.settings = { ...settings };
    this.renderer = new Renderer(canvas);
    this.input.attach();
    this.input.onHit = () => this.handleHit();
    window.addEventListener('keydown', this.onKeyDown);
    this.canvas.addEventListener('pointerdown', this.handlePointer);
    requestAnimationFrame(this.loop);
  }

  setSettings(settings: Settings): void {
    this.settings = { ...settings };
  }

  get status(): GameState {
    return this.state;
  }

  get practiceSectionId(): string | null {
    return this.mode === 'practice' ? this.sectionId : null;
  }

  get practiceSectionName(): string | null {
    return this.mode === 'practice' && this.sectionId ? (sectionById(this.sectionId)?.name ?? null) : null;
  }

  /** Volo effettivo per sezione: la base e' a 120 BPM, poi scala col tempo. */
  private flightBySection(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const section of chart.sections) {
      out[section.id] = flightMsFor(this.settings.ringFlightMs, section.bpm);
    }
    return out;
  }

  async loadAudio(file: File): Promise<number> {
    await this.audio.loadFile(file);
    return this.audio.suggestedSyncMs;
  }

  clearAudio(): void {
    this.audio.clearFile();
  }

  /** Confronta gli attacchi del file con i colpi del chart (diagnostica). */
  measureAlignment(): ReturnType<AudioEngine['measure']> {
    return this.audio.measure(this.settings.audioSyncMs, chart.notes);
  }

  previewAudio(seconds = 5): void {
    const token = ++this.previewToken;
    const startedAt = performance.now();
    this.audio.start({ fromChartMs: 0, speed: 1, syncMs: this.settings.audioSyncMs });
    const tick = (): void => {
      if (token !== this.previewToken) return;
      if (performance.now() - startedAt >= seconds * 1000) {
        this.audio.stop();
        return;
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }

  startRun(mode: Mode, sectionOverride?: string): void {
    this.previewToken += 1;
    this.audio.stop();
    this.mode = mode;
    this.speed = mode === 'practice' ? this.settings.practiceSpeed : 1;

    let from = -PREROLL_MS;
    let to = chart.finaleT + 1200;
    let notes: ChartNote[] = chart.notes.slice();

    if (mode === 'practice') {
      const id = sectionOverride ?? this.settings.practiceSection;
      this.sectionId = id;
      if (id === 'finale') {
        from = chart.circleT - 3000;
        to = chart.finaleT + 1400;
        notes = chart.notes.filter((note) => note.finale);
      } else {
        const section = sectionById(id) ?? chart.sections[0]!;
        // Margine vero prima della sezione: il volo dell'anello piu' quattro
        // battiti, cosi' il conteggio non viene mangiato dal primo campanello.
        const beat = 60_000 / Math.max(40, section.bpm || 120);
        const lead = Math.min(6000, Math.max(2200, this.settings.ringFlightMs + beat * 4));
        from = Math.max(-PREROLL_MS, section.start - lead);
        to = section.end + 1300;
        notes = chart.notes.filter((note) => !note.finale && note.t >= from && note.t <= to);
      }
    } else {
      this.sectionId = null;
      // Con "salta intro" si parte vicino al primo anello; altrimenti dall'inizio
      // del file (la traccia puo' avere un intro lungo).
      from = this.settings.skipIntro
        ? -Math.min(8000, Math.max(PREROLL_MS, this.settings.audioSyncMs))
        : -Math.max(PREROLL_MS, this.settings.audioSyncMs);
    }

    const offsets = this.settings.sectionOffsets;
    const noteOffsets = this.settings.noteOffsets;
    notes = notes.map((note) => {
      const key = note.section === 'finale' ? 'all' : note.section;
      const shift = (offsets[key] ?? 0) + (noteOffsets[String(note.index)] ?? 0);
      return shift === 0 ? note : { ...note, t: note.t + shift };
    });
    this.runNotes = notes;
    const lastNote = notes[notes.length - 1];
    this.endT = lastNote ? lastNote.t + (lastNote.finale ? 1400 : 1300) : to;
    this.judge = new Judge(notes);
    this.judge.onMiss = (note, at) => this.handleMiss(note, at);
    this.startT = from;
    this.lastJudgment = null;
    this.finaleHit = null;
    this.finishAt = 0;
    this.state = 'running';

    this.audio.start({
      fromChartMs: from,
      speed: this.speed,
      syncMs: this.settings.audioSyncMs,
      flightMs: this.settings.ringFlightMs,
      flightBySection: this.flightBySection(),
      notes: this.settings.sfxEnabled ? notes : undefined,
      cueT: chart.circleT,
      outputDelayMs: this.settings.outputDelayMs,
    });
  }

  pause(): void {
    if (this.state !== 'running') return;
    this.state = 'paused';
    this.audio.pause();
    this.onPause();
  }

  resume(): void {
    if (this.state !== 'paused') return;
    this.state = 'running';
    this.audio.start({
      fromChartMs: this.audio.chartTime,
      speed: this.speed,
      syncMs: this.settings.audioSyncMs,
      flightMs: this.settings.ringFlightMs,
      flightBySection: this.flightBySection(),
      notes: this.settings.sfxEnabled ? this.runNotes : undefined,
      cueT: chart.circleT,
      outputDelayMs: this.settings.outputDelayMs,
    });
    this.onResume();
  }

  restart(): void {
    if (this.state === 'idle') return;
    const section = this.mode === 'practice' ? (this.sectionId ?? undefined) : undefined;
    this.startRun(this.mode, section);
    this.onRestart();
  }

  quit(): void {
    this.previewToken += 1;
    this.audio.stop();
    this.state = 'idle';
    this.judge = null;
    this.runNotes = [];
    this.lastJudgment = null;
    this.finaleHit = null;
    this.finishAt = 0;
  }

  debugState(): Record<string, number | string | boolean> {
    return {
      state: this.state,
      chartTime: Math.round(this.audio.chartTime),
      section: this.judge ? sectionLabel(this.audio.chartTime) : '-',
      judged: this.judge?.judged ?? 0,
      total: this.runNotes.length,
      combo: this.judge?.combo ?? 0,
      perfect: this.judge?.perfect ?? 0,
      good: this.judge?.good ?? 0,
      miss: this.judge?.miss ?? 0,
      accuracy: Number((this.judge?.accuracy() ?? 100).toFixed(2)),
      hasAudio: this.audio.hasFile,
      speed: this.speed,
      finale: this.finaleHit ?? 'pending',
      bells: this.audio.scheduledBells,
      hitSfx: this.audio.hitSounds,
    };
  }

  private handleHit = (): void => {
    if (this.state !== 'running' || !this.judge) return;
    const chartTime = this.audio.chartTime;
    const result = this.judge.press(chartTime, WINDOWS[this.mode]);
    if (result.kind === 'stray') {
      this.lastJudgment = { verdict: 'stray', delta: 0, at: this.audio.chartTime };
      return;
    }
    this.lastJudgment = { verdict: result.kind, delta: result.delta ?? 0, at: this.audio.chartTime };
    if (result.note?.finale) {
      this.finaleHit = 'hit';
      if (this.settings.sfxEnabled) this.audio.playFinale();
    } else if (this.settings.sfxEnabled) {
      this.audio.playHit(result.kind);
    }
    if (this.judge.finished) this.scheduleFinish();
  };

  private handleMiss(note: ChartNote, at: number): void {
    if (this.state !== 'running') return;
    this.lastJudgment = { verdict: 'miss', delta: 0, at };
    if (note.finale) this.finaleHit = 'miss';
    if (this.settings.sfxEnabled) this.audio.playMiss();
    if (this.mode === 'authentic') {
      this.finish(false);
      return;
    }
    if (this.judge?.finished) this.scheduleFinish();
  }

  private scheduleFinish(): void {
    if (this.finishAt === 0) this.finishAt = performance.now() + 1300;
  }

  private finish(cleared: boolean): void {
    if (this.state !== 'running' || !this.judge) return;
    this.state = 'ended';
    this.audio.stop();

    const judge = this.judge;
    const scope = this.mode === 'practice' ? this.sectionId : null;
    const previousBest = loadBest(this.mode, scope);
    const best: BestRun = {
      accuracy: judge.accuracy(),
      maxCombo: judge.maxCombo,
      miss: judge.miss,
      when: Date.now(),
    };
    const improved = isBetter(previousBest, best);
    const success = this.mode === 'practice' ? true : cleared;
    if (success && improved) saveBest(this.mode, scope, best);

    this.onEnd({
      mode: this.mode,
      cleared: success,
      accuracy: judge.accuracy(),
      perfect: judge.perfect,
      good: judge.good,
      miss: judge.miss,
      maxCombo: judge.maxCombo,
      total: this.runNotes.length,
      section: this.sectionId,
      finale: this.finaleHit,
      newBest: success && improved,
      best: success && improved ? best : previousBest,
    });
  }

  private render(dt: number): void {
    const idle = this.state === 'idle';
    const chartTime = idle ? 0 : this.audio.chartTime;
    const judge = this.judge;
    const practiceSection = this.mode === 'practice' && this.sectionId ? sectionById(this.sectionId) : undefined;
    this.renderer.draw(
      {
        chartTime,
        startT: this.startT,
        endT: this.endT,
        notes: idle ? [] : this.runNotes,
        state: judge?.state ?? EMPTY_STATE,
        mode: this.mode,
        paused: this.state === 'paused',
        section: idle ? 'THE FINAL SONG' : (practiceSection?.name ?? sectionLabel(chartTime)),
        paletteId: practiceSection?.id,
        flightMs: this.settings.ringFlightMs,
        combo: judge?.combo ?? 0,
        accuracy: judge?.accuracy() ?? 100,
        judged: judge?.judged ?? 0,
        total: this.runNotes.length,
        lastJudgment: this.lastJudgment,
        finaleHit: this.finaleHit,
        hasAudio: this.audio.hasFile,
        reduceMotion: this.settings.reduceMotion,
        demo: idle,
      },
      dt,
    );
  }

  private loop = (now: number): void => {
    requestAnimationFrame(this.loop);
    const dt = this.lastFrame === 0 ? 16 : Math.min(64, now - this.lastFrame);
    this.lastFrame = now;
    this.input.pollGamepad();

    if (this.state === 'running' && this.judge) {
      const chartTime = this.audio.chartTime;
      this.judge.advance(chartTime, WINDOWS[this.mode]);
      if (this.finishAt > 0 && now >= this.finishAt) this.finish(true);
      else if (chartTime >= this.endT) this.finish(true);
    }

    this.render(dt);
  };

  private onKeyDown = (event: KeyboardEvent): void => {
    if (event.code === 'Escape') {
      if (this.state === 'running') {
        event.preventDefault();
        this.pause();
      } else if (this.state === 'paused') {
        event.preventDefault();
        this.resume();
      }
      return;
    }
    if (event.code === 'KeyR' && (this.state === 'running' || this.state === 'paused')) {
      event.preventDefault();
      this.restart();
    }
  };

  private handlePointer = (): void => {
    if (this.state === 'running') this.handleHit();
  };
}
