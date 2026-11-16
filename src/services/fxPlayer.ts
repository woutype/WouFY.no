import { isRunningInExpoGo } from 'expo';
import { WoufyFX } from '../../modules/woufy-fx';
import { PlayerLike, PlayerStatus } from './playerLike';

/** Доступен ли нативный модуль эффектов (реверберация, 8D). */
export const fxNativeAvailable = (): boolean => {
  try {
    return Boolean(WoufyFX && WoufyFX.isAvailable());
  } catch {
    return false;
  }
};

/** Запущено ли приложение внутри Expo Go (там нельзя подключать собственные нативные модули — это ограничение самого Expo Go) */
export const runningInExpoGo = (): boolean => {
  try {
    return typeof isRunningInExpoGo === 'function' && isRunningInExpoGo();
  } catch {
    return false;
  }
};

/** Диагностика нативного движка — отображается в настройках, чтобы было видно, что именно не так */
export const fxDiag: { loads: number; lastError?: string } = { loads: 0 };
export const fxDiagnostics = () => ({
  moduleFound: WoufyFX !== null && WoufyFX !== undefined,
  available: fxNativeAvailable(),
  expoGo: runningInExpoGo(),
  loads: fxDiag.loads,
  lastError: fxDiag.lastError,
});

type StatusCb = (s: PlayerStatus) => void;
type SampleCb = (s: { channels?: { frames: ArrayLike<number> }[] }) => void;

const registry = new Map<string, FxPlayer>();
let subscribed = false;
let nextId = 1;

export { WoufyFX };

/** Обработчик кнопок экрана блокировки / Центра управления (ставит движок) */
export const fxRemote: { handler?: (command: string, position?: number) => void } = {};

export function setRemoteHandler(handler: (command: string, position?: number) => void) {
  fxRemote.handler = handler;
  ensureSubscriptions();
}

function ensureSubscriptions() {
  if (subscribed || !WoufyFX) return;
  subscribed = true;
  WoufyFX.addListener('onEnded', ({ id }) => registry.get(id)?.handleEnded());
  WoufyFX.addListener('onSamples', ({ id, frames }) => registry.get(id)?.handleSamples(frames));
  WoufyFX.addListener('onRemote', (e) => fxRemote.handler?.(e.command, e.position));
}

/**
 * Плеер на нативном AVAudioEngine (реверберация, 8D, темп/тон без потери качества).
 * Все изменяющие вызовы выстраиваются в цепочку, поэтому replace() → seekTo() → play() выполняются строго по порядку.
 */
export class FxPlayer implements PlayerLike {
  readonly isFx = true;
  readonly isAudioSamplingSupported = true;
  muted = false;

  private id = `fx${nextId++}`;
  private chain: Promise<unknown> = Promise.resolve();
  private _duration = 0;
  private _loaded = false;
  private wantPlay = false;
  private finished = false;
  private _volume = 1;
  private rate = 1;
  private lastError: unknown;
  private statusCbs = new Set<StatusCb>();
  private sampleCbs = new Set<SampleCb>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private lockOwner = false;
  private meta: { title: string; artist: string; album: string; art: string | null } | null = null;

  constructor() {
    ensureSubscriptions();
    registry.set(this.id, this);
    WoufyFX?.create(this.id);
    // статус нужен лишь для «загрузился / доиграл / ошибка»: 4 раза в секунду достаточно (раньше 10 на каждый из двух плееров)
    this.timer = setInterval(() => this.emitStatus(), 250);
  }

  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const p = this.chain.then(fn);
    this.chain = p.catch((e) => {
      this.lastError = e;
    });
    return p;
  }

  /* ───── загрузка и управление ───── */

  replace(source: { uri: string } | null) {
    this._loaded = false;
    this._duration = 0;
    this.finished = false;
    this.lastError = undefined;
    const uri = source?.uri;
    const fx = WoufyFX;
    if (!uri || !fx) return;
    this.enqueue(async () => {
      await fx.activateSession().catch(() => {});
      const d = await fx.load(this.id, uri);
      if (!d || d <= 0) throw new Error('файл не открылся в нативном движке: ' + uri.slice(-40));
      fxDiag.loads++;
      fxDiag.lastError = undefined;
      this.lastError = undefined;
      this._duration = d;
      this._loaded = true;
      fx.setVolume(this.id, this.muted ? 0 : this._volume);
      if (this.lockOwner && this.meta) {
        fx.setNowPlaying(this.meta.title, this.meta.artist, this.meta.album, this.meta.art, d);
        this.syncNowPlaying();
      }
      this.emitStatus();
    }).catch((e) => {
      this.lastError = e;
      fxDiag.lastError = String(e);
      this.emitStatus();
    });
  }

  play() {
    this.wantPlay = true;
    this.finished = false;
    this.enqueue(async () => {
      await WoufyFX?.play(this.id);
      this.syncNowPlaying();
    }).catch(() => {});
  }

  pause() {
    this.wantPlay = false;
    this.enqueue(async () => {
      await WoufyFX?.pause(this.id);
      this.syncNowPlaying();
    }).catch(() => {});
  }

  seekTo(seconds: number): Promise<void> {
    return this.enqueue(async () => {
      await WoufyFX?.seek(this.id, Math.max(0, seconds));
      this.finished = false;
      this.syncNowPlaying();
    }).then(() => undefined);
  }

  setPlaybackRate(rate: number) {
    this.rate = rate;
    WoufyFX?.setRate(this.id, rate);
  }

  setPitchCents(cents: number) {
    WoufyFX?.setPitchCents(this.id, cents);
  }

  setReverb(amount: number) {
    WoufyFX?.setReverb(this.id, amount);
  }

  setSpatial(on: boolean) {
    WoufyFX?.setSpatial(this.id, on);
  }

  /** Включает/выключает time-pitch (нужен только для Slowed / Speed Up / подгона BPM) */
  setTempoProcessing(on: boolean) {
    try {
      WoufyFX?.setTempoProcessing?.(this.id, on);
    } catch {
      /* старая сборка модуля без этой функции */
    }
  }

  get volume() {
    return this._volume;
  }
  set volume(v: number) {
    this._volume = Math.max(0, Math.min(1, v));
    WoufyFX?.setVolume(this.id, this.muted ? 0 : this._volume);
  }

  get currentTime(): number {
    try {
      return WoufyFX ? WoufyFX.getTime(this.id) : 0;
    } catch {
      return 0;
    }
  }
  get duration() {
    return this._duration;
  }
  get isLoaded() {
    return this._loaded;
  }

  /* ───── события ───── */

  addListener(event: 'playbackStatusUpdate' | 'audioSampleUpdate', cb: any): { remove: () => void } {
    const set: Set<any> = event === 'playbackStatusUpdate' ? this.statusCbs : this.sampleCbs;
    set.add(cb);
    return { remove: () => set.delete(cb) };
  }

  setAudioSamplingEnabled(enabled: boolean) {
    WoufyFX?.setSampling(this.id, enabled);
  }

  handleEnded() {
    // устаревшее событие конца ПРЕДЫДУЩЕГО файла, пришедшее уже после replace() нового трека, — игнорируем:
    // иначе новый трек «сразу заканчивается» и движок листает очередь каскадом
    if (!this._loaded || !this.wantPlay) return;
    if (this._duration > 0 && this.currentTime < this._duration - 1.5) return;
    this.finished = true;
    this.wantPlay = false;
    this.emitStatus(true);
  }

  handleSamples(frames: number[]) {
    if (this.sampleCbs.size === 0) return;
    const payload = { channels: [{ frames }] };
    this.sampleCbs.forEach((cb) => cb(payload));
  }

  private emitStatus(didJustFinish = false) {
    if (this.statusCbs.size === 0) return;
    const s: PlayerStatus = {
      duration: this._duration,
      timeControlStatus: this.wantPlay ? 'playing' : 'paused',
      isLoaded: this._loaded,
      didJustFinish,
      isBuffering: !this._loaded && !this.lastError,
      error: this.lastError ? String(this.lastError) : undefined,
    };
    this.statusCbs.forEach((cb) => cb(s));
  }

  /* ───── экран блокировки ───── */

  setActiveForLockScreen(
    active: boolean,
    metadata?: { title?: string; artist?: string; albumTitle?: string; artworkUrl?: string }
  ) {
    if (!WoufyFX) return;
    if (!active) {
      this.lockOwner = false;
      return;
    }
    this.lockOwner = true;
    this.meta = {
      title: metadata?.title ?? '',
      artist: metadata?.artist ?? '',
      album: metadata?.albumTitle ?? '',
      art: metadata?.artworkUrl ?? null,
    };
    WoufyFX.enableRemote(true);
    WoufyFX.setNowPlaying(this.meta.title, this.meta.artist, this.meta.album, this.meta.art, this._duration);
    this.syncNowPlaying();
  }

  /** Метаданные заменяются следующим setActiveForLockScreen, поэтому здесь ничего не очищаем (без «мигания» плашки) */
  clearLockScreenControls() {
    this.lockOwner = false;
  }

  private syncNowPlaying() {
    if (!WoufyFX || !this.lockOwner) return;
    try {
      WoufyFX.updateNowPlaying(this.currentTime, this.wantPlay ? this.rate : 0);
    } catch {
      /* ignore */
    }
  }

  remove() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    registry.delete(this.id);
    this.statusCbs.clear();
    this.sampleCbs.clear();
    try {
      WoufyFX?.destroy(this.id);
    } catch {
      /* ignore */
    }
    if (registry.size === 0 && WoufyFX) {
      try {
        WoufyFX.enableRemote(false);
        WoufyFX.clearNowPlaying();
      } catch {
        /* ignore */
      }
    }
  }
}

export const createFxPlayer = (): PlayerLike => new FxPlayer();
