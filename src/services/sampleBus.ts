import type { PlayerLike } from './playerLike';

/**
 * Общая шина аудио-семплов. Визуализатор и тактильный отклик читают семплы одного и того же плеера;
 * семплирование включается, пока есть хотя бы один потребитель, и следует за «главным» плеером (при склейке он меняется).
 */
export type SampleListener = (frames: ArrayLike<number>) => void;

class SampleBus {
  private player: PlayerLike | null = null;
  private sub: { remove: () => void } | null = null;
  private listeners = new Set<SampleListener>();
  private retry: ReturnType<typeof setInterval> | null = null;
  private refreshTimer: ReturnType<typeof setTimeout> | null = null;

  setPlayer(p: PlayerLike | null) {
    if (p === this.player) return;
    this.detach();
    this.player = p;
    if (this.listeners.size > 0) this.attach();
  }

  subscribe(fn: SampleListener): () => void {
    this.listeners.add(fn);
    if (this.listeners.size === 1) this.attach();
    return () => {
      this.listeners.delete(fn);
      if (this.listeners.size === 0) this.detach();
    };
  }

  /**
   * У expo-audio семплирование привязано к ТЕКУЩЕМУ треку плеера: после replace() оно слетает.
   * Поэтому подписка переустанавливается при смене трека (refresh) и подстраховывается повторными попытками.
   */
  private attach() {
    const p = this.player;
    if (!p || this.sub) return;
    try {
      this.sub = p.addListener('audioSampleUpdate', (s) => {
        const frames = s.channels?.[0]?.frames;
        if (!frames || frames.length === 0) return;
        this.lastEventAt = Date.now();
        this.listeners.forEach((l) => l(frames));
      });
      p.setAudioSamplingEnabled(true);
    } catch {
      /* семплирование недоступно */
    }
    if (!this.retry) {
      this.lastEventAt = Date.now();
      this.retry = setInterval(() => {
        // нет семплов дольше 1.5 с, хотя слушатели есть — перезапускаем семплирование
        if (this.listeners.size > 0 && this.player && Date.now() - this.lastEventAt > 1500) {
          this.lastEventAt = Date.now();
          try {
            this.player.setAudioSamplingEnabled(false);
            this.player.setAudioSamplingEnabled(true);
          } catch {
            /* ignore */
          }
        }
      }, 1000);
    }
  }

  private lastEventAt = 0;

  private detach() {
    if (this.retry) clearInterval(this.retry);
    this.retry = null;
    try {
      this.sub?.remove();
      this.player?.setAudioSamplingEnabled(false);
    } catch {
      /* ignore */
    }
    this.sub = null;
  }

  /** Вызывать при смене трека / начале воспроизведения: переустанавливает семплирование на новом элементе плеера */
  refresh() {
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    const run = () => {
      if (this.listeners.size === 0 || !this.player) return;
      try {
        this.player.setAudioSamplingEnabled(false);
        this.player.setAudioSamplingEnabled(true);
      } catch {
        /* ignore */
      }
    };
    run();
    this.refreshTimer = setTimeout(run, 450); // трек ещё грузится — повторяем, когда элемент готов
  }
}

export const sampleBus = new SampleBus();
