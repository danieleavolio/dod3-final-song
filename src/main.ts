import './styles.css';
import circleUrl from './assets/circle.wav?url';
import clickUrl from './assets/click.wav?url';
import { Game } from './game/game';
import { loadSettings } from './game/settings';
import { loadAudioFile } from './game/storage';
import { UI } from './ui/ui';

const canvas = document.querySelector<HTMLCanvasElement>('#stage');
const overlay = document.querySelector<HTMLDivElement>('#overlay');
if (!canvas || !overlay) {
  throw new Error('Elementi DOM mancanti');
}

const settings = loadSettings();
const game = new Game(canvas, settings);
void game.audio.loadDefaultSamples(circleUrl, clickUrl);
const ui = new UI(overlay, game, settings);

async function boot(): Promise<void> {
  const stored = await loadAudioFile();
  if (stored) {
    try {
      await game.loadAudio(stored);
      ui.setRestoredAudio(stored.name);
      ui.migrateChart();
      window.setTimeout(() => ui.checkAlignment(), 800);
    } catch {
      // file non decodificabile: si riparte dal caricamento manuale
    }
  }
  if (game.audio.hasFile) ui.showTitle();
  else if (ui.shouldShowSongPrompt()) ui.showSongPrompt();
  else ui.showTitle();
}

void boot();

// Hook di debug per i test automatici (stato del gioco a sola lettura).
(window as unknown as { __dod3?: Game }).__dod3 = game;
