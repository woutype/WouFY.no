import { createAudioPlayer } from 'expo-audio';
import { DJSettings, DEFAULT_DJ, DEFAULT_FX, FxSettings, RepeatMode, SLOWED_RATE, SPEEDUP_RATE, TrackFile } from '../types';
import { planMix, ratesAt, volumesAt, beatPhase, wrapHalf, MixPlan, TrackTempo, BeatGrid } from './djMix';
import { configureAudioSession } from './audioService';
import { volumeService } from './volumeService';
import type { PlayerLike, PlayerStatus } from './playerLike';
import { createFxPlayer, fxNativeAvailable, fxRemote } from './fxPlayer';

type AudioPlayer = PlayerLike;
type AudioStatus = PlayerStatus;

export interface EngineState {
  queue: TrackFile[];
  /** индекс «текущего» трека в очереди (переключается на середине DJ-склейки) */
  index: number;
  isPlaying: boolean;
  duration: number;
  volume: number;
  shuffle: boolean;
  repeat: RepeatMode;
  /** идёт DJ-склейка */
  mixing: boolean;
  /** плеер, который сейчас «владеет» UI (для визуализатора) */
  player: AudioPlayer | null;
}

interface Transition {
  from: AudioPlayer;
  to: AudioPlayer;
  toId: string;
  plan: MixPlan;
  /** длительность склейки, мс: ровно столько, чтобы A закончился в конце перехода */
  durationMs: number;
  /** сколько склейки уже прошло (только пока играет — на паузе не копится) */
  elapsedMs: number;
  lastTickAt: number;
  uiSwitched: boolean;
  lastRateA: number;
  lastRateB: number;
  lastRateAt: number;
  /** сглаженная поправка скорости B от фазовой автоподстройки (PLL) */
  corr: number;
  lastVolA: number;
  lastVolB: number;
  /** запасной режим: сколько фазовых перемоток B уже сделано (≤2) и когда была последняя */
  phaseFixes: number;
  lastPhaseFixAt: number;
  /** запасной режим: 0 — темп не менялся, 1 — сменён у A, 2 — сменён и у B */
  swapStage: 0 | 1 | 2;
  swapAt: number;
}

/** Подготовка трека B: загружен и стоит на своём бите, ждёт момента старта */
interface Prep {
  id: string;
  startPos: number;
  ready: boolean;
  seeking: boolean;
  attempts: number;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
/**
 * Тик основного таймера DJ-движка.
 * 40 мс = 25 Гц обновлений громкости — идеально плавный fade без лишней нагрузки на bridge.
 */
const TICK_MS = 40;
/**
 * Два режима подгона темпа при склейке:
 *  • нативный движок (AVAudioEngine, FxPlayer): темп меняется непрерывно и бесшовно (шаг 45 мс) + фазовая автоподстройка (PLL);
 *  • запасной режим (AVPlayer из expo-audio, например в Expo Go): у AVPlayer КАЖДАЯ смена скорости даёт цифровой провал ≈100 мс
 *    (его видно в записи звука). Поэтому здесь скорость меняется всего один раз на плеер: B стартует уже в темпе A (пока он не слышен),
 *    на середине склейки, когда оба трека звучат, A переходит к темпу B, а через ~170 мс B — к своему родному; фаза B подгоняется
 *    одной перемоткой, пока B почти не слышен. Провал в одном треке перекрывается вторым.
 */
const FX_RATE_STEP_MS = 45;
const FX_RATE_EPS = 0.0008;
/** Момент ступенчатой смены темпа в запасном режиме (доля длительности склейки) */
const STEP_SWAP_P = 0.5;
/** Пауза между сменой темпа A и B в запасном режиме, мс */
const STEP_GAP_MS = 170;
/** Качество коррекции высоты тона: «high» — спектральный алгоритм, без «рваного» звука на музыке */
const PITCH_Q = 'high' as const;
/** Опережение старта B, сек (задержка команды play) */
const START_LEAD_SEC = 0.05;
/** Усиление и предел фазовой автоподстройки B к битам A (нативный движок) */
const PLL_GAIN = 0.35;
const PLL_MAX = 0.02;
/** За сколько секунд до конца трека начинаем предзагрузку следующего (буферизация). */
const PRELOAD_AHEAD_SEC = 30;

function safe<T>(fn: () => T): T | undefined {
  try {
    return fn();
  } catch (e) {
    console.warn('[engine]', e);
    return undefined;
  }
}

/**
 * Аудио-движок: два плеера (A/B) для настоящей DJ-склейки, очередь, shuffle/repeat.
 * Вне React: UI подписывается через subscribe/getState.
 */
export interface FxDerived {
  speed: number;
  cents: number;
  reverb: number;
  spatial: boolean;
  tape: boolean;
}

export function deriveFx(fx: FxSettings): FxDerived {
  if (!fx.enabled) return { speed: 1, cents: 0, reverb: 0, spatial: false, tape: false };
  const slowed = fx.slowed && !fx.speedUp;
  const speed = fx.speedUp ? SPEEDUP_RATE : slowed ? SLOWED_RATE : 1;
  // 8D всегда идёт с небольшой реверберацией (эхо зала), как в классических 8D-треках
  const reverb = Math.max(fx.reverb ? fx.reverbAmount : 0, slowed && fx.slowedReverb ? fx.slowedReverbAmount : 0, fx.spatial8d ? 22 : 0);
  return {
    speed,
    cents: speed !== 1 ? 1200 * Math.log2(speed) : 0,
    reverb,
    spatial: fx.spatial8d,
    tape: speed !== 1,
  };
}

/**
 * Аудио-движок: два плеера (A/B) для настоящей DJ-склейки, очередь, shuffle/repeat, звуковые эффекты.
 * Вне React: UI подписывается через subscribe/getState.
 */
export class AudioEngine {
  private players: AudioPlayer[];
  private mode: 'native' | 'fx' = 'native';
  private fx: FxSettings = DEFAULT_FX;
  private fxd: FxDerived = deriveFx(DEFAULT_FX);
  private active = 0;
  private listeners = new Set<() => void>();
  private state: EngineState;
  private library: TrackFile[] = [];
  private baseOrder: string[] = [];
  private dj: DJSettings = DEFAULT_DJ;
  private trans: Transition | null = null;
  private prep: Prep | null = null;
  private mixBlockedFor: string | null = null;
  private playIntent = false;
  private playToken = 0;
  private busy = false;
  private lastCommandAt = 0;
  private errorSkips = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private subs: { remove: () => void }[] = [];
  private bpmLookup: (t: TrackFile) => number | undefined = () => undefined;
  private gridLookup: (t: TrackFile) => BeatGrid | undefined = () => undefined;
  private onMixingChange: (mixing: boolean) => void = () => {};
  private onTrackChange: (cur: TrackFile | undefined, upcoming: (TrackFile | undefined)[]) => void = () => {};
  private onPersist: (s: { order: string[]; shuffle: boolean; repeat: RepeatMode; volume: number; lastTrackId?: string }) => void =
    () => {};
  private lastUserVolumeChangeAt = 0;

  constructor() {
    configureAudioSession(true);
    this.players = this.makePlayers('native');
    this.state = {
      queue: [],
      index: -1,
      isPlaying: false,
      duration: 0,
      volume: 1,
      shuffle: false,
      repeat: 'off',
      mixing: false,
      player: this.players[0],
    };
    this.attachPlayers();
    this.timer = setInterval(this.tick, TICK_MS);

    fxRemote.handler = (cmd, pos) => this.handleRemote(cmd, pos);

    // Синхронизация с физической громкостью телефона (кнопки iPhone и Центр управления)
    volumeService.addListener((vol) => {
      if (Date.now() - this.lastUserVolumeChangeAt < 400) return;
      if (Math.abs(this.state.volume - vol) >= 0.005) {
        this.set({ volume: vol });
        this.persist();
      }
    });
  }

  /* ───────────── игроки и режимы ───────────── */

  private makePlayers(mode: 'native' | 'fx'): AudioPlayer[] {
    if (mode === 'fx') return [createFxPlayer(), createFxPlayer()];
    return [0, 1].map(
      () => createAudioPlayer(null, { updateInterval: 100, keepAudioSessionActive: true }) as unknown as AudioPlayer
    );
  }

  private attachPlayers() {
    this.subs.forEach((s) => safe(() => s.remove()));
    this.subs = [];
    this.players.forEach((p) => {
      this.subs.push(p.addListener('playbackStatusUpdate', (s: AudioStatus) => this.onStatus(p, s)));
    });
  }

  private handleRemote(cmd: string, pos?: number) {
    if (cmd === 'play') {
      if (!this.playIntent) this.togglePlay();
    } else if (cmd === 'pause') {
      if (this.playIntent) this.togglePlay();
    } else if (cmd === 'toggle') this.togglePlay();
    else if (cmd === 'next') this.next();
    else if (cmd === 'previous') this.previous();
    else if (cmd === 'seek' && pos !== undefined) this.seek(pos);
  }

  /** Возвращает true, если для реверберации/8D доступен нативный модуль */
  get fxNativeReady() {
    return fxNativeAvailable();
  }

  private applyFx(p: AudioPlayer) {
    const f = this.fxd;
    safe(() => {
      p.setReverb?.(f.reverb);
      p.setSpatial?.(f.spatial);
      p.setPitchCents?.(f.cents);
      // Без нативного движка: Slowed / Speed Up работают «по-кассетному» (темп и тон вместе — так и задумано);
      // подгон BPM при склейке — с сохранением высоты тона (темп меняется всего 1–2 раза, см. STEP_SWAP_P), тон не «прыгает».
      if (!p.isFx) p.shouldCorrectPitch = !f.tape;
    });
  }

  /** Кэш последней выставленной скорости: повторная установка того же значения у AVPlayer = лишний провал звука */
  private rateCache = new WeakMap<object, number>();

  /** Загрузка файла в плеер: заодно сбрасывает кэш скорости (у нового трека скорость выставляется заново) */
  private load(p: AudioPlayer, uri: string) {
    this.rateCache.delete(p);
    p.replace({ uri });
  }

  /** Скорость плеера = скорость склейки (подгон BPM) × скорость эффекта (Slowed / Speed Up) */
  private setRate(p: AudioPlayer, djRate: number) {
    const r = clamp(djRate * this.fxd.speed, 0.25, 2);
    const prev = this.rateCache.get(p);
    if (prev !== undefined && Math.abs(prev - r) < 1e-4) return;
    this.rateCache.set(p, r);
    if (!p.isFx && this.fxd.tape) safe(() => p.setPlaybackRate(r));
    else safe(() => p.setPlaybackRate(r, PITCH_Q));
  }

  setFx(fx: FxSettings) {
    this.fx = fx;
    this.fxd = deriveFx(fx);
    this.updateMode();
  }

  /**
   * Нативный движок (AVAudioEngine) нужен для реверберации/8D и для DJ-подгона BPM:
   * его time-pitch меняет темп плавно, без «рваного» звука, который даёт AVPlayer при частой смене скорости.
   */
  private updateMode() {
    const needFx = this.fxd.reverb > 0 || this.fxd.spatial || (this.dj.crossfadeEnabled && this.dj.bpmTransitionEnabled);
    const want: 'native' | 'fx' = needFx && fxNativeAvailable() ? 'fx' : 'native';
    if (want !== this.mode) {
      this.switchMode(want);
    } else {
      this.players.forEach((p) => this.applyFx(p));
      if (!this.trans) {
        this.setRate(this.A, 1);
        this.setRate(this.B, 1);
      }
    }
    this.prep = null;
  }

  /** Активен ли нативный движок (для диагностики в настройках) */
  get fxActive() {
    return this.mode === 'fx';
  }

  /** Переключает «обычные» плееры ↔ плееры эффектов, сохраняя трек, позицию и состояние воспроизведения */
  private switchMode(mode: 'native' | 'fx') {
    if (mode === this.mode) return;
    const cur = this.currentTrack;
    const pos = this.getPosition();
    const was = this.playIntent;
    if (this.trans) this.cancelTransition();

    this.subs.forEach((s) => safe(() => s.remove()));
    this.subs = [];
    this.players.forEach((p) =>
      safe(() => {
        p.pause();
        p.clearLockScreenControls();
        p.remove();
      })
    );
    this.mode = mode;
    this.players = this.makePlayers(mode);
    this.active = 0;
    this.prep = null;
    this.attachPlayers();
    this.players.forEach((p) => this.applyFx(p));
    this.set({ player: this.players[0] });

    if (cur) {
      const a = this.A;
      const token = ++this.playToken;
      safe(() => {
        this.load(a, cur.uri);
        a.volume = this.master();
        a.muted = false;
      });
      this.setRate(a, 1);
      if (pos > 0.5) safe(() => a.seekTo(pos));
      this.updateLockScreen(a, cur);
      if (was) {
        configureAudioSession(true).then(() => {
          if (token === this.playToken && this.playIntent) safe(() => a.play());
        });
      }
    }
  }

  /** Повторно активирует аудио-сессию (при возврате в приложение) */
  resyncSession() {
    configureAudioSession(true);
    const t = this.currentTrack;
    if (t) this.updateLockScreen(this.uiPlayer(), t);
  }

  /** Обновляет данные треков (теги, обложки дочитываются в фоне) без сброса очереди и воспроизведения */
  patchTracks(updated: TrackFile[]) {
    if (updated.length === 0) return;
    const map = new Map(updated.map((t) => [t.id, t]));
    this.library = this.library.map((t) => map.get(t.id) ?? t);
    const queue = this.state.queue.map((t) => map.get(t.id) ?? t);
    this.state = { ...this.state, queue };
    this.listeners.forEach((l) => l());
    const cur = this.currentTrack;
    if (cur && map.has(cur.id)) this.updateLockScreen(this.uiPlayer(), cur);
  }

  /* ───────────── подписка ───────────── */

  subscribe = (l: () => void) => {
    this.listeners.add(l);
    return () => {
      this.listeners.delete(l);
    };
  };
  getState = () => this.state;

  private set(patch: Partial<EngineState>) {
    this.state = { ...this.state, ...patch };
    this.listeners.forEach((l) => l());
  }

  configure(opts: {
    bpmLookup?: (t: TrackFile) => number | undefined;
    gridLookup?: (t: TrackFile) => BeatGrid | undefined;
    onMixingChange?: (mixing: boolean) => void;
    onTrackChange?: (cur: TrackFile | undefined, upcoming: (TrackFile | undefined)[]) => void;
    onPersist?: (s: { order: string[]; shuffle: boolean; repeat: RepeatMode; volume: number; lastTrackId?: string }) => void;
  }) {
    if (opts.bpmLookup) this.bpmLookup = opts.bpmLookup;
    if (opts.gridLookup) this.gridLookup = opts.gridLookup;
    if (opts.onMixingChange) this.onMixingChange = opts.onMixingChange;
    if (opts.onTrackChange) this.onTrackChange = opts.onTrackChange;
    if (opts.onPersist) this.onPersist = opts.onPersist;
  }

  setDJ(dj: DJSettings) {
    this.dj = dj;
    if (!dj.crossfadeEnabled && this.trans) this.cancelTransition();
    this.prep = null;
    this.mixBlockedFor = null;
    this.updateMode();
  }

  /* ───────────── геттеры для UI ───────────── */

  private get A() {
    return this.players[this.active];
  }
  private get B() {
    return this.players[1 - this.active];
  }
  /** плеер, чей трек сейчас показан в UI */
  private uiPlayer(): AudioPlayer {
    return this.trans?.uiSwitched ? this.trans.to : this.A;
  }
  get currentTrack(): TrackFile | undefined {
    return this.state.queue[this.state.index];
  }
  getPosition(): number {
    return safe(() => this.uiPlayer().currentTime) ?? 0;
  }
  getDuration(): number {
    return safe(() => this.uiPlayer().duration) ?? 0;
  }

  /* ───────────── библиотека и очередь ───────────── */

  setLibrary(tracks: TrackFile[], savedOrder?: string[], savedLastId?: string) {
    const prevCurrentId = this.currentTrack?.id;
    this.library = tracks;
    const byId = new Map(tracks.map((t) => [t.id, t]));

    const ordered: string[] = [];
    const seen = new Set<string>();
    for (const id of savedOrder ?? this.baseOrder) {
      if (byId.has(id) && !seen.has(id)) {
        ordered.push(id);
        seen.add(id);
      }
    }
    for (const t of tracks) if (!seen.has(t.id)) ordered.push(t.id);
    this.baseOrder = ordered;

    let queueIds: string[];
    if (this.state.shuffle && this.state.queue.length > 0) {
      const inQueue = new Set<string>();
      queueIds = [];
      for (const t of this.state.queue) {
        if (byId.has(t.id)) {
          queueIds.push(t.id);
          inQueue.add(t.id);
        }
      }
      for (const id of ordered) if (!inQueue.has(id)) queueIds.push(id);
    } else {
      queueIds = ordered;
    }
    const queue = queueIds.map((id) => byId.get(id)!);

    const wantedId = prevCurrentId ?? savedLastId;
    let index = wantedId ? queue.findIndex((t) => t.id === wantedId) : -1;
    if (index < 0 && queue.length > 0 && !this.playIntent) index = 0;

    const changed = queue[index]?.id !== prevCurrentId;
    this.set({ queue, index });
    if (changed && index >= 0) this.prepare(index);
    else this.notifyTrackChange();
  }

  /** Загружает трек в активный плеер без запуска (после старта приложения) */
  private prepare(index: number) {
    const t = this.state.queue[index];
    if (!t) return;
    safe(() => {
      this.load(this.A, t.uri);
      this.A.volume = 1;
    });
    this.applyFx(this.A);
    this.updateLockScreen(this.A, t);
    this.notifyTrackChange();
  }

  private upcoming(): (TrackFile | undefined)[] {
    const { queue, index } = this.state;
    const n = queue.length;
    if (n === 0 || index < 0) return [];
    return [queue[(index + 1) % n], queue[(index + 2) % n]];
  }

  private notifyTrackChange() {
    this.onTrackChange(this.currentTrack, this.upcoming());
    this.persist();
  }

  private persist() {
    this.onPersist({
      order: this.baseOrder,
      shuffle: this.state.shuffle,
      repeat: this.state.repeat,
      volume: this.state.volume,
      lastTrackId: this.currentTrack?.id,
    });
  }

  /** Исходный порядок библиотеки (для сброса сортировки) */
  libraryOrder(): TrackFile[] {
    return [...this.library];
  }

  moveQueueItem(from: number, to: number) {
    const q = [...this.state.queue];
    if (from < 0 || from >= q.length || to < 0 || to >= q.length || from === to) return;
    const [item] = q.splice(from, 1);
    q.splice(to, 0, item);
    let index = this.state.index;
    if (from === index) index = to;
    else if (from < index && to >= index) index -= 1;
    else if (from > index && to <= index) index += 1;
    if (!this.state.shuffle) this.baseOrder = q.map((t) => t.id);
    this.prep = null;
    this.set({ queue: q, index });
    setTimeout(() => this.persist(), 50);
    this.onTrackChange(this.currentTrack, this.upcoming());
  }

  reorderQueue(newQueue: TrackFile[]) {
    const cur = this.currentTrack;
    const index = cur ? newQueue.findIndex((t) => t.id === cur.id) : -1;
    if (!this.state.shuffle) this.baseOrder = newQueue.map((t) => t.id);
    this.prep = null;
    this.set({ queue: newQueue, index });
    setTimeout(() => this.persist(), 50);
    this.onTrackChange(this.currentTrack, this.upcoming());
  }

  setShuffle(on: boolean) {
    if (on === this.state.shuffle) return;
    const cur = this.currentTrack;
    if (on) {
      const rest = this.state.queue.filter((t) => t.id !== cur?.id);
      for (let i = rest.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [rest[i], rest[j]] = [rest[j], rest[i]];
      }
      const queue = cur ? [cur, ...rest] : rest;
      this.set({ shuffle: true, queue, index: cur ? 0 : -1 });
    } else {
      const byId = new Map(this.library.map((t) => [t.id, t]));
      const queue = this.baseOrder.map((id) => byId.get(id)).filter(Boolean) as TrackFile[];
      const index = cur ? queue.findIndex((t) => t.id === cur.id) : -1;
      this.set({ shuffle: false, queue, index });
    }
    this.prep = null;
    this.persist();
    this.onTrackChange(this.currentTrack, this.upcoming());
  }

  setRepeat(mode: RepeatMode) {
    this.set({ repeat: mode });
    this.persist();
  }

  /** Множитель громкости плееров: при системной громкости плееры играют на 100% (громкость задаёт сам телефон) */
  private master(): number {
    return volumeService.isAvailable() ? 1 : this.state.volume;
  }

  /**
   * syncToDevice=true — значение пришло из приложения (слайдер): пишем в системную громкость.
   * syncToDevice=false — значение прочитано с устройства: только обновляем слайдер.
   */
  setVolume(v: number, syncToDevice = true) {
    const volume = clamp(v, 0, 1);
    if (syncToDevice) this.lastUserVolumeChangeAt = Date.now();
    this.set({ volume });
    if (syncToDevice) volumeService.setVolume(volume);
    if (!volumeService.isAvailable() && !this.trans) {
      safe(() => {
        this.A.volume = volume;
      });
    }
    this.persist();
  }

  /* ───────────── управление воспроизведением ───────────── */

  playTrack(trackOrId: TrackFile | string) {
    const id = typeof trackOrId === 'string' ? trackOrId : trackOrId.id;
    const idx = this.state.queue.findIndex((t) => t.id === id);
    if (idx >= 0) this.playIndex(idx);
  }

  playIndex(index: number) {
    const t = this.state.queue[index];
    if (!t) return;
    if (this.trans) this.cancelTransition();
    this.mixBlockedFor = null;
    this.errorSkips = 0;
    this.playIntent = true;
    this.lastCommandAt = Date.now();
    const token = ++this.playToken;
    const a = this.A;
    safe(() => {
      this.B.pause();
      this.load(a, t.uri);
      a.volume = Math.max(0.05, this.master());
      a.muted = false;
    });
    this.applyFx(a);
    this.setRate(a, 1);
    // ВАЖНО: play() только после того, как аудио-сессия (doNotMix) реально активирована — иначе при первом запуске
    // iOS мог оставить сессию в другом режиме и трек «играл» без звука
    configureAudioSession(true).then(() => {
      if (token === this.playToken && this.playIntent) safe(() => a.play());
    });
    this.prep = null;
    this.set({ index, isPlaying: true, duration: 0, player: a, mixing: false });
    this.updateLockScreen(a, t);
    this.notifyTrackChange();
  }

  togglePlay() {
    if (this.state.index < 0) {
      if (this.state.queue.length > 0) this.playIndex(0);
      return;
    }
    this.lastCommandAt = Date.now();
    if (this.playIntent) {
      this.playIntent = false;
      this.playToken++;
      safe(() => {
        this.A.pause();
        if (this.trans) this.trans.to.pause();
      });
      this.set({ isPlaying: false });
    } else {
      this.playIntent = true;
      const token = ++this.playToken;
      const a = this.A;
      const to = this.trans?.to;
      configureAudioSession(true).then(() => {
        if (token !== this.playToken || !this.playIntent) return;
        safe(() => {
          a.muted = false;
          a.play();
          to?.play();
        });
      });
      this.set({ isPlaying: true });
    }
  }

  next() {
    const n = this.state.queue.length;
    if (n === 0) return;
    if (this.trans) {
      const wasSwitched = this.trans.uiSwitched;
      this.commitTransition();
      if (!wasSwitched) return; // «следующий» — это уже тот, в который шла склейка
    }
    this.playIndex((this.state.index + 1) % n);
  }

  previous() {
    const n = this.state.queue.length;
    if (n === 0) return;
    if (this.trans) {
      if (this.trans.uiSwitched) this.commitTransition();
      else this.cancelTransition();
    }
    if (this.getPosition() > 3) {
      this.seek(0);
      if (!this.playIntent) this.togglePlay();
      return;
    }
    this.playIndex((this.state.index - 1 + n) % n);
  }

  seek(seconds: number) {
    if (this.trans) {
      if (this.trans.uiSwitched) this.commitTransition();
      else this.cancelTransition();
    }
    this.mixBlockedFor = null;
    safe(() => this.A.seekTo(Math.max(0, seconds)));
  }

  /* ───────────── обработка событий плеера ───────────── */

  private onStatus(player: AudioPlayer, s: AudioStatus) {
    if (player !== this.uiPlayer()) {
      // конец трека A во время склейки обрабатывается в tick()
      return;
    }
    const patch: Partial<EngineState> = {};
    if (s.duration > 0 && s.duration !== this.state.duration) patch.duration = s.duration;

    // Синхронизация с внешними событиями (звонок, наушники, экран блокировки)
    const settled = Date.now() - this.lastCommandAt > 800;
    if (settled && !this.trans) {
      if (s.timeControlStatus === 'paused' && this.playIntent && s.isLoaded && !s.didJustFinish && !s.isBuffering) {
        this.playIntent = false;
        patch.isPlaying = false;
      } else if (s.timeControlStatus === 'playing' && !this.playIntent) {
        this.playIntent = true;
        patch.isPlaying = true;
      }
    }
    if (Object.keys(patch).length) this.set(patch);

    if (s.error && this.playIntent) {
      if (this.errorSkips < 3 && this.state.queue.length > 1) {
        this.errorSkips++;
        this.playIndex((this.state.index + 1) % this.state.queue.length);
      } else {
        this.playIntent = false;
        this.set({ isPlaying: false });
      }
      return;
    }

    if (s.didJustFinish && !this.trans) this.onEnded();
  }

  private nextIndexAuto(): number | null {
    const { queue, index, repeat } = this.state;
    if (queue.length === 0 || index < 0) return null;
    if (repeat === 'one') return index;
    if (index + 1 < queue.length) return index + 1;
    return repeat === 'all' ? 0 : null;
  }

  private onEnded() {
    this.errorSkips = 0;
    const { repeat } = this.state;
    if (repeat === 'one') {
      safe(() => {
        this.A.seekTo(0);
        this.A.play();
      });
      return;
    }
    const n = this.nextIndexAuto();
    if (n === null) {
      this.playIntent = false;
      safe(() => {
        this.A.pause();
        this.A.seekTo(0);
      });
      this.set({ isPlaying: false });
    } else {
      this.playIndex(n);
    }
  }

  /* ───────────── DJ-склейка ───────────── */

  private tempoOf(t: TrackFile): TrackTempo {
    return { bpm: this.bpmLookup(t), grid: this.gridLookup(t) };
  }

  /**
   * Где стартует склейка. A должен закончиться ровно в конце перехода, поэтому старт — за (X · средняя скорость A)
   * секунд до конца. Если известна сетка битов — сдвигаем старт на ближайший бит A назад
   * (лучше на начало такта, если это не раньше чем на ~30% длительности), чтобы B вошёл «в долю».
   */
  private pickStart(plan: MixPlan, dur: number, pos: number, X: number): { sA: number; durationMs: number } | null {
    const avg = (plan.tempo ? plan.avgRateA : 1) * this.fxd.speed;
    const ideal = dur - X * avg;
    let sA = ideal;
    if (plan.beatSync) {
      const { periodA: pA, phaseA: phA } = plan;
      const kIdeal = Math.floor((ideal - phA) / pA + 1e-6);
      const barK = kIdeal - (((kIdeal % 4) + 4) % 4);
      const barT = phA + barK * pA;
      sA = ideal - barT <= 0.3 * X * avg ? barT : phA + kIdeal * pA;
      while (sA < pos - 0.04) sA += pA; // уже проскочили — берём следующий бит
    } else if (sA < pos) {
      sA = pos;
    }
    if (sA > dur - 0.4) return null;
    const durationMs = ((dur - sA) / avg) * 1000;
    if (durationMs < X * 1000 * 0.45) return null;
    return { sA, durationMs: Math.min(durationMs, X * 1000 * 1.5) };
  }

  /** Загружает трек B заранее и ставит его на «свой» бит — к старту остаётся только play() */
  private ensurePrepared(nxt: TrackFile, plan: MixPlan) {
    const idle = this.B;
    const startPos = plan.beatSync ? plan.bStartPos : 0;
    if (!this.prep || this.prep.id !== nxt.id) {
      safe(() => {
        idle.pause();
        this.load(idle, nxt.uri);
        idle.volume = 0;
      });
      this.applyFx(idle);
      this.setRate(idle, 1);
      this.prep = { id: nxt.id, startPos, ready: false, seeking: false, attempts: 0 };
    }
    const prep = this.prep;
    if (!prep.seeking && Math.abs(prep.startPos - startPos) > 0.03) {
      prep.startPos = startPos;
      prep.ready = false;
      prep.attempts = 0;
    }
    if (prep.ready || prep.seeking) return;
    if (!(safe(() => idle.isLoaded) ?? false)) return;
    const cur = safe(() => idle.currentTime) ?? 0;
    if (Math.abs(cur - prep.startPos) < 0.05 || prep.attempts >= 3) {
      prep.ready = true;
      return;
    }
    prep.seeking = true;
    prep.attempts++;
    const target = prep.startPos;
    Promise.resolve(safe(() => idle.seekTo(target)))
      .catch(() => {})
      .finally(() => {
        if (this.prep !== prep) return;
        prep.seeking = false;
        prep.ready = Math.abs(prep.startPos - target) < 0.03 && (Math.abs((safe(() => idle.currentTime) ?? 0) - target) < 0.08 || prep.attempts >= 3);
      });
  }

  private setBusy(b: boolean) {
    if (b === this.busy) return;
    this.busy = b;
    this.onMixingChange(b);
  }

  private tick = () => {
    if (!this.playIntent) return;
    const a = this.A;
    const pos = safe(() => a.currentTime) ?? 0;
    const dur = safe(() => a.duration) ?? 0;
    if (dur <= 0) return;

    if (this.trans) {
      this.setBusy(true);
      this.driveTransition(pos, dur);
      return;
    }

    const X = this.dj.crossfadeDuration;
    // фоновый анализ BPM не мешает только вдали от склейки: перед ней и во время неё он приостанавливается
    this.setBusy(this.dj.crossfadeEnabled && dur - pos <= PRELOAD_AHEAD_SEC + X * 1.5 + 10);
    if (!this.dj.crossfadeEnabled || this.state.repeat === 'one' || !this.currentTrack) return;
    if (this.mixBlockedFor === this.currentTrack.id) return;
    const nextIdx = this.nextIndexAuto();
    if (nextIdx === null || nextIdx === this.state.index) return;
    if (dur < X + 2) return;

    const cur = this.currentTrack;
    const nxt = this.state.queue[nextIdx];
    const plan = planMix(this.tempoOf(cur), this.tempoOf(nxt), this.dj.bpmTransitionEnabled);
    const remaining = dur - pos;
    const avg = (plan.tempo ? plan.avgRateA : 1) * this.fxd.speed;

    // Ранняя предзагрузка: декодирование и установка на бит завершаются задолго до склейки
    if (remaining <= PRELOAD_AHEAD_SEC + X * avg) this.ensurePrepared(nxt, plan);
    else return;

    const start = this.pickStart(plan, dur, pos, X);
    if (!start) {
      // слишком поздно для нормальной склейки — обычный переход в конце трека
      if (remaining < X * 0.6) this.mixBlockedFor = cur.id;
      return;
    }
    if (pos < start.sA - START_LEAD_SEC) return;

    const prep = this.prep;
    const idle = this.B;
    if (!prep || prep.id !== nxt.id || !prep.ready || !(safe(() => idle.isLoaded) ?? false)) return; // ждём B

    // ── Старт склейки ──
    // B стартует с темпом A (1 / ratio) и идёт с 0% громкости; A плавно ускоряется/замедляется к темпу B.
    const now = Date.now();
    const master = this.master();
    const initialRateB = plan.tempo ? clamp(plan.bpmA / plan.targetBpm, 0.5, 2) : 1;
    this.setRate(idle, initialRateB);
    safe(() => {
      idle.volume = 0;
      a.volume = master;
      idle.play();
    });

    this.trans = {
      from: a,
      to: idle,
      toId: nxt.id,
      plan,
      durationMs: start.durationMs,
      elapsedMs: 0,
      lastTickAt: now,
      uiSwitched: false,
      lastRateA: 1 * this.fxd.speed,
      lastRateB: initialRateB * this.fxd.speed,
      lastRateAt: now,
      corr: 0,
      lastVolA: master,
      lastVolB: 0,
      phaseFixes: 0,
      lastPhaseFixAt: 0,
      swapStage: 0,
      swapAt: 0,
    };
    this.set({ mixing: true });
    this.setBusy(true);
  };

  private driveTransition(pos: number, dur: number) {
    const t = this.trans!;
    const now = Date.now();
    // прогресс считаем только по времени, когда реально играем (пауза посреди склейки не «съедает» её)
    t.elapsedMs += Math.min(120, now - t.lastTickAt);
    t.lastTickAt = now;
    const p = clamp(t.elapsedMs / t.durationMs, 0, 1);

    // ── громкость: A 100%→0, B 0→100% одновременно ──
    const { volA, volB } = volumesAt(p, this.dj.fadeVolumeEnabled);
    const master = this.master();
    const targetA = volA * master;
    const targetB = volB * master;
    if (Math.abs(targetA - t.lastVolA) >= 0.006 || p >= 1) {
      safe(() => (t.from.volume = targetA));
      t.lastVolA = targetA;
    }
    if (Math.abs(targetB - t.lastVolB) >= 0.006 || p >= 1) {
      safe(() => (t.to.volume = targetB));
      t.lastVolB = targetB;
    }

    // ── темп: оба трека идут к общему BPM; A ускоряется, B из темпа A сходится к своему ──
    if (t.plan.tempo && p < 1) {
      if (this.mode === 'fx') this.driveSmoothTempo(t, p, pos, now);
      else this.driveSteppedTempo(t, p, pos, now);
    }

    if (p >= 0.5 && !t.uiSwitched) this.switchUiToIncoming();
    // A дошёл до конца файла — склейка завершена
    if (p >= 1 || pos >= dur - 0.06) this.commitTransition();
  }

  /** Нативный движок: непрерывная смена темпа (шаг 45 мс) + мягкая фазовая автоподстройка (PLL) — без единого разрыва */
  private driveSmoothTempo(t: Transition, p: number, pos: number, now: number) {
    if (now - t.lastRateAt < FX_RATE_STEP_MS) return;
    const base = ratesAt(t.plan, p);
    let rateB = base.rateB;

    // Мягкая фазовая автоподстройка: чуть подруливаем скорость B, чтобы удары легли друг на друга (без перемоток)
    if (t.plan.beatSync && t.elapsedMs > 600) {
      const tb = safe(() => t.to.currentTime);
      if (tb !== undefined && Number.isFinite(tb)) {
        const phiA = beatPhase(pos, t.plan.phaseA, t.plan.periodA);
        const phiB = beatPhase(tb, t.plan.phaseB, t.plan.periodB);
        const err = wrapHalf(phiA - phiB); // >0 — B отстаёт от бита
        const target = clamp(err * PLL_GAIN, -PLL_MAX, PLL_MAX);
        t.corr += (target - t.corr) * 0.2;
      }
    }
    // поправка гасится к концу склейки, чтобы B пришёл ровно в родной темп (1.0) без последнего «ступенчатого» изменения
    rateB *= 1 + t.corr * (1 - p);

    const fa = base.rateA * this.fxd.speed;
    const fb = rateB * this.fxd.speed;
    if (Math.abs(fa - t.lastRateA) >= FX_RATE_EPS) {
      this.setRate(t.from, base.rateA);
      t.lastRateA = fa;
    }
    if (Math.abs(fb - t.lastRateB) >= FX_RATE_EPS) {
      this.setRate(t.to, rateB);
      t.lastRateB = fb;
    }
    t.lastRateAt = now;
  }

  /**
   * Запасной режим (AVPlayer): ни одной смены скорости «по чуть-чуть». B с самого старта идёт в темпе A (скорость выставлена
   * до запуска, пока трек не слышен), оба трека играют в одном темпе → биты совпадают. На середине склейки темп меняется
   * ОДИН раз у каждого плеера: сначала A → к темпу B, через 170 мс B → к родному (разница темпов за эти 170 мс даёт доли
   * миллисекунд расхождения, на слух незаметно). Короткий провал, который AVPlayer делает при смене скорости, приходится на
   * момент, когда звучит и второй трек.
   */
  private driveSteppedTempo(t: Transition, p: number, pos: number, now: number) {
    const plan = t.plan;

    // 1. фазовая подгонка B перемоткой, пока B почти не слышен (при p≈0.06 его громкость ≈ −30 дБ; не более двух перемоток)
    if (plan.beatSync && t.phaseFixes < 2 && p < 0.22 && t.elapsedMs >= Math.max(280, t.durationMs * 0.06) && now - t.lastPhaseFixAt >= 450) {
      const tb = safe(() => t.to.currentTime);
      if (tb !== undefined && Number.isFinite(tb)) {
        const phiA = beatPhase(pos, plan.phaseA, plan.periodA);
        const phiB = beatPhase(tb, plan.phaseB, plan.periodB);
        // ошибка в «файловом» времени B: период сетки B × доля бита
        const errSec = wrapHalf(phiA - phiB) * plan.periodB;
        t.phaseFixes++;
        t.lastPhaseFixAt = now;
        if (Math.abs(errSec) > 0.012 && Math.abs(errSec) < 0.3) {
          const rateB = plan.bpmA / plan.targetBpm;
          safe(() => t.to.seekTo(Math.max(0, tb + errSec + 0.035 * rateB))); // 35 мс — время самой перемотки
        }
      }
    }

    // 2. ступенчатая смена темпа на второй половине склейки
    if (t.swapStage === 0 && p >= STEP_SWAP_P) {
      t.swapStage = 1;
      t.swapAt = now;
      const r = ratesAt(plan, 1);
      this.setRate(t.from, r.rateA);
      t.lastRateA = r.rateA * this.fxd.speed;
    } else if (t.swapStage === 1 && now - t.swapAt >= STEP_GAP_MS) {
      t.swapStage = 2;
      this.setRate(t.to, 1);
      t.lastRateB = this.fxd.speed;
    }
  }

  /** На середине склейки обложка/название/текст переключаются на новый трек (только UI, без I/O) */
  private switchUiToIncoming() {
    const t = this.trans;
    if (!t) return;
    const idx = this.state.queue.findIndex((x) => x.id === t.toId);
    if (idx < 0) return;
    t.uiSwitched = true;
    const track = this.state.queue[idx];
    safe(() => t.from.clearLockScreenControls());
    this.updateLockScreen(t.to, track);
    this.set({ index: idx, player: t.to, duration: safe(() => t.to.duration) ?? 0 });
  }

  /** Завершает склейку: B становится основным (темп 1.0 = родной BPM), A останавливается */
  private commitTransition() {
    const t = this.trans;
    if (!t) return;
    if (!t.uiSwitched) this.switchUiToIncoming();
    safe(() => {
      t.from.pause();
      t.from.volume = 0;
    });
    this.setRate(t.to, 1.0); // в запасном режиме B к этому моменту уже на 1.0 — кэш скорости пропустит повторную установку
    // бывший A остановлен: его скорость сбрасывается при следующей загрузке файла (у AVPlayer смена скорости на паузе может запустить воспроизведение)
    if (this.mode === 'fx') this.setRate(t.from, 1.0);
    else this.rateCache.delete(t.from);
    safe(() => {
      t.to.volume = this.master();
    });
    this.active = this.players.indexOf(t.to);
    this.trans = null;
    this.prep = null;
    this.mixBlockedFor = null;
    this.lastCommandAt = Date.now();
    this.set({ mixing: false, player: t.to, isPlaying: this.playIntent });
    // seekTo(0) на бывшем A-плеере откладываем: сначала он должен полностью остановиться
    const fromPlayer = t.from;
    setTimeout(() => safe(() => fromPlayer.seekTo(0)), 300);
    this.setBusy(false);
    this.notifyTrackChange();
  }

  private cancelTransition() {
    const t = this.trans;
    if (!t) return;
    safe(() => {
      t.to.pause();
      t.to.volume = 0;
      t.from.volume = this.master();
    });
    if (this.mode === 'fx') this.setRate(t.to, 1.0);
    else this.rateCache.delete(t.to); // B на паузе: скорость сбросится при следующей загрузке
    this.setRate(t.from, 1.0);
    this.trans = null;
    this.prep = null;
    this.mixBlockedFor = this.currentTrack?.id ?? null;
    this.set({ mixing: false, player: this.A });
    this.setBusy(false);
  }

  /* ───────────── экран блокировки и Dynamic Island ───────────── */

  private updateLockScreen(player: AudioPlayer, t: TrackFile) {
    safe(() =>
      player.setActiveForLockScreen(
        true,
        { title: t.title, artist: t.artist, albumTitle: t.album || 'WouFY.no', artworkUrl: t.artworkUri },
        { showNextTrack: true, showPreviousTrack: true, showSeekForward: true, showSeekBackward: true, isLiveStream: false }
      )
    );
  }

  dispose() {
    if (this.timer) clearInterval(this.timer);
    fxRemote.handler = undefined;
    this.subs.forEach((s) => safe(() => s.remove()));
    this.players.forEach((p) => safe(() => p.remove()));
  }
}
