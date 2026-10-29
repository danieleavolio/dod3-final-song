const HIT_KEYS = new Set(['Space', 'Enter', 'NumpadEnter', 'KeyX', 'KeyC', 'KeyV', 'KeyB']);

/**
 * Un solo gesto di "colpisci": qualsiasi tasto tra quelli mappati o qualsiasi
 * pulsante del gamepad (il boss originale accetta quasi tutti i tasti).
 */
export class InputManager {
  onHit: (() => void) | null = null;
  private previousPadButtons: boolean[][] = [];
  private attached = false;

  attach(): void {
    if (this.attached) return;
    window.addEventListener('keydown', this.onKeyDown);
    this.attached = true;
  }

  detach(): void {
    window.removeEventListener('keydown', this.onKeyDown);
    this.attached = false;
  }

  private onKeyDown = (event: KeyboardEvent): void => {
    if (event.repeat || event.ctrlKey || event.metaKey || event.altKey) return;
    if (!HIT_KEYS.has(event.code)) return;
    if (event.code === 'Space') event.preventDefault();
    this.onHit?.();
  };

  pollGamepad(): void {
    const pads = navigator.getGamepads?.() ?? [];
    for (let p = 0; p < pads.length; p += 1) {
      const pad = pads[p];
      if (!pad) {
        this.previousPadButtons[p] = [];
        continue;
      }
      const previous = this.previousPadButtons[p] ?? [];
      for (let b = 0; b < pad.buttons.length; b += 1) {
        const pressed = pad.buttons[b]?.pressed ?? false;
        if (pressed && !previous[b]) this.onHit?.();
      }
      this.previousPadButtons[p] = pad.buttons.map((button) => button.pressed);
    }
  }

  get gamepadName(): string | null {
    const pads = navigator.getGamepads?.() ?? [];
    for (const pad of pads) {
      if (pad) return pad.id;
    }
    return null;
  }
}
