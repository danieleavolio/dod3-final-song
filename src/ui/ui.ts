import { chart } from '../game/chart';
import { OFFICIAL_DURATION_S, OFFICIAL_SYNC_MS, flightMsFor } from '../game/constants';
import type { AlignmentReport } from '../game/align';
import beatGrid from '../data/beat-grid.json';
import type { Game } from '../game/game';
import { loadBest, saveSettings } from '../game/settings';
import { clearAudioFile, saveAudioFile } from '../game/storage';
import type { BestRun, ChartNote, Mode, RunResult, Settings } from '../game/types';

type ScreenName = 'title' | 'practice' | 'audio' | 'help' | 'pause' | 'results' | 'sync' | 'editor' | 'tab';

const $ = <T extends Element>(root: ParentNode, selector: string): T => {
  const element = root.querySelector(selector);
  if (!element) throw new Error(`elemento mancante: ${selector}`);
  return element as T;
};

const formatAccuracy = (value: number): string => `${value.toFixed(1)}%`;

const formatClock = (ms: number): string => {
  const total = Math.max(0, Math.round(ms));
  const minutes = Math.floor(total / 60000);
  const seconds = Math.floor((total % 60000) / 1000);
  const millis = total % 1000;
  return `${minutes}:${String(seconds).padStart(2, '0')}.${String(millis).padStart(3, '0')}`;
};

const escapeHtml = (value: string): string =>
  value.replace(/[&<>"']/g, (character) => {
    switch (character) {
      case '&': return '&amp;';
      case '<': return '&lt;';
      case '>': return '&gt;';
      case '"': return '&quot;';
      default: return '&#39;';
    }
  });

const formatBest = (best: BestRun | null): string => {
  if (!best) return 'nessun record';
  const date = new Date(best.when).toLocaleDateString('it-IT');
  return `${formatAccuracy(best.accuracy)} · combo ${best.maxCombo} · ${date}`;
};

/** Petalo del fiore Intoner: punta a (0, 0), si apre verso l'alto. */
const PETAL = 'M0 0C34-26 88-58 138-158C64-132 18-78 0 0Z';

const bloomPetals = (items: ReadonlyArray<readonly [number, number]>): string =>
  items.map(([angle, scale]) => `<path d="${PETAL}" transform="rotate(${angle}) scale(${scale})"/>`).join('');

const ROMAN = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX'];

export class UI {
  private readonly root: HTMLElement;
  private readonly game: Game;
  private settings: Settings;
  private screen: ScreenName = 'title';
  private audioName: string | null = null;
  private audioNotice = '';
  private syncPreview: { stop: () => void; positionMs: () => number } | null = null;
  private syncRaf = 0;
  private wave: { peaks: Float32Array; bucketMs: number } | null = null;
  private waveCanvas: HTMLCanvasElement | null = null;
  private waveView = { start: 8_000, span: 30_000 };
  private markerMs = 23_000;
  private syncMode: 'bell' | 'hit' = 'bell';
  private waveDrag: { x: number; start: number; moved: boolean } | null = null;
  private wavePlayhead: number | null = null;
  private syncPausedAt: number | null = null;
  private syncRate = 1;
  private menuItems: HTMLButtonElement[] = [];
  private menuIndex = 0;
  private editorSection: string | null = null;
  private editorView = { start: 0, span: 12_000 };
  private editorCanvas: HTMLCanvasElement | null = null;
  private editorRaf = 0;
  private editorPlaying = false;
  private editorDrag: { x: number; startOffset: number; note: number | null; moved: boolean } | null = null;
  private editorRate = 1;
  private alignment: AlignmentReport | null = null;
  private editorSelected: number | null = null;
  private tabCanvas: HTMLCanvasElement | null = null;
  private tabRaf = 0;
  private tabPreview: { stop: () => void; positionMs: () => number } | null = null;
  private tabPlaying = false;
  private tabTime = 0;
  private tabView = 6500;
  private tabRate = 1;
  private tabHead = 0;
  private tabPx = 0.1;

  constructor(root: HTMLElement, game: Game, settings: Settings) {
    this.root = root;
    this.game = game;
    this.settings = { ...settings };

    game.onEnd = (result) => this.showResults(result);
    game.onPause = () => this.showPause();
    game.onResume = () => this.hide();
    game.onRestart = () => this.hide();
    window.addEventListener('keydown', this.handleSyncKey);
    window.addEventListener('keydown', this.handleMenuKey);
    window.addEventListener('keydown', this.handleEditorKey);
    window.addEventListener('keydown', this.handleTabKey);
  }

  setRestoredAudio(name: string): void {
    this.audioName = name;
    this.audioNotice = 'Canzone ripristinata dal browser (salvata in locale).';
  }

  /**
   * Migrazione al chart v2 (pallini del video di riferimento): una volta sola
   * azzera gli offset vecchi e riallinea il sync della registrazione ufficiale.
   */
  migrateChart(): void {
    if (!this.game.audio.hasFile) return;
    const official = Math.abs(this.game.audio.fileDuration - OFFICIAL_DURATION_S) < 2;

    try {
      if (localStorage.getItem('dod3fs.chart.v2') !== '1') {
        this.settings = {
          ...this.settings,
          sectionOffsets: {},
          noteOffsets: {},
          ...(official ? { audioSyncMs: OFFICIAL_SYNC_MS } : {}),
        };
        saveSettings(this.settings);
        this.game.setSettings(this.settings);
        localStorage.setItem('dod3fs.chart.v2', '1');
      }
    } catch {
      // storage non disponibile
    }

    // v7: ZERO era indietro; le altre sezioni un filo avanti. Spostamenti lievi.
    try {
      if (localStorage.getItem('dod3fs.chart.v7') !== '1') {
        this.settings = {
          ...this.settings,
          sectionOffsets: {
            zero: -120,
            five: -107,
            four: -158,
            three: -217,
            two: -137,
            one: -151,
            all: -100,
            finale: 0,
          },
          noteOffsets: {},
        };
        saveSettings(this.settings);
        this.game.setSettings(this.settings);
        localStorage.setItem('dod3fs.chart.v7', '1');
        this.alignment = null;
      }
    } catch {
      // storage non disponibile
    }
  }

  /**
   * Misura gli attacchi reali del file rispetto ai colpi del chart.
   * Se il sync dichiarato e' fuori di almeno 60 ms lo corregge, altrimenti
   * lascia tutto com'e'. Il numero resta visibile nella schermata Audio.
   */
  checkAlignment(): void {
    if (!this.game.audio.hasFile) return;
    const report = this.game.measureAlignment();
    if (!report || report.used < 40) return;
    this.alignment = report;
    this.updateAlignmentLine();
  }

  private updateAlignmentLine(): void {
    const element = this.root.querySelector<HTMLElement>('#alignment-line');
    if (!element) return;
    if (!this.alignment) {
      element.textContent = '';
      return;
    }
    const delta = this.alignment.globalDelta;
    element.textContent =
      delta === 0
        ? `Misura sul tuo file: colpi e attacchi coincidono (${this.alignment.used} note).`
        : `Misura sul tuo file: ${delta > 0 ? '+' : ''}${delta} ms di scarto medio su ${this.alignment.used} note.`;
  }

  shouldShowSongPrompt(): boolean {
    if (this.game.audio.hasFile) return false;
    try {
      return localStorage.getItem('dod3fs.songPromptDismissed') !== '1';
    } catch {
      return true;
    }
  }

  showSongPrompt(): void {
    this.cleanupCalibration();
    this.screen = 'title';
    this.render(`
      <section class="sheet compact">
        <div class="plate"><span class="no">I</span><span class="label">Canzone</span></div>
        <h2>Prima la musica</h2>
        <p class="muted">La canzone non è inclusa. Il download usa un server locale e salva il file nel browser.</p>
        <div class="row column">
          <button class="btn primary" data-action="download-song">Scarica la canzone</button>
          <button class="btn ghost" data-action="open-video">Apri il video ufficiale</button>
          <button class="btn ghost" data-action="have-file">Ho già il file</button>
          <button class="btn ghost" data-action="dismiss">Non ora</button>
        </div>
        <p id="song-status" class="audio-status">Download dal video ufficiale, salvataggio locale.</p>
      </section>
    `);
    this.on('[data-action="open-video"]', () => {
      window.open('https://www.youtube.com/watch?v=usgNkiExsCM', '_blank', 'noopener,noreferrer');
      this.dismissSongPrompt();
      this.showAudio();
    });
    this.on('[data-action="download-song"]', () => void this.downloadSong());
    this.on('[data-action="have-file"]', () => {
      this.dismissSongPrompt();
      this.showAudio();
    });
    this.on('[data-action="dismiss"]', () => {
      this.dismissSongPrompt();
      this.showTitle();
    });
  }

  private dismissSongPrompt(): void {
    try {
      localStorage.setItem('dod3fs.songPromptDismissed', '1');
    } catch {
      // storage non disponibile
    }
  }

  /** Scarica l'audio dal server locale (yt-dlp), lo carica e lo salva nel browser. */
  private async downloadSong(): Promise<void> {
    const statusElement =
      this.root.querySelector<HTMLElement>('#song-status') ?? this.root.querySelector<HTMLElement>('#audio-status');
    const setStatus = (text: string): void => {
      if (statusElement) statusElement.textContent = text;
    };
    setStatus('Connessione al server locale…');
    try {
      const health = await fetch('http://127.0.0.1:5198/api/health');
      if (!health.ok) throw new Error('server');
      setStatus('Download in corso dal video ufficiale…');
      const response = await fetch('http://127.0.0.1:5198/api/download');
      if (!response.ok) throw new Error('download');
      const blob = await response.blob();
      if (blob.size < 1000) throw new Error('vuoto');
      setStatus('Salvataggio della canzone nel browser…');
      const file = new File([blob], 'the-final-song.webm', { type: blob.type || 'audio/webm' });
      await this.game.loadAudio(file);
      await saveAudioFile(file);
      this.audioName = file.name;
      // Il chart e' agganciato agli attacchi di questa registrazione: se la
      // durata combacia col video ufficiale il sync e' noto, niente orecchio.
      const official = Math.abs(this.game.audio.fileDuration - OFFICIAL_DURATION_S) < 2;
      this.settings = { ...this.settings, audioSyncMs: official ? OFFICIAL_SYNC_MS : 0 };
      this.audioNotice = official
        ? 'Canzone scaricata e allineata: sync impostato sulla registrazione ufficiale.'
        : 'Canzone scaricata e salvata nel browser.';
      saveSettings(this.settings);
      this.game.setSettings(this.settings);
      this.alignment = null;
      this.migrateChart();
      window.setTimeout(() => this.checkAlignment(), 800);
      this.showSync();
    } catch {
      setStatus('Server locale non attivo o download non riuscito. Avvia "npm run song-server".');
    }
  }

  showTitle(): void {
    this.stopTab();
    this.cleanupCalibration();
    this.screen = 'title';
    const hasAudio = this.game.audio.hasFile;
    this.render(`
      <section class="title-screen">
        <div class="petals" aria-hidden="true"><i class="petal"></i><i class="petal"></i><i class="petal"></i><i class="petal"></i></div>

        <svg class="title-art title-art--ghost" viewBox="-200 -200 400 400" aria-hidden="true">
          <g fill="currentColor">${bloomPetals([[0, 1], [72, 0.96], [144, 1.02], [216, 0.94], [288, 0.99]])}</g>
          <g fill="currentColor" opacity="0.72">${bloomPetals([[36, 0.56], [108, 0.5], [180, 0.6], [252, 0.48]])}</g>
          <circle r="26" fill="var(--paper)" />
        </svg>

        <svg class="title-art title-art--bloom" viewBox="-200 -200 400 400" aria-hidden="true">
          <g fill="currentColor" stroke="var(--paper)" stroke-width="4">${bloomPetals([[0, 1.04], [71, 0.92], [146, 1.06], [213, 0.9], [289, 1]])}</g>
          <g fill="currentColor" opacity="0.5">${bloomPetals([[22, 0.6], [99, 0.5], [178, 0.63], [254, 0.54]])}</g>
          <circle r="30" fill="var(--paper)" />
          <circle r="16" fill="none" stroke="currentColor" stroke-width="6" />
        </svg>

        <div class="title-main">
          <div class="title-copy">
            <p class="kicker">Drakengard 3 · Branch D</p>
            <h1 class="wordmark"><em>The Final</em><em class="second">Song</em></h1>
            <p class="jp">最期の歌</p>
            <nav class="main-menu" aria-label="Menu principale">
              <button class="menu-item" data-menu data-action="authentic" data-hint="Un errore e la run finisce.">
                <span class="mk">◆</span><span class="lbl">Autentica</span><span class="mk">◆</span>
              </button>
              <button class="menu-item" data-menu data-action="practice" data-hint="Scegli la sezione, rallenta, riprova.">
                <span class="mk">◆</span><span class="lbl">Pratica</span><span class="mk">◆</span>
              </button>
              <button class="menu-item" data-menu data-action="tab" data-hint="La canzone che scorre: lancio e arrivo.">
                <span class="mk">◆</span><span class="lbl">Canzone</span><span class="mk">◆</span>
              </button>
              <button class="menu-item" data-menu data-action="audio" data-hint="${hasAudio ? 'La canzone è già nel browser.' : 'Carica o scarica la canzone.'}">
                <span class="mk">◆</span><span class="lbl">Audio</span><span class="mk">◆</span>
              </button>
              <button class="menu-item" data-menu data-action="help" data-hint="Comandi e note.">
                <span class="mk">◆</span><span class="lbl">Info</span><span class="mk">◆</span>
              </button>
            </nav>
            <p class="title-fine">Fan project · nessuna affiliazione</p>
          </div>
        </div>

        <footer class="status-bar">
          <span id="menu-hint"></span>
          <span class="keys">
            <span class="key"><b>↑</b><b>↓</b> scegli</span>
            <span class="key"><b>⏎</b> conferma</span>
          </span>
        </footer>
      </section>
    `);

    this.on('[data-action="authentic"]', () => this.startRun('authentic'));
    this.on('[data-action="practice"]', () => this.showPractice());
    this.on('[data-action="tab"]', () => this.showTab());
    this.on('[data-action="audio"]', () => this.showAudio());
    this.on('[data-action="help"]', () => this.showHelp());
    this.setupMenu();
  }

  private setupMenu(): void {
    this.menuItems = [...this.root.querySelectorAll<HTMLButtonElement>('[data-menu]')];
    this.menuItems.forEach((item, index) => {
      item.addEventListener('mouseenter', () => this.selectMenu(index));
      item.addEventListener('focus', () => this.selectMenu(index));
    });
    this.selectMenu(0);
  }

  private selectMenu(index: number): void {
    if (!this.menuItems.length) return;
    const count = this.menuItems.length;
    this.menuIndex = ((index % count) + count) % count;
    this.menuItems.forEach((item, i) => item.classList.toggle('is-active', i === this.menuIndex));
    const hint = this.root.querySelector<HTMLElement>('#menu-hint');
    if (hint) hint.textContent = this.menuItems[this.menuIndex]?.dataset.hint ?? '';
  }

  private handleMenuKey = (event: KeyboardEvent): void => {
    if (this.screen !== 'title' || !this.menuItems.length) return;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      this.selectMenu(this.menuIndex + (event.key === 'ArrowDown' ? 1 : -1));
      return;
    }
    if (event.key === 'Enter' || event.code === 'Space') {
      event.preventDefault();
      this.menuItems[this.menuIndex]?.click();
    }
  };

  /**
   * Tablatura verticale: tempo che scorre verso il basso, due corde (lancio e
   * arrivo) e l'anello di ogni nota che attraversa il rigo.
   */
  showTab(): void {
    this.cleanupCalibration();
    this.cleanupEditor();
    this.screen = 'tab';
    if (!this.game.audio.hasFile) {
      this.showAudio();
      return;
    }
    this.stopTab();
    this.tabTime = 0;
    this.render(`
      <section class="tab-screen">
        <header class="tab-bar">
          <span class="tab-name">The Final Song</span>
          <span class="tab-clock" id="tab-clock">0:00.000</span>
          <div class="tab-actions">
            <button class="tab-btn is-on" data-tab-rate="1">1×</button>
            <button class="tab-btn" data-tab-rate="0.75">0,75×</button>
            <button class="tab-btn" data-tab-zoom="-">−</button>
            <button class="tab-btn" data-tab-zoom="+">+</button>
            <button class="tab-btn play" data-action="tab-play">▶</button>
            <button class="tab-btn" data-action="tab-close">×</button>
          </div>
        </header>
        <div class="tab-stage"><canvas id="tab"></canvas></div>
        <footer class="tab-foot">
          <span>spazio play · ↑↓ scorri · clic per andare</span>
          <span class="tab-legend"><i></i> lancio <i class="hit"></i> arrivo</span>
        </footer>
      </section>
    `);

    this.tabCanvas = this.root.querySelector<HTMLCanvasElement>('#tab');
    this.tabCanvas?.addEventListener('pointerdown', this.onTabPointer);
    this.on('[data-action="tab-play"]', () => this.toggleTab());
    this.on('[data-action="tab-close"]', () => {
      this.stopTab();
      this.showTitle();
    });
    this.root.querySelectorAll<HTMLButtonElement>('[data-tab-rate]').forEach((button) => {
      button.addEventListener('click', () => {
        this.tabRate = Number(button.dataset.tabRate ?? '1');
        this.root
          .querySelectorAll('[data-tab-rate]')
          .forEach((other) => other.classList.toggle('is-on', other === button));
        if (this.tabPlaying) this.playTab();
      });
    });
    this.root.querySelectorAll<HTMLButtonElement>('[data-tab-zoom]').forEach((button) => {
      button.addEventListener('click', () => {
        const factor = button.dataset.tabZoom === '-' ? 1.45 : 0.69;
        this.tabView = Math.min(16_000, Math.max(2500, this.tabView * factor));
        this.drawTab();
      });
    });
    this.drawTab();
  }

  private stopTabAudio(): void {
    this.tabPreview?.stop();
    this.tabPreview = null;
    if (this.tabRaf) {
      cancelAnimationFrame(this.tabRaf);
      this.tabRaf = 0;
    }
    this.tabPlaying = false;
    const button = this.root.querySelector<HTMLElement>('[data-action="tab-play"]');
    if (button) button.textContent = '▶';
  }

  private stopTab(): void {
    this.stopTabAudio();
    this.tabCanvas = null;
  }

  private toggleTab(): void {
    if (this.tabPlaying) this.stopTabAudio();
    else this.playTab();
  }

  private playTab(): void {
    this.stopTabAudio();
    const controller = this.game.audio.playPreview(this.tabTime + this.settings.audioSyncMs, this.tabRate);
    if (!controller) return;
    this.tabPreview = controller;
    this.tabPlaying = true;
    const button = this.root.querySelector<HTMLElement>('[data-action="tab-play"]');
    if (button) button.textContent = '❚❚';
    const end = this.game.audio.fileDuration * 1000 - this.settings.audioSyncMs;
    const tick = (): void => {
      if (!this.tabPreview || this.screen !== 'tab') return;
      this.tabTime = this.tabPreview.positionMs() - this.settings.audioSyncMs;
      if (this.tabTime >= end) {
        this.stopTabAudio();
        return;
      }
      this.drawTab();
      this.tabRaf = requestAnimationFrame(tick);
    };
    this.tabRaf = requestAnimationFrame(tick);
  }

  private onTabPointer = (event: PointerEvent): void => {
    const canvas = this.tabCanvas;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const y = event.clientY - rect.top;
    const target = this.tabTime + (y - this.tabHead) / this.tabPx;
    const end = this.game.audio.fileDuration * 1000 - this.settings.audioSyncMs;
    this.tabTime = Math.max(0, Math.min(end, target));
    if (this.tabPlaying) this.playTab();
    else this.drawTab();
  };

  private handleTabKey = (event: KeyboardEvent): void => {
    if (this.screen !== 'tab') return;
    if (event.code === 'Escape') {
      event.preventDefault();
      this.stopTab();
      this.showTitle();
      return;
    }
    if (event.code === 'Space') {
      event.preventDefault();
      this.toggleTab();
      return;
    }
    if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
      event.preventDefault();
      const delta = event.key === 'ArrowUp' ? -2000 : 2000;
      const end = this.game.audio.fileDuration * 1000 - this.settings.audioSyncMs;
      this.tabTime = Math.max(0, Math.min(end, this.tabTime + delta));
      if (this.tabPlaying) this.playTab();
      else this.drawTab();
    }
  };

  private drawTab(): void {
    const canvas = this.tabCanvas;
    if (!canvas) return;
    const width = Math.max(320, canvas.clientWidth);
    const height = Math.max(320, canvas.clientHeight);
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    if (canvas.width !== Math.round(width * dpr) || canvas.height !== Math.round(height * dpr)) {
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
    }
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);

    const paper = '#0b0a09';
    const ink = '#ece5d6';
    const faint = 'rgba(236, 229, 214, 0.14)';
    const gold = '#c9a86a';
    const blood = '#c0492f';

    ctx.fillStyle = paper;
    ctx.fillRect(0, 0, width, height);

    const head = height * 0.42;
    const px = height / this.tabView;
    this.tabHead = head;
    this.tabPx = px;
    const now = this.tabTime;
    const yOf = (t: number): number => head + (t - now) * px;
    const from = now - head / px;
    const to = now + (height - head) / px;
    const xL = width * 0.34;
    const xH = width * 0.66;

    // Barre e quartine.
    for (const seg of beatGrid.grid) {
      const section = chart.sections.find((entry) => entry.id === seg.id);
      if (!section) continue;
      if (section.end < from - 1500 || section.start > to + 1500) continue;
      const anchor = seg.phaseMs - this.settings.audioSyncMs;
      const beat = 60_000 / Math.max(40, seg.bpm);
      const k0 = Math.ceil((Math.max(from, section.start - 1500) - anchor) / beat);
      const k1 = Math.floor((Math.min(to, section.end + 1500) - anchor) / beat);
      for (let k = k0; k <= k1; k += 1) {
        const t = anchor + k * beat;
        if (t < -1000) continue;
        const y = yOf(t);
        const bar = k % 4 === 0;
        ctx.strokeStyle = bar ? 'rgba(236, 229, 214, 0.3)' : faint;
        ctx.lineWidth = bar ? 1.2 : 1;
        ctx.beginPath();
        ctx.moveTo(34, y);
        ctx.lineTo(width - 20, y);
        ctx.stroke();
        if (bar) {
          ctx.fillStyle = 'rgba(236, 229, 214, 0.5)';
          ctx.font = '9px Cinzel, Georgia, serif';
          ctx.textAlign = 'left';
          ctx.textBaseline = 'middle';
          const barNumber = Math.max(1, Math.floor((t - section.start) / (beat * 4)) + 1);
          ctx.fillText(String(barNumber), 12, y);
        }
      }
    }

    // Le due corde.
    ctx.strokeStyle = 'rgba(236, 229, 214, 0.34)';
    ctx.lineWidth = 1.2;
    for (const x of [xL, xH]) {
      ctx.beginPath();
      ctx.moveTo(x, 26);
      ctx.lineTo(x, height - 8);
      ctx.stroke();
    }
    ctx.fillStyle = 'rgba(236, 229, 214, 0.55)';
    ctx.font = '10px Cinzel, Georgia, serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.fillText('LANCIO', xL, 10);
    ctx.fillText('ARRIVO', xH, 10);

    // Note: anello di lancio (cavo) e di arrivo (pieno), uniti dal volo.
    const baseFlight = this.settings.ringFlightMs;
    for (const note of chart.notes) {
      if (note.finale) continue;
      const section = chart.sections.find((entry) => entry.id === note.section);
      if (!section) continue;
      const hit = note.t + (this.settings.sectionOffsets[note.section] ?? 0) + (this.settings.noteOffsets[String(note.index)] ?? 0);
      const flight = flightMsFor(baseFlight, section.bpm);
      const launch = hit - flight;
      if (hit < from - 800 || launch > to + 800) continue;
      const yL = yOf(launch);
      const yH = yOf(hit);
      ctx.strokeStyle = 'rgba(201, 168, 106, 0.25)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(xL, yL);
      ctx.lineTo(xH, yH);
      ctx.stroke();
      // lancio
      ctx.strokeStyle = gold;
      ctx.lineWidth = 1.6;
      ctx.beginPath();
      ctx.arc(xL, yL, 6, 0, Math.PI * 2);
      ctx.stroke();
      // arrivo
      const active = Math.abs(hit - now) < 90;
      ctx.fillStyle = active ? '#f3eee2' : blood;
      ctx.beginPath();
      ctx.arc(xH, yH, active ? 9 : 7, 0, Math.PI * 2);
      ctx.fill();
    }

    // Playhead.
    ctx.strokeStyle = 'rgba(243, 238, 226, 0.8)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(0, head);
    ctx.lineTo(width, head);
    ctx.stroke();
    ctx.fillStyle = blood;
    ctx.beginPath();
    ctx.arc(xL, head, 4, 0, Math.PI * 2);
    ctx.arc(xH, head, 4, 0, Math.PI * 2);
    ctx.fill();

    const clock = this.root.querySelector<HTMLElement>('#tab-clock');
    if (clock) clock.textContent = formatClock(Math.max(0, now));
  }

  showPractice(): void {
    this.cleanupEditor();
    this.cleanupCalibration();
    this.screen = 'practice';
    const selectedSection = this.settings.practiceSection;
    const initialOffset = this.settings.sectionOffsets[selectedSection] ?? 0;
    const initialBest = loadBest('practice', selectedSection);
    const chapters = chart.sections
      .map((section, index) => {
        const selected = section.id === this.settings.practiceSection ? ' is-on' : '';
        const meta = section.id === 'finale' ? 'chime · 46 BPM' : `${section.count} note · ${section.bpm} BPM`;
        return `<button class="chapter${selected}" data-chip="${section.id}" role="listitem">
          <span class="idx">${ROMAN[index] ?? ''}</span>
          <span class="name">${section.name}</span>
          <span class="meta">${meta}</span>
        </button>`;
      })
      .join('');

    this.render(`
      <section class="sheet wide">
        <div class="plate"><span class="no">II</span><span class="label">Pratica</span></div>
        <h2>Scegli l'assalto<span class="thin">Nessun game over · finestra ±220 ms · velocità libera</span></h2>
        <div class="chapter-grid">
          <div class="chapter-list" role="list">${chapters}</div>
          <div class="chapter-form">
            <label class="field">
              <span class="top"><span class="k">Velocità</span><span class="v" id="speed-value">${Math.round(this.settings.practiceSpeed * 100)}%</span></span>
              <input id="speed" type="range" min="50" max="100" step="5" value="${Math.round(this.settings.practiceSpeed * 100)}" />
            </label>
            <label class="field">
              <span class="top"><span class="k">Allineamento sezione</span><span class="v" id="sec-offset-value">${initialOffset} ms</span></span>
              <input id="sec-offset" type="range" min="-500" max="500" step="10" value="${initialOffset}" />
              <p class="sub">Sposta gli anelli della sezione scelta, anche in Autentica.</p>
            </label>
            <div class="row">
              <button class="btn primary" data-action="start">Avvia</button>
              <button class="btn ghost" data-action="chart-editor">Vedi il chart</button>
            </div>
            <div class="row secondary">
              <button class="btn ghost" data-action="back">Indietro</button>
            </div>
            <p class="record-line"><span>Record</span><strong id="chapter-best">${formatBest(initialBest)}</strong></p>
          </div>
        </div>
      </section>
    `);

    this.root.querySelectorAll<HTMLButtonElement>('[data-chip]').forEach((chip) => {
      chip.addEventListener('click', () => {
        this.settings = { ...this.settings, practiceSection: chip.dataset.chip ?? 'all' };
        saveSettings(this.settings);
        this.game.setSettings(this.settings);
        this.root.querySelectorAll('[data-chip]').forEach((other) => other.classList.toggle('is-on', other === chip));
        const offset = this.settings.sectionOffsets[this.settings.practiceSection] ?? 0;
        const offsetInput = this.root.querySelector<HTMLInputElement>('#sec-offset');
        const offsetLabel = this.root.querySelector<HTMLElement>('#sec-offset-value');
        if (offsetInput) offsetInput.value = String(offset);
        if (offsetLabel) offsetLabel.textContent = `${offset} ms`;
        const bestLabel = this.root.querySelector<HTMLElement>('#chapter-best');
        if (bestLabel) bestLabel.textContent = formatBest(loadBest('practice', this.settings.practiceSection));
      });
    });

    const secOffset = $<HTMLInputElement>(this.root, '#sec-offset');
    const secOffsetValue = $<HTMLElement>(this.root, '#sec-offset-value');
    secOffset.addEventListener('input', () => {
      const value = Number(secOffset.value);
      this.settings = {
        ...this.settings,
        sectionOffsets: { ...this.settings.sectionOffsets, [this.settings.practiceSection]: value },
      };
      saveSettings(this.settings);
      this.game.setSettings(this.settings);
      secOffsetValue.textContent = `${value} ms`;
    });

    const speed = $<HTMLInputElement>(this.root, '#speed');
    const speedValue = $<HTMLElement>(this.root, '#speed-value');
    speed.addEventListener('input', () => {
      const percent = Number(speed.value);
      this.settings = { ...this.settings, practiceSpeed: percent / 100 };
      saveSettings(this.settings);
      this.game.setSettings(this.settings);
      speedValue.textContent = `${percent}%`;
    });

    this.on('[data-action="start"]', () => this.startRun('practice'));
    this.on('[data-action="chart-editor"]', () => this.showChartEditor());
    this.on('[data-action="back"]', () => this.showTitle());
  }

  /**
   * Vista del chart: onda, griglia a quartine e note sullo stesso foglio.
   * Si trascinano le note (o si usano le frecce) per allineare la sezione.
   */
  private showChartEditor(): void {
    this.stopEditor();
    this.cleanupCalibration();
    this.screen = 'editor';
    const id = this.settings.practiceSection;
    this.editorSection = id;
    const section = chart.sections.find((entry) => entry.id === id) ?? chart.sections[0]!;
    const offset = this.settings.sectionOffsets[id] ?? 0;
    const length = Math.max(4000, section.end - section.start);
    this.editorView.span = Math.min(8_000, length + 600);
    this.editorView.start = Math.max(0, section.start - 400);
    this.editorDrag = null;

    this.render(`
      <section class="sheet wide">
        <div class="plate"><span class="no">VIII</span><span class="label">Chart</span></div>
        <h2>${section.name}<span class="thin">Spartito, quartine e onda · ${Math.round(beatGrid.grid.find((entry) => entry.id === id)?.bpm ?? section.bpm)} BPM</span></h2>
        <div class="editor-head">
          <span class="k" id="editor-target">Sezione</span>
          <strong id="editor-offset">${offset > 0 ? '+' : ''}${offset} ms</strong>
        </div>
        <div class="wave-frame"><canvas id="editor" class="wave" height="240"></canvas></div>
        <div class="toolbar">
          <button class="tool" data-action="editor-play">▶ Ascolta</button>
          <button class="tool" data-action="editor-stop">■</button>
          <button class="tool is-on" data-editor-rate="1">1×</button>
          <button class="tool" data-editor-rate="0.75">0,75×</button>
          <button class="tool sep" data-editor-nudge="-20">-20</button>
          <button class="tool" data-editor-nudge="-5">-5</button>
          <button class="tool" data-editor-nudge="5">+5</button>
          <button class="tool" data-editor-nudge="20">+20</button>
          <button class="tool" data-action="editor-reset">0</button>
          <button class="tool" data-action="editor-select-section">Sezione</button>
          <button class="tool sep" data-action="editor-left">◀</button>
          <button class="tool" data-action="editor-right">▶</button>
          <button class="tool" data-action="editor-zoom-out">−</button>
          <button class="tool" data-action="editor-zoom-in">+</button>
        </div>
        <p class="note">Clicca una nota per spostarla; trascina il foglio per la sezione. Shift = fine. ←/→ 5 ms.</p>
        <div class="row">
          <button class="btn ghost" data-action="back">Indietro</button>
        </div>
      </section>
    `);

    this.editorCanvas = this.root.querySelector<HTMLCanvasElement>('#editor');
    const canvas = this.editorCanvas;
    if (canvas) {
      canvas.addEventListener('pointerdown', this.onEditorPointerDown);
      canvas.addEventListener('pointermove', this.onEditorPointerMove);
      canvas.addEventListener('pointerup', this.onEditorPointerUp);
      canvas.addEventListener('pointerleave', this.onEditorPointerUp);
    }

    this.editorSelected = null;
    this.on('[data-action="editor-play"]', () => this.playEditor());
    this.on('[data-action="editor-stop"]', () => this.stopEditor());
    this.on('[data-action="editor-reset"]', () => this.setEditorShift(0));
    this.on('[data-action="editor-select-section"]', () => {
      this.editorSelected = null;
      this.updateEditorReadout();
      this.drawEditor();
    });
    this.on('[data-action="editor-left"]', () => this.panEditor(-0.8));
    this.on('[data-action="editor-right"]', () => this.panEditor(0.8));
    this.on('[data-action="editor-zoom-out"]', () => this.zoomEditor(1.5));
    this.on('[data-action="editor-zoom-in"]', () => this.zoomEditor(0.66));
    this.root.querySelectorAll<HTMLButtonElement>('[data-editor-nudge]').forEach((button) => {
      const delta = Number(button.dataset.editorNudge ?? '0');
      button.addEventListener('click', () => this.nudgeEditor(delta));
    });
    this.root.querySelectorAll<HTMLButtonElement>('[data-editor-rate]').forEach((button) => {
      button.addEventListener('click', () => {
        this.editorRate = Number(button.dataset.editorRate ?? '1');
        this.root
          .querySelectorAll('[data-editor-rate]')
          .forEach((other) => other.classList.toggle('is-on', other === button));
      });
    });

    this.drawEditor();
  }

  private sectionOffset(id: string): number {
    return this.settings.sectionOffsets[id] ?? 0;
  }

  private noteOffset(index: number): number {
    return this.settings.noteOffsets[String(index)] ?? 0;
  }

  private noteTime(note: ChartNote): number {
    return note.t + this.sectionOffset(note.section) + this.noteOffset(note.index);
  }

  private activeOffset(): number {
    const id = this.editorSection;
    if (!id) return 0;
    if (this.editorSelected !== null) return this.noteOffset(this.editorSelected);
    return this.sectionOffset(id);
  }

  private nudgeEditor(delta: number): void {
    this.setEditorShift(this.activeOffset() + delta);
  }

  private setEditorShift(value: number, noteIndex: number | null = this.editorSelected): void {
    const id = this.editorSection;
    if (!id) return;
    if (noteIndex !== null) {
      const clamped = Math.max(-200, Math.min(200, Math.round(value)));
      this.settings = {
        ...this.settings,
        noteOffsets: { ...this.settings.noteOffsets, [String(noteIndex)]: clamped },
      };
    } else {
      const clamped = Math.max(-600, Math.min(600, Math.round(value)));
      this.settings = {
        ...this.settings,
        sectionOffsets: { ...this.settings.sectionOffsets, [id]: clamped },
      };
    }
    saveSettings(this.settings);
    this.game.setSettings(this.settings);
    this.updateEditorReadout();
    this.drawEditor();
  }

  private updateEditorReadout(): void {
    const id = this.editorSection;
    const label = this.root.querySelector<HTMLElement>('#editor-target');
    const readout = this.root.querySelector<HTMLElement>('#editor-offset');
    if (!id) return;
    if (this.editorSelected !== null) {
      const notes = chart.notes.filter((note) => !note.finale && note.section === id);
      const position = notes.findIndex((note) => note.index === this.editorSelected) + 1;
      const value = this.noteOffset(this.editorSelected);
      if (label) label.textContent = `Nota ${position}/${notes.length}`;
      if (readout) readout.textContent = `${value > 0 ? '+' : ''}${value} ms`;
      return;
    }
    const value = this.sectionOffset(id);
    if (label) label.textContent = 'Sezione';
    if (readout) readout.textContent = `${value > 0 ? '+' : ''}${value} ms`;
  }

  private panEditor(direction: number): void {
    const id = this.editorSection;
    if (!id) return;
    const section = chart.sections.find((entry) => entry.id === id);
    if (!section) return;
    const min = Math.max(0, section.start - 1500);
    const max = Math.max(min, section.end + 800 - this.editorView.span);
    this.editorView.start = Math.max(min, Math.min(max, this.editorView.start + direction * this.editorView.span));
    this.drawEditor();
  }

  private zoomEditor(factor: number): void {
    const span = Math.max(3000, Math.min(24_000, this.editorView.span * factor));
    const center = this.editorView.start + this.editorView.span / 2;
    this.editorView.span = span;
    this.editorView.start = Math.max(0, center - span / 2);
    this.drawEditor();
  }

  private playEditor(): void {
    this.stopEditor();
    if (!this.game.audio.hasFile) return;
    const id = this.editorSection;
    if (!id) return;
    const editorSection = chart.sections.find((entry) => entry.id === id);
    const notes = chart.notes
      .filter((note) => !note.finale && note.section === id)
      .map((note) => ({ ...note, t: this.noteTime(note) }));
    this.game.audio.start({
      fromChartMs: this.editorView.start,
      speed: this.editorRate,
      syncMs: this.settings.audioSyncMs,
      flightMs: this.settings.ringFlightMs,
      flightBySection: { [id]: flightMsFor(this.settings.ringFlightMs, editorSection?.bpm ?? 120) },
      notes,
      hitClicks: true,
      outputDelayMs: this.settings.outputDelayMs,
    });
    this.editorPlaying = true;
    const end = this.editorView.start + this.editorView.span;
    const tick = (): void => {
      if (!this.editorPlaying || this.screen !== 'editor') return;
      this.drawEditor();
      if (this.game.audio.chartTime > end + 120) {
        this.stopEditor();
        return;
      }
      this.editorRaf = requestAnimationFrame(tick);
    };
    this.editorRaf = requestAnimationFrame(tick);
  }

  private stopEditor(): void {
    if (this.editorRaf) {
      cancelAnimationFrame(this.editorRaf);
      this.editorRaf = 0;
    }
    if (this.editorPlaying) {
      this.game.audio.stop();
      this.editorPlaying = false;
    }
    this.drawEditor();
  }

  private cleanupEditor(): void {
    this.stopEditor();
    this.editorCanvas = null;
    this.editorDrag = null;
  }

  private drawEditor(): void {
    const canvas = this.editorCanvas;
    const id = this.editorSection;
    if (!canvas || !id) return;
    const section = chart.sections.find((entry) => entry.id === id);
    if (!section) return;

    const width = Math.max(320, canvas.clientWidth);
    const height = 240;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    if (canvas.width !== Math.round(width * dpr) || canvas.height !== Math.round(height * dpr)) {
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
    }
    canvas.style.height = `${height}px`;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);

    const start = this.editorView.start;
    const span = Math.max(1, this.editorView.span);
    const xOf = (t: number): number => ((t - start) / span) * width;
    // Griglia misurata sulla registrazione (pettine di battute sull'inviluppo
    // di attacco): quartine vere, non quelle dichiarate dal file della community.
    const seg = beatGrid.grid.find((entry) => entry.id === id);
    const gridBpm = seg?.bpm ?? section.bpm;
    const beat = 60_000 / Math.max(40, gridBpm);
    const anchor = seg ? seg.phaseMs - this.settings.audioSyncMs : section.start;
    const top = 30;
    const bottom = height - 24;
    const waveTop = 40;
    const waveBottom = 118;
    const staffY = 162;

    ctx.fillStyle = '#f8f4ea';
    ctx.fillRect(0, 0, width, height);

    const first = Math.ceil((start - anchor) / beat);
    const firstBar = Math.floor(first / 4);

    // Onda: una fascia tenue dietro il rigo, non il protagonista.
    const wave = this.game.audio.getWaveform(2);
    if (wave) {
      const mid = (waveTop + waveBottom) / 2;
      const amp = (waveBottom - waveTop) * 0.42;
      ctx.fillStyle = 'rgba(60, 46, 38, 0.26)';
      for (let x = 0; x < width; x += 1) {
        const t = start + (x / width) * span;
        if (t < 0) continue;
        const audioMs = t + this.settings.audioSyncMs;
        const b0 = Math.floor(audioMs / wave.bucketMs);
        const b1 = Math.max(b0 + 1, Math.floor((t + span / width + this.settings.audioSyncMs) / wave.bucketMs));
        let peak = 0;
        for (let b = b0; b < b1 && b < wave.peaks.length; b += 1) {
          if (wave.peaks[b]! > peak) peak = wave.peaks[b]!;
        }
        const h = Math.max(0.5, peak * amp);
        ctx.fillRect(x, mid - h, 1, h * 2);
      }
    } else {
      ctx.fillStyle = 'rgba(25, 18, 17, 0.35)';
      ctx.font = 'italic 13px Garamond, Georgia, serif';
      ctx.textAlign = 'center';
      ctx.fillText('Carica la canzone per vedere l\'onda', width / 2, (waveTop + waveBottom) / 2);
    }

    // Rigo: una linea orizzontale su cui stanno le teste delle note.
    ctx.strokeStyle = 'rgba(25, 18, 17, 0.42)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, staffY + 0.5);
    ctx.lineTo(width, staffY + 0.5);
    ctx.stroke();

    // Griglia: quartine sottili, battute marcate; numeri di battuta in alto,
    // 1-2-3-4 sotto il rigo.
    for (let k = first; ; k += 1) {
      const t = anchor + k * beat;
      if (t > start + span) break;
      const x = xOf(t);
      const bar = k % 4 === 0;
      ctx.strokeStyle = bar ? 'rgba(25, 18, 17, 0.32)' : 'rgba(25, 18, 17, 0.13)';
      ctx.lineWidth = bar ? 1.2 : 1;
      ctx.beginPath();
      ctx.moveTo(x, top);
      ctx.lineTo(x, bottom);
      ctx.stroke();
      ctx.textAlign = 'center';
      ctx.textBaseline = 'alphabetic';
      if (bar) {
        ctx.fillStyle = 'rgba(25, 18, 17, 0.55)';
        ctx.font = '8.5px Cinzel, Georgia, serif';
        ctx.fillText(String(k / 4 - firstBar + 1), x, 12);
      }
      const beatInBar = (((k % 4) + 4) % 4) + 1;
      ctx.fillStyle = bar ? 'rgba(25, 18, 17, 0.62)' : 'rgba(25, 18, 17, 0.42)';
      ctx.font = '9px Cinzel, Georgia, serif';
      ctx.fillText(String(beatInBar), x, staffY + 14);
    }

    // Note: testa a diamante sul rigo, gambo in su; l'originale resta in grigio.
    const notes = chart.notes.filter((note) => !note.finale && note.section === id);
    for (const note of notes) {
      if (this.noteTime(note) !== note.t) {
        const gx = xOf(note.t);
        if (gx >= -2 && gx <= width + 2) {
          ctx.strokeStyle = 'rgba(25, 18, 17, 0.3)';
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.moveTo(gx, staffY - 3.5);
          ctx.lineTo(gx + 3.5, staffY);
          ctx.lineTo(gx, staffY + 3.5);
          ctx.lineTo(gx - 3.5, staffY);
          ctx.closePath();
          ctx.stroke();
        }
      }
      const x = xOf(this.noteTime(note));
      if (x < -4 || x > width + 4) continue;
      const selected = note.index === this.editorSelected;
      if (selected) {
        ctx.strokeStyle = 'rgba(164, 133, 78, 0.9)';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(x, staffY, 12, 0, Math.PI * 2);
        ctx.stroke();
        ctx.fillStyle = 'rgba(164, 133, 78, 0.14)';
        ctx.fill();
      }
      ctx.strokeStyle = 'rgba(140, 31, 28, 0.8)';
      ctx.lineWidth = 1.4;
      ctx.beginPath();
      ctx.moveTo(x, staffY - 26);
      ctx.lineTo(x, staffY - 4);
      ctx.stroke();
      ctx.fillStyle = selected ? '#b03a2e' : '#8c1f1c';
      ctx.beginPath();
      ctx.moveTo(x, staffY - 5.5);
      ctx.lineTo(x + 5.5, staffY);
      ctx.lineTo(x, staffY + 5.5);
      ctx.lineTo(x - 5.5, staffY);
      ctx.closePath();
      ctx.fill();
    }

    // Playhead.
    if (this.editorPlaying) {
      const px = xOf(this.game.audio.chartTime);
      if (px >= 0 && px <= width) {
        ctx.strokeStyle = '#191211';
        ctx.lineWidth = 1.4;
        ctx.beginPath();
        ctx.moveTo(px, 0);
        ctx.lineTo(px, height);
        ctx.stroke();
      }
    }
  }

  private onEditorPointerDown = (event: PointerEvent): void => {
    const id = this.editorSection;
    if (!id || !this.editorCanvas) return;
    const rect = this.editorCanvas.getBoundingClientRect();
    const px = event.clientX - rect.left;
    const width = Math.max(1, this.editorCanvas.clientWidth);
    const span = Math.max(1, this.editorView.span);
    let hit: number | null = null;
    let bestDistance = 9;
    for (const note of chart.notes) {
      if (note.finale || note.section !== id) continue;
      const x = ((this.noteTime(note) - this.editorView.start) / span) * width;
      const distance = Math.abs(x - px);
      if (distance < bestDistance) {
        bestDistance = distance;
        hit = note.index;
      }
    }
    this.editorSelected = hit;
    this.updateEditorReadout();
    this.editorDrag = {
      x: event.clientX,
      startOffset: hit !== null ? this.noteOffset(hit) : this.sectionOffset(id),
      note: hit,
      moved: false,
    };
    try {
      this.editorCanvas.setPointerCapture(event.pointerId);
    } catch {
      // puntatore sintetico (test) o browser senza capture
    }
  };

  private onEditorPointerMove = (event: PointerEvent): void => {
    if (!this.editorDrag || !this.editorCanvas) return;
    const dx = event.clientX - this.editorDrag.x;
    if (Math.abs(dx) < 2) return;
    const msPerPx = this.editorView.span / Math.max(1, this.editorCanvas.clientWidth);
    // Con Shift il trascinamento e' piu' fine (un quinto).
    const gain = event.shiftKey ? 0.2 : 1;
    this.editorDrag.moved = true;
    this.setEditorShift(this.editorDrag.startOffset + dx * msPerPx * gain, this.editorDrag.note);
  };

  private onEditorPointerUp = (): void => {
    if (!this.editorDrag) return;
    this.editorDrag = null;
    // Riascolta subito: ogni trascinamento si sente senza premere altro.
    if (this.editorPlaying) this.playEditor();
  };

  private handleEditorKey = (event: KeyboardEvent): void => {
    if (this.screen !== 'editor') return;
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    event.preventDefault();
    const step = (event.shiftKey ? 20 : 5) * (event.key === 'ArrowLeft' ? -1 : 1);
    this.nudgeEditor(step);
  };

  showAudio(): void {
    this.cleanupCalibration();
    this.screen = 'audio';
    const loaded = this.game.audio.hasFile;
    const duration = this.game.audio.fileDuration;
    const durationLabel = loaded
      ? `${Math.floor(duration / 60)}:${String(Math.floor(duration % 60)).padStart(2, '0')}`
      : '—';
    const status = loaded
      ? 'Canzone caricata e pronta. Resta in questo browser: nessun upload.'
      : 'Nessun file: si gioca con i click sintetici, uno per nota.';

    this.render(`
      <section class="sheet">
        <div class="plate"><span class="no">III</span><span class="label">Audio</span></div>
        <h2>La tua copia<span class="thin">The Final Song · Keiichi Okabe</span></h2>
        <div class="record">
          <div>
            <span class="t">${loaded ? escapeHtml(this.audioName ?? 'file audio') : 'Nessun file caricato'}</span>
            <span class="s">${loaded ? 'Salvato in locale, ripristinato a ogni avvio' : 'Puoi scaricarla o scegliere un file'}</span>
          </div>
          <div class="d">${durationLabel}<small>Durata</small></div>
        </div>
        <p id="audio-status" class="audio-status">${this.audioNotice ? escapeHtml(this.audioNotice) : status}</p>
        <p id="alignment-line" class="audio-status"></p>
        <div class="row">
          <label class="file">
            <input id="audio-file" type="file" accept="audio/*,.mp3,.ogg,.wav,.flac,.m4a" />
            <span>Scegli un file</span>
          </label>
          <button class="btn primary" data-action="download-song">Scarica la canzone</button>
        </div>
        ${
          loaded
            ? `<div class="row secondary">
          <button class="btn ghost" data-action="sync-ear">Sincronizza la prima nota</button>
          <button class="btn ghost" data-action="remove">Rimuovi il file</button>
        </div>`
            : ''
        }
        <label class="field">
          <span class="top"><span class="k">Intro / offset audio</span><span class="v" id="sync-value">${formatClock(this.settings.audioSyncMs)}</span></span>
          <input id="sync" type="range" min="0" max="240000" step="10" value="${this.settings.audioSyncMs}" />
          <p class="sub">Si regola meglio sull'onda della prima nota.</p>
        </label>
        <label class="field">
          <span class="top"><span class="k">Ritardo audio (cuffie / TV)</span><span class="v" id="delay-value">${this.settings.outputDelayMs} ms</span></span>
          <input id="output-delay" type="range" min="0" max="400" step="10" value="${this.settings.outputDelayMs}" />
          <p class="sub">Se i colpi arrivano prima del suono, alza questo valore finché coincidono.</p>
        </label>
        <label class="check">
          <input id="sfx" type="checkbox" ${this.settings.sfxEnabled ? 'checked' : ''} />
          <span>Suoni di gioco (campana alla comparsa, colpo all'impatto)</span>
        </label>
        <label class="check">
          <input id="skip-intro" type="checkbox" ${this.settings.skipIntro ? 'checked' : ''} />
          <span>Salta l'intro e parti vicino al primo anello</span>
        </label>
        <div class="row">
          <button class="btn ghost" data-action="preview" ${loaded ? '' : 'disabled'}>Ascolta 5s</button>
          <button class="btn ghost" data-action="back">Indietro</button>
        </div>
      </section>
    `);

    const fileInput = $<HTMLInputElement>(this.root, '#audio-file');
    const statusElement = $<HTMLElement>(this.root, '#audio-status');
    fileInput.addEventListener('change', async () => {
      const file = fileInput.files?.[0];
      if (!file) return;
      statusElement.textContent = 'Caricamento e decodifica…';
      try {
        await this.game.loadAudio(file);
        this.audioName = file.name;
        this.settings = { ...this.settings, audioSyncMs: 0 };
        saveSettings(this.settings);
        this.game.setSettings(this.settings);
        this.audioNotice = '';
        this.alignment = null;
        this.migrateChart();
        void saveAudioFile(file)
          .then(() => {
            this.audioNotice = 'Canzone salvata nel browser: la ritrovi al prossimo avvio.';
          })
          .catch(() => undefined);
        window.setTimeout(() => this.checkAlignment(), 800);
        this.showSync();
      } catch {
        statusElement.textContent = 'Il browser non decodifica questo file. Prova MP3, OGG o WAV.';
      }
    });

    const sync = $<HTMLInputElement>(this.root, '#sync');
    const syncValue = $<HTMLElement>(this.root, '#sync-value');
    sync.addEventListener('input', () => {
      this.settings = { ...this.settings, audioSyncMs: Number(sync.value) };
      saveSettings(this.settings);
      this.game.setSettings(this.settings);
      syncValue.textContent = formatClock(this.settings.audioSyncMs);
    });

    const delay = $<HTMLInputElement>(this.root, '#output-delay');
    const delayValue = $<HTMLElement>(this.root, '#delay-value');
    delay.addEventListener('input', () => {
      this.settings = { ...this.settings, outputDelayMs: Number(delay.value) };
      saveSettings(this.settings);
      this.game.setSettings(this.settings);
      delayValue.textContent = `${delay.value} ms`;
    });

    const sfx = $<HTMLInputElement>(this.root, '#sfx');
    sfx.addEventListener('change', () => {
      this.settings = { ...this.settings, sfxEnabled: sfx.checked };
      saveSettings(this.settings);
      this.game.setSettings(this.settings);
    });

    const skipIntro = $<HTMLInputElement>(this.root, '#skip-intro');
    skipIntro.addEventListener('change', () => {
      this.settings = { ...this.settings, skipIntro: skipIntro.checked };
      saveSettings(this.settings);
      this.game.setSettings(this.settings);
    });

    this.on('[data-action="preview"]', () => this.game.previewAudio(5));
    this.on('[data-action="sync-ear"]', () => this.showSync());
    this.on('[data-action="download-song"]', () => void this.downloadSong());
    this.on('[data-action="auto-sync"]', () => {
      this.settings = { ...this.settings, audioSyncMs: this.game.audio.suggestedSyncMs };
      saveSettings(this.settings);
      this.game.setSettings(this.settings);
      this.audioNotice = `Allineamento applicato: ${formatClock(this.settings.audioSyncMs)}.`;
      this.showAudio();
    });
    this.on('[data-action="remove"]', () => {
      this.game.clearAudio();
      this.audioName = null;
      this.audioNotice = '';
      this.alignment = null;
      void clearAudioFile();
      this.showAudio();
    });
    this.on('[data-action="back"]', () => this.showTitle());
    this.updateAlignmentLine();
  }

  showSync(): void {
    this.cleanupCalibration();
    if (!this.game.audio.hasFile) {
      this.showAudio();
      return;
    }
    this.screen = 'sync';
    this.wave = this.game.audio.getWaveform(2);
    const duration = this.game.audio.fileDuration * 1000;
    this.markerMs =
      this.settings.audioSyncMs > this.settings.ringFlightMs
        ? this.settings.audioSyncMs - this.settings.ringFlightMs
        : 23_000;
    this.markerMs = Math.max(0, Math.min(this.markerMs, duration));
    this.waveView.span = Math.min(30_000, Math.max(4_000, duration));
    this.waveView.start = Math.max(
      0,
      Math.min(this.markerMs - this.waveView.span / 2, Math.max(0, duration - this.waveView.span)),
    );
    this.wavePlayhead = null;

    this.render(`
      <section class="sheet wide">
        <div class="plate"><span class="no">IV</span><span class="label">Sincronizzazione</span></div>
        <h2>Metti il marker<span class="thin">Sul primo campanello: il colpo arriva dopo il tempo di volo</span></h2>
        <div class="wave-frame"><canvas id="wave" class="wave" height="170"></canvas></div>
        <div class="toolbar">
          <button class="tool" data-action="wave-out">−</button>
          <button class="tool" data-action="wave-in">+</button>
          <button class="tool" data-action="wave-left">◀</button>
          <button class="tool" data-action="wave-right">▶</button>
          <button class="tool" data-action="wave-fit">Zoom 100%</button>
          <button class="tool sep" data-action="play-marker">▶ Dal marker</button>
          <button class="tool is-on" data-rate="1">1×</button>
          <button class="tool" data-rate="0.75">0,75×</button>
          <button class="tool" data-rate="0.5">0,5×</button>
        </div>
        <p id="sync-clock" class="sync-clock">${formatClock(this.markerMs)}</p>
        <p id="marker-label" class="sync-read"></p>
        <div class="modes">
          <label class="check"><input type="radio" name="syncmode" value="bell" ${this.syncMode === 'bell' ? 'checked' : ''} /> Il marker è il campanello (aggiungo il tempo di volo)</label>
          <label class="check"><input type="radio" name="syncmode" value="hit" ${this.syncMode === 'hit' ? 'checked' : ''} /> Il marker è già il colpo</label>
          <p class="note">Clicca l'onda per il marker; frecce ←/→ 10 ms; Spazio ascolta.</p>
        </div>
        <div class="row">
          <button class="btn primary" data-action="apply-marker">Imposta sync</button>
          <button class="btn ghost" data-action="back">Indietro</button>
        </div>
        <p id="sync-result" class="note">Se sbagli, torna qui: il sync si corregge anche in pausa.</p>
      </section>
    `);

    const canvas = $<HTMLCanvasElement>(this.root, '#wave');
    this.waveCanvas = canvas;
    canvas.addEventListener('pointerdown', this.onWaveDown);
    canvas.addEventListener('pointermove', this.onWaveMove);
    canvas.addEventListener('pointerup', this.onWaveUp);
    canvas.addEventListener('pointercancel', this.onWaveUp);
    canvas.addEventListener('wheel', this.onWaveWheel, { passive: false });

    this.root.querySelectorAll<HTMLInputElement>('input[name="syncmode"]').forEach((radio) => {
      radio.addEventListener('change', () => {
        if (!radio.checked) return;
        this.syncMode = radio.value === 'hit' ? 'hit' : 'bell';
        this.updateMarkerLabel();
      });
    });

    this.on('[data-action="wave-in"]', () => this.zoomWave(0.8));
    this.on('[data-action="wave-out"]', () => this.zoomWave(1.25));
    this.on('[data-action="wave-left"]', () => this.scrollWave(-0.5));
    this.on('[data-action="wave-right"]', () => this.scrollWave(0.5));
    this.on('[data-action="wave-fit"]', () => this.fitWave());
    this.on('[data-action="play-marker"]', () => {
      this.syncPausedAt = null;
      this.playSyncAt(this.markerMs);
    });
    this.root.querySelectorAll<HTMLButtonElement>('[data-rate]').forEach((button) => {
      button.addEventListener('click', () => {
        this.syncRate = Number(button.dataset.rate ?? '1');
        this.root.querySelectorAll('[data-rate]').forEach((other) => other.classList.toggle('is-on', other === button));
        if (this.syncPreview) {
          const position = this.syncPreview.positionMs();
          this.playSyncAt(position);
        }
      });
    });
    this.on('[data-action="apply-marker"]', () => this.applyMarker());
    this.on('[data-action="back"]', () => {
      this.cleanupSync();
      this.showAudio();
    });

    this.updateMarkerLabel();
    this.drawWave();
  }

  private applyMarker(): void {
    const extra = this.syncMode === 'bell' ? this.settings.ringFlightMs : 0;
    const sync = Math.max(0, Math.min(240_000, Math.round(this.markerMs + extra)));
    this.settings = { ...this.settings, audioSyncMs: sync };
    saveSettings(this.settings);
    this.game.setSettings(this.settings);
    const result = this.root.querySelector<HTMLElement>('#sync-result');
    if (result) {
      result.textContent = `Sync impostato: ${formatClock(sync)} (marker ${formatClock(this.markerMs)}${extra ? ' + 2 s' : ''}). Premi Indietro, poi avvia.`;
    }
  }

  private updateMarkerLabel(): void {
    const extra = this.syncMode === 'bell' ? this.settings.ringFlightMs : 0;
    const label = this.root.querySelector<HTMLElement>('#marker-label');
    if (label) label.textContent = `Marker ${formatClock(this.markerMs)} → sync ${formatClock(this.markerMs + extra)}`;
  }

  private onWaveDown = (event: PointerEvent): void => {
    const canvas = this.waveCanvas;
    if (!canvas) return;
    this.waveDrag = { x: event.clientX, start: this.waveView.start, moved: false };
    try {
      canvas.setPointerCapture(event.pointerId);
    } catch {
      // pointer capture non disponibile
    }
  };

  private onWaveMove = (event: PointerEvent): void => {
    const canvas = this.waveCanvas;
    const drag = this.waveDrag;
    if (!canvas || !drag) return;
    const dx = event.clientX - drag.x;
    if (!drag.moved && Math.abs(dx) <= 3) return;
    drag.moved = true;
    const duration = this.game.audio.fileDuration * 1000;
    const rect = canvas.getBoundingClientRect();
    this.waveView.start = Math.max(
      0,
      Math.min(drag.start - (dx / rect.width) * this.waveView.span, Math.max(0, duration - this.waveView.span)),
    );
    this.drawWave();
  };

  private onWaveUp = (event: PointerEvent): void => {
    const canvas = this.waveCanvas;
    const drag = this.waveDrag;
    this.waveDrag = null;
    if (!canvas || !drag) return;
    if (drag.moved) return;
    this.stopSync();
    const rect = canvas.getBoundingClientRect();
    const duration = this.game.audio.fileDuration * 1000;
    const k = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width));
    this.markerMs = Math.max(0, Math.min(duration, this.waveView.start + k * this.waveView.span));
    this.syncPausedAt = null;
    this.updateMarkerLabel();
    this.drawWave();
  };

  private onWaveWheel = (event: WheelEvent): void => {
    event.preventDefault();
    const canvas = this.waveCanvas;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const anchor = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width));
    this.zoomWave(event.deltaY > 0 ? 1.3 : 0.77, anchor);
  };

  private zoomWave(factor: number, anchor = 0.5): void {
    const duration = this.game.audio.fileDuration * 1000;
    const span = Math.max(500, Math.min(duration, this.waveView.span * factor));
    const anchorTime = this.waveView.start + anchor * this.waveView.span;
    this.waveView.span = span;
    this.waveView.start = Math.max(0, Math.min(anchorTime - anchor * span, Math.max(0, duration - span)));
    this.drawWave();
  }

  private scrollWave(fraction: number): void {
    const duration = this.game.audio.fileDuration * 1000;
    this.waveView.start = Math.max(
      0,
      Math.min(this.waveView.start + this.waveView.span * fraction, Math.max(0, duration - this.waveView.span)),
    );
    this.drawWave();
  }

  private fitWave(): void {
    this.waveView.start = 0;
    this.waveView.span = Math.max(1000, this.game.audio.fileDuration * 1000);
    this.drawWave();
  }

  private playSyncAt(fromMs: number): void {
    this.stopSync();
    this.syncPausedAt = null;
    const controller = this.game.audio.playPreview(fromMs, this.syncRate);
    if (!controller) return;
    this.syncPreview = controller;
    const tick = (): void => {
      if (!this.syncPreview || this.screen !== 'sync') return;
      const position = this.syncPreview.positionMs();
      const clock = this.root.querySelector<HTMLElement>('#sync-clock');
      if (clock) clock.textContent = formatClock(position);
      this.wavePlayhead = position;
      this.drawWave();
      this.syncRaf = requestAnimationFrame(tick);
    };
    this.syncRaf = requestAnimationFrame(tick);
  }

  private stopSync(preservePosition = false): void {
    if (preservePosition && this.syncPreview) {
      const position = this.syncPreview.positionMs();
      this.syncPausedAt = position;
      this.wavePlayhead = position;
    }
    this.syncPreview?.stop();
    this.syncPreview = null;
    if (!preservePosition) {
      this.wavePlayhead = null;
      this.syncPausedAt = null;
    }
    if (this.syncRaf) {
      cancelAnimationFrame(this.syncRaf);
      this.syncRaf = 0;
    }
    this.drawWave();
  }

  private cleanupSync(): void {
    this.stopSync();
    this.waveCanvas = null;
    this.wave = null;
    this.waveDrag = null;
  }

  private handleSyncKey = (event: KeyboardEvent): void => {
    if (this.screen !== 'sync') return;
    if (event.code === 'ArrowLeft' || event.code === 'ArrowRight') {
      event.preventDefault();
      const duration = this.game.audio.fileDuration * 1000;
      const step = (event.shiftKey ? 100 : 10) * (event.code === 'ArrowLeft' ? -1 : 1);
      this.markerMs = Math.max(0, Math.min(duration, this.markerMs + step));
      this.syncPausedAt = null;
      this.updateMarkerLabel();
      this.drawWave();
      return;
    }
    if (event.code !== 'Space') return;
    event.preventDefault();
    if (this.syncPreview) {
      const position = this.syncPreview.positionMs();
      this.stopSync(true);
      const clock = this.root.querySelector<HTMLElement>('#sync-clock');
      if (clock) clock.textContent = formatClock(position);
    } else {
      const from = this.syncPausedAt ?? this.markerMs;
      this.syncPausedAt = null;
      this.playSyncAt(from);
    }
  };

  private drawWave(): void {
    const canvas = this.waveCanvas;
    const wave = this.wave;
    if (!canvas || !wave) return;
    const width = Math.max(200, canvas.clientWidth);
    const height = 170;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    if (canvas.width !== Math.round(width * dpr) || canvas.height !== Math.round(height * dpr)) {
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
    }
    canvas.style.height = `${height}px`;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);

    ctx.fillStyle = '#f8f4ea';
    ctx.fillRect(0, 0, width, height);

    const gutter = 20;
    const band = height - gutter;

    // riga di mezzeria, come su un foglio di incisione
    ctx.strokeStyle = 'rgba(25, 18, 17, 0.12)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, band * 0.5 + 0.5);
    ctx.lineTo(width, band * 0.5 + 0.5);
    ctx.stroke();

    const duration = this.game.audio.fileDuration * 1000;
    const start = this.waveView.start;
    const span = Math.max(1, this.waveView.span);
    const mid = band * 0.5;
    const amp = band * 0.42;
    const buckets = wave.peaks.length;

    ctx.fillStyle = 'rgba(60, 46, 38, 0.62)';
    for (let x = 0; x < width; x += 1) {
      const t0 = start + (x / width) * span;
      if (t0 < 0 || t0 > duration) continue;
      const b0 = Math.floor(t0 / wave.bucketMs);
      const b1 = Math.max(b0 + 1, Math.floor((t0 + span / width) / wave.bucketMs));
      let peak = 0;
      for (let b = b0; b < b1 && b < buckets; b += 1) {
        if (wave.peaks[b]! > peak) peak = wave.peaks[b]!;
      }
      const h = Math.max(0.5, peak * amp);
      ctx.fillRect(x, mid - h, 1, h * 2);
    }

    // righello in basso, su una fascia di carta
    ctx.fillStyle = 'rgba(243, 238, 226, 0.94)';
    ctx.fillRect(0, band, width, gutter);
    ctx.strokeStyle = 'rgba(25, 18, 17, 0.14)';
    ctx.beginPath();
    ctx.moveTo(0, band + 0.5);
    ctx.lineTo(width, band + 0.5);
    ctx.stroke();

    const steps = [0.25, 0.5, 1, 2, 5, 10, 15, 30, 60];
    const step = steps.find((value) => span / 1000 / value <= 7) ?? 60;
    ctx.fillStyle = 'rgba(25, 18, 17, 0.58)';
    ctx.font = '8.5px Cinzel, Georgia, serif';
    ctx.textBaseline = 'middle';
    for (let t = Math.ceil(start / (step * 1000)) * step * 1000; t <= start + span; t += step * 1000) {
      if (t < 0 || t > duration) continue;
      const x = ((t - start) / span) * width;
      ctx.globalAlpha = 0.4;
      ctx.fillRect(x, band + 2, 1, 4);
      ctx.globalAlpha = 0.8;
      ctx.fillText(step < 1 ? `${(t / 1000).toFixed(2).replace('.', ',')} s` : formatClock(t), x + 3, band + 12);
      ctx.globalAlpha = 1;
    }

    const markerX = ((this.markerMs - start) / span) * width;
    if (markerX >= -2 && markerX <= width + 2) {
      ctx.strokeStyle = '#8c1f1c';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(markerX, 0);
      ctx.lineTo(markerX, height);
      ctx.stroke();
      ctx.fillStyle = '#8c1f1c';
      ctx.beginPath();
      ctx.moveTo(markerX - 6, 0);
      ctx.lineTo(markerX + 6, 0);
      ctx.lineTo(markerX, 11);
      ctx.closePath();
      ctx.fill();
    }

    if (this.wavePlayhead !== null) {
      const playX = ((this.wavePlayhead - start) / span) * width;
      if (playX >= 0 && playX <= width) {
        ctx.strokeStyle = 'rgba(25, 18, 17, 0.5)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(playX, 0);
        ctx.lineTo(playX, height);
        ctx.stroke();
      }
    }
  }

  showHelp(): void {
    this.cleanupCalibration();
    this.screen = 'help';
    this.render(`
      <section class="sheet wide chronicle">
        <div class="plate"><span class="no">VII</span><span class="label">Info</span></div>
        <div class="codex">
          <h2>Comandi</h2>
          <p class="muted first"><span class="kbd">Spazio</span> <span class="kbd">Invio</span> colpisci · <span class="kbd">Esc</span> pausa · <span class="kbd">R</span> ricomincia · clic colpisce · gamepad qualsiasi tasto.</p>
          <h2>Modalità</h2>
          <p class="muted">Autentica: un errore e finisce, ±150 ms. Pratica: nessun game over, ±220 ms, sezione e velocità 50–100%.</p>
          <h2>Canzone</h2>
          <p class="muted">Nessuna traccia inclusa. La carichi dal file o dal video ufficiale; resta nel browser. Il tab mostra lancio e arrivo di ogni anello.</p>
        </div>
        <div class="row">
          <button class="btn ghost" data-action="back">Indietro</button>
        </div>
        <p class="note">Fan project non affiliato a Square Enix, Access Games o Sony.</p>
      </section>
    `);
    this.on('[data-action="back"]', () => this.showTitle());
  }

  showPause(): void {
    this.cleanupCalibration();
    this.screen = 'pause';
    const sectionName = this.game.practiceSectionName;
    const sectionId = this.game.practiceSectionId;
    const sectionOffset = sectionId ? (this.settings.sectionOffsets[sectionId] ?? 0) : 0;
    const sectionBpm = sectionId ? (chart.sections.find((entry) => entry.id === sectionId)?.bpm ?? 120) : 120;
    const flightHere = flightMsFor(this.settings.ringFlightMs, sectionBpm);
    this.render(`
      <section class="sheet compact">
        <div class="plate"><span class="no">V</span><span class="label">Pausa</span></div>
        <h2>${this.game.mode === 'authentic' ? 'Autentica' : `Pratica · ${sectionName ?? 'sezione'}`}<span class="thin">Esc riprende · R ricomincia</span></h2>
        <label class="field">
          <span class="top"><span class="k">Allineamento audio</span><span class="v" id="pause-sync-value">${formatClock(this.settings.audioSyncMs)}</span></span>
          <input id="pause-sync" type="range" min="0" max="240000" step="10" value="${this.settings.audioSyncMs}" />
        </label>
        <label class="field">
          <span class="top"><span class="k">Volo anello (base 120 BPM)</span><span class="v" id="flight-value">${this.settings.ringFlightMs} ms · ${flightHere} qui</span></span>
          <input id="flight" type="range" min="1200" max="2400" step="10" value="${this.settings.ringFlightMs}" />
        </label>
        ${
          sectionId
            ? `<label class="field">
          <span class="top"><span class="k">Allineamento ${sectionName ?? 'sezione'}</span><span class="v" id="pause-sec-value">${sectionOffset} ms</span></span>
          <input id="pause-sec" type="range" min="-500" max="500" step="10" value="${sectionOffset}" />
        </label>`
            : ''
        }
        <p class="note">Audio = tutto · volo = campane · sezione = solo quella sezione.</p>
        <div class="row column">
          <button class="btn primary" data-action="resume">Riprendi</button>
          <button class="btn ghost" data-action="restart">Ricomincia</button>
          <button class="btn ghost" data-action="quit">Torna al menu</button>
        </div>
      </section>
    `);
    const pauseSync = $<HTMLInputElement>(this.root, '#pause-sync');
    const pauseSyncValue = $<HTMLElement>(this.root, '#pause-sync-value');
    pauseSync.addEventListener('input', () => {
      this.settings = { ...this.settings, audioSyncMs: Number(pauseSync.value) };
      saveSettings(this.settings);
      this.game.setSettings(this.settings);
      pauseSyncValue.textContent = formatClock(this.settings.audioSyncMs);
    });
    const flight = $<HTMLInputElement>(this.root, '#flight');
    const flightValue = $<HTMLElement>(this.root, '#flight-value');
    flight.addEventListener('input', () => {
      this.settings = { ...this.settings, ringFlightMs: Number(flight.value) };
      saveSettings(this.settings);
      this.game.setSettings(this.settings);
      flightValue.textContent = `${flight.value} ms · ${flightMsFor(Number(flight.value), sectionBpm)} qui`;
    });
    const pauseSec = this.root.querySelector<HTMLInputElement>('#pause-sec');
    if (pauseSec && sectionId) {
      pauseSec.addEventListener('input', () => {
        const value = Number(pauseSec.value);
        this.settings = {
          ...this.settings,
          sectionOffsets: { ...this.settings.sectionOffsets, [sectionId]: value },
        };
        saveSettings(this.settings);
        this.game.setSettings(this.settings);
        const label = this.root.querySelector<HTMLElement>('#pause-sec-value');
        if (label) label.textContent = `${value} ms`;
      });
    }
    this.on('[data-action="resume"]', () => this.game.resume());
    this.on('[data-action="restart"]', () => this.game.restart());
    this.on('[data-action="quit"]', () => {
      this.game.quit();
      this.showTitle();
    });
  }

  showResults(result: RunResult): void {
    this.cleanupCalibration();
    this.screen = 'results';
    const title =
      result.mode === 'authentic'
        ? result.cleared
          ? 'Assalto compiuto'
          : 'Silenzio'
        : 'Sezione compiuta';
    const finale =
      result.finale === 'hit' ? 'chime preso' : result.finale === 'miss' ? 'chime mancato' : 'chime non raggiunto';
    const scope = result.mode === 'practice' ? result.section : null;
    const best = result.best ?? loadBest(result.mode, scope);
    const sectionName = chart.sections.find((entry) => entry.id === scope)?.name;
    const scopeLabel = result.mode === 'authentic' ? 'autentica' : `pratica · ${sectionName ?? 'sezione'}`;
    const intro = result.cleared
      ? result.mode === 'authentic'
        ? 'La canzone è finita.'
        : 'Sezione completata.'
      : 'Un solo errore è bastato.';

    this.render(`
      <section class="sheet">
        <div class="plate"><span class="no">VI</span><span class="label">${result.mode === 'authentic' ? 'Autentica' : 'Pratica'}</span></div>
        <div class="report">
          ${result.cleared ? '<div class="stamp">Assalto<br />compiuto</div>' : ''}
          <h2 class="${result.cleared ? 'good' : 'bad'}">${title}<span class="thin">${intro} ${finale}.</span></h2>
          <p class="big">${result.accuracy.toFixed(1)}<small>%</small></p>
          <p class="muted">${result.perfect} perfetti · ${result.good} buoni · ${result.miss} mancati su ${result.total} anelli.</p>
        </div>
        <div class="ledger">
          <div class="line"><span>Max combo</span><strong>${result.maxCombo}</strong></div>
          <div class="line"><span>Perfect</span><strong>${result.perfect}</strong></div>
          <div class="line"><span>Good</span><strong>${result.good}</strong></div>
          <div class="line"><span>Miss</span><strong>${result.miss}</strong></div>
          <div class="line"><span>Giudicati</span><strong>${result.perfect + result.good + result.miss} / ${result.total}</strong></div>
        </div>
        ${result.newBest ? '<p class="badge">◆ Nuovo record</p>' : ''}
        <p class="note">Record ${scopeLabel}: ${formatBest(best)}</p>
        <div class="row">
          <button class="btn primary" data-action="retry">Riprova</button>
          <button class="btn ghost" data-action="menu">Menu</button>
        </div>
      </section>
    `);
    this.on('[data-action="retry"]', () => {
      this.game.restart();
      this.hide();
    });
    this.on('[data-action="menu"]', () => {
      this.game.quit();
      this.showTitle();
    });
  }

  hide(): void {
    this.stopTab();
    this.cleanupEditor();
    this.cleanupCalibration();
    this.screen = 'title';
    this.root.innerHTML = '';
  }

  private startRun(mode: Mode): void {
    this.hide();
    this.game.startRun(mode);
  }

  private cleanupCalibration(): void {
    this.cleanupSync();
  }

  private render(html: string): void {
    this.menuItems = [];
    this.root.innerHTML = html;
  }

  private on(selector: string, handler: () => void): void {
    this.root.querySelector(selector)?.addEventListener('click', handler);
  }
}
