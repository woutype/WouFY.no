import { createAudioPlayer } from 'expo-audio';
import { DJSettings, DEFAULT_DJ, DEFAULT_FX, FxSettings, RepeatMode, SLOWED_RATE, SPEEDUP_RATE, TrackFile } from '../types';
import { planMix, ratesAt, volumesAt, beatPhase, wrapHalf, MixPlan, TrackTempo, BeatGrid } from './djMix';
import { configureAudioSession } from './audioService';
import { volumeService } from './volumeService';
import type { PlayerLike, PlayerStatus } from './playerLike';
import { createFxPlayer, fxNativeAvailable, fxRemote, setRemoteHandler, WoufyFX } from './fxPlayer';
import { SortOption, applySort, matchesQuery, normQuery } from './queueOrder';
import { statsService } from './statsService';
import { resolveTrackUri } from './library';
import { getFullArtwork } from './artwork';

/** пропуск раньше этого порога (сек) понижает приоритет трека в текущей очереди Smart Shuffle */
const SKIP_DEMOTE_SEC = 10;

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
  /** сортировка очереди (применяется к самой очереди) */
  sort: SortOption;
  /** активен поиск: очередь = только найденные треки */
  filtered: boolean;
  /** играющий сейчас трек не подходит под фильтр: он закреплён первым в очереди и в списке не показывается */
  pinned: boolean;
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
  /** нативный режим: сколько грубых фазовых перемоток B уже сделано (≤2), когда последняя, идёт ли сейчас */
  seeks: number;
  lastSeekAt: number;
  seeking: boolean;
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
/** Вдали от склейки таймеру нечего делать часто: просыпаемся редко (меньше работы для процессора → меньше нагрев) */
const TICK_IDLE_MS = 400;
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
const PLL_GAIN = 0.8;
const PLL_MAX = 0.03;
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
  private errorSkipTimer: ReturnType<typeof setTimeout> | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private subs: { remove: () => void }[] = [];
  private bpmLookup: (t: TrackFile) => number | undefined = () => undefined;
  private gridLookup: (t: TrackFile) => BeatGrid | undefined = () => undefined;
  private onMixingChange: (mixing: boolean) => void = () => {};
  private onTrackChange: (cur: TrackFile | undefined, upcoming: (TrackFile | undefined)[]) => void = () => {};
  private onPersist: (s: { order: string[]; shuffle: boolean; repeat: RepeatMode; volume: number; lastTrackId?: string }) => void =
    () => {};
  private lastUserVolumeChangeAt = 0;
  /** текущий период таймера (адаптивный: редко вдали от склейки, часто во время неё) */
  private tickMs = TICK_IDLE_MS;
  /** после смены режима плееров (эффекты вкл/выкл) статус «пауза» от плеера не считается внешней паузой */
  private syncGuardUntil = 0;
  /** эффекты больше не нужны, но режим AVAudioEngine оставлен до паузы/смены трека — чтобы не рвать воспроизведение */
  private pendingNative = false;
  /** фильтры очереди */
  private query = '';
  private sortMode: SortOption = 'default';
  private searchLyrics = false;
  /** порядок перемешивания ВСЕЙ библиотеки (очередь = он же, отфильтрованный) */
  private shufflePerm: string[] = [];

  /** Защита от перегрузки AVPlayer при быстром перелистывании (2+ трека подряд) */
  private lastSkipTime = 0;
  private skipDebounceTimer: ReturnType<typeof setTimeout> | null = null;
  private audioSessionConfigured = false;
  private lastSeekTarget: { time: number; requestedAt: number } | null = null;
  private lastPrevTapTime = 0;
  private trackStartedAt = 0;

  constructor() {
    configureAudioSession(true).then(() => {
      this.audioSessionConfigured = true;
    });
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
      sort: 'default',
      filtered: false,
      pinned: false,
    };
    this.attachPlayers();
    this.timer = setInterval(this.tick, this.tickMs);

    setRemoteHandler((cmd, pos) => this.handleRemote(cmd, pos));

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
      () => createAudioPlayer(null, { updateInterval: 250, keepAudioSessionActive: true }) as unknown as AudioPlayer
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
    // сразу после переключения режима плееров iOS может прислать «прерывание» сессии — это не нажатие пользователя
    if ((cmd === 'pause' || cmd === 'play') && Date.now() < this.syncGuardUntil) return;
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
      // time-pitch (самый тяжёлый узел цепочки) включаем только когда нужен темп/тон: Slowed, Speed Up или подгон BPM
      p.setTempoProcessing?.(this.needTempo());
      // Без нативного движка: Slowed / Speed Up работают «по-кассетному» (темп и тон вместе — так и задумано);
      // подгон BPM при склейке — с сохранением высоты тона (темп меняется всего 1–2 раза, см. STEP_SWAP_P), тон не «прыгает».
      if (!p.isFx) p.shouldCorrectPitch = !f.tape;
    });
  }

  /** Нужна ли обработка темпа/тона (иначе нативный time-pitch отключается — заметно меньше нагрузка на процессор) */
  private needTempo(): boolean {
    return this.fxd.speed !== 1 || (this.dj.crossfadeEnabled && this.dj.bpmTransitionEnabled);
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
    if (want === 'native' && this.mode === 'fx') {
      // Эффекты выключили, пока музыка играет: пересоздавать плееры посреди трека — значит прервать звук.
      // Остаёмся на AVAudioEngine без эффектов (реверберация 0 — узел в обходе) и меняем режим на паузе / при смене трека.
      if (!this.playIntent && !this.trans) {
        this.switchMode('native');
        this.pendingNative = false;
      } else {
        this.pendingNative = true;
        this.players.forEach((p) => this.applyFx(p));
        if (!this.trans) {
          this.setRate(this.A, 1);
          this.setRate(this.B, 1);
        }
      }
    } else if (want !== this.mode) {
      this.pendingNative = false;
      this.switchMode(want);
    } else {
      this.pendingNative = false;
      this.players.forEach((p) => this.applyFx(p));
      if (!this.trans) {
        this.setRate(this.A, 1);
        this.setRate(this.B, 1);
      }
    }
    this.prep = null;
  }

  /** Если эффекты уже не нужны — возвращаем обычные плееры (вызывается на паузе или при смене трека, где разрыв звука не слышен) */
  private applyPendingMode(restore: boolean) {
    if (!this.pendingNative || this.mode !== 'fx') return;
    this.pendingNative = false;
    const needFx = this.fxd.reverb > 0 || this.fxd.spatial || (this.dj.crossfadeEnabled && this.dj.bpmTransitionEnabled);
    if (needFx && fxNativeAvailable()) return;
    this.switchMode('native', restore);
  }

  /** Активен ли нативный движок (для диагностики в настройках) */
  get fxActive() {
    return this.mode === 'fx';
  }

  /** Переключает «обычные» плееры ↔ плееры эффектов, сохраняя трек, позицию и состояние воспроизведения */
  private switchMode(mode: 'native' | 'fx', restore = true) {
    if (mode === this.mode) return;
    const cur = restore ? this.currentTrack : undefined;
    const pos = this.getPosition();
    const was = this.playIntent;
    if (this.trans) this.cancelTransition();
    // Именно здесь раньше «ставилась на паузу» музыка: новый плеер ещё грузился и отдавал статус «пауза», а движок
    // принимал это за внешнюю паузу (звонок / наушники) и выключал воспроизведение. Теперь окно защиты + FX-плеер не синхронизируется по статусу.
    this.lastCommandAt = Date.now();
    this.syncGuardUntil = Date.now() + 3000;

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
      const uri = resolveTrackUri(cur.uri || cur.id);
      safe(() => {
        this.load(a, uri);
        a.volume = this.master();
        a.muted = false;
      });
      this.setRate(a, 1);
      if (pos > 0.5) safe(() => a.seekTo(pos));
      this.updateLockScreen(a, cur);
      if (was) {
        if (a.isFx) {
          // цепочка команд плеера эффектов сама выстраивает порядок «загрузка → перемотка → play», сессию активирует replace()
          safe(() => a.play());
        } else {
          configureAudioSession(true).then(() => {
            if (token === this.playToken && this.playIntent) safe(() => a.play());
          });
        }
      }
    }
  }

  /** Повторно активирует аудио-сессию (при возврате в приложение) */
  resyncSession() {
    configureAudioSession(true).then(() => {
      this.audioSessionConfigured = true;
    });
    const t = this.currentTrack;
    if (t) this.updateLockScreen(this.uiPlayer(), t);
  }

  /** Обновляет данные треков (теги, обложки дочитываются в фоне) без сброса очереди и воспроизведения */
  patchTracks(updated: TrackFile[]) {
    if (updated.length === 0) return;
    const map = new Map(updated.map((t) => [t.id, t]));
    this.library = this.library.map((t) => map.get(t.id) ?? t);
    if (this.query || this.sortMode !== 'default') {
      // сортировка/поиск зависят от тегов: пока они дочитываются, очередь пересобирается
      const d = this.deriveQueue();
      this.set({ queue: d.queue, index: d.index, pinned: d.pinned });
    } else {
      const queue = this.state.queue.map((t) => map.get(t.id) ?? t);
      this.set({ queue });
    }
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
    if (this.lastSeekTarget && Date.now() - this.lastSeekTarget.requestedAt < 400) {
      return this.lastSeekTarget.time;
    }
    return safe(() => this.uiPlayer().currentTime) ?? 0;
  }
  getDuration(): number {
    return safe(() => this.uiPlayer().duration) ?? 0;
  }

  /* ───────────── библиотека и очередь ───────────── */

  /**
   * Очередь = (порядок библиотеки | перемешанный порядок) → сортировка → поиск.
   * Играющий трек всегда присутствует в очереди: если он не подходит под фильтр, он ставится первым (pinned) —
   * доиграет, а дальше плеер пойдёт строго по найденным трекам.
   */
  private deriveQueue(curId: string | undefined = this.currentTrack?.id, shuffle: boolean = this.state.shuffle) {
    const byId = new Map(this.library.map((t) => [t.id, t]));
    const isCustomSort = this.sortMode !== 'default';
    // Если включена кастомная сортировка (не default), порядок задаётся сортировкой, а не перемешиванием
    const ids = shuffle && !isCustomSort ? this.shufflePerm : this.baseOrder;
    let list: TrackFile[] = [];
    for (const id of ids) {
      const t = byId.get(id);
      if (t) list.push(t);
    }
    const q = this.query;
    if (q) list = list.filter((t) => matchesQuery(t, q, this.searchLyrics));
    if (isCustomSort) {
      list = applySort(list, this.sortMode);
    }
    let index = -1;
    let pinned = false;
    const cur = curId ? byId.get(curId) : undefined;
    if (cur) {
      index = list.findIndex((t) => t.id === cur.id);
      if (index < 0) {
        list = [cur, ...list];
        index = 0;
        pinned = true;
      }
    }
    return { queue: list, index, pinned };
  }

  /**
   * Smart Weighted Shuffle:
   * Треки, которые слушаются чаще, получают больший вес и оказываются ближе к началу.
   * Скипнутые треки получают меньший вес, но не удаляются совсем.
   * Алгоритм: Efraimidis-Spirakis weighted sampling (O(N log N)).
   */
  private makeShufflePerm(curId?: string): string[] {
    const rest = this.library.map((t) => t.id).filter((id) => id !== curId);
    const weights = statsService.getTrackWeights();
    const weighted = rest.map((id) => {
      const w = weights.get(id) ?? 1;
      const key = Math.pow(Math.random(), 1 / Math.max(0.01, w));
      return { id, key };
    });
    weighted.sort((a, b) => b.key - a.key);
    const shuffled = weighted.map((item) => item.id);
    return curId ? [curId, ...shuffled] : shuffled;
  }

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

    if (this.state.shuffle) {
      // перемешанный порядок сохраняется; новые файлы дописываются в конец
      const inPerm = new Set<string>();
      const perm: string[] = [];
      for (const id of this.shufflePerm) {
        if (byId.has(id) && !inPerm.has(id)) {
          perm.push(id);
          inPerm.add(id);
        }
      }
      for (const id of ordered) if (!inPerm.has(id)) perm.push(id);
      this.shufflePerm = perm;
    }

    const wantedId = prevCurrentId ?? savedLastId;
    const d = this.deriveQueue(wantedId);
    let index = d.index;
    if (index < 0 && d.queue.length > 0 && !this.playIntent) index = 0;

    const changed = d.queue[index]?.id !== prevCurrentId;
    this.set({ queue: d.queue, index, pinned: d.pinned });
    if (changed && index >= 0) this.prepare(index);
    else this.notifyTrackChange();
  }

  /** Загружает трек в активный плеер без запуска (после старта приложения) */
  private prepare(index: number) {
    const t = this.state.queue[index];
    if (!t) return;
    const uri = resolveTrackUri(t.uri || t.id);
    safe(() => {
      this.load(this.A, uri);
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
    const cur = this.currentTrack;
    // смена очереди/rescan не должны обрывать идущую сессию прослушивания (иначе один трек считается дважды)
    if (cur && !statsService.isTracking(cur.id)) {
      statsService.onTrackStart(cur, this.state.duration, this.getPosition());
    }
    this.onTrackChange(cur, this.upcoming());
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

  /** Склейка, идущая в момент изменения очереди, завершается/отменяется — следующий трек мог измениться */
  private settleTransition() {
    if (!this.trans) return;
    if (this.trans.uiSwitched) this.commitTransition();
    else this.cancelTransition();
  }

  moveQueueItem(from: number, to: number) {
    // ручная перестановка имеет смысл только в «чистой» очереди: при поиске/сортировке порядок задаёт фильтр
    if (this.query || this.sortMode !== 'default') return;
    const q = [...this.state.queue];
    if (from < 0 || from >= q.length || to < 0 || to >= q.length || from === to) return;
    const [item] = q.splice(from, 1);
    q.splice(to, 0, item);
    let index = this.state.index;
    if (from === index) index = to;
    else if (from < index && to >= index) index -= 1;
    else if (from > index && to <= index) index += 1;
    const ids = q.map((t) => t.id);
    if (this.state.shuffle) this.shufflePerm = ids;
    else this.baseOrder = ids;
    this.prep = null;
    this.set({ queue: q, index });
    setTimeout(() => this.persist(), 50);
    this.onTrackChange(this.currentTrack, this.upcoming());
  }

  setShuffle(on: boolean) {
    if (on === this.state.shuffle) return;
    this.settleTransition();
    const cur = this.currentTrack;
    if (on) {
      // каждое включение — новый взвешенный порядок (веса учитывают дослушивания/скипы)
      this.shufflePerm = this.makeShufflePerm(cur?.id);
      this.sortMode = 'default';
    } else if (this.sortMode === 'default' && this.shufflePerm.length > 0) {
      // выключение оставляет текущий (перемешанный) порядок как базовый
      this.baseOrder = [...this.shufflePerm];
    }
    const d = this.deriveQueue(cur?.id, on);
    this.prep = null;
    this.set({ shuffle: on, sort: this.sortMode, queue: d.queue, index: d.index, pinned: d.pinned });
    this.persist();
    this.onTrackChange(this.currentTrack, this.upcoming());
  }

  /**
   * Поиск и сортировка очереди. Очередь пересобирается целиком: «следующий трек» — всегда следующий в том списке,
   * который показан на экране. С включённым перемешиванием перемешиваются только найденные треки.
   */
  setFilter(patch: { query?: string; sort?: SortOption; searchLyrics?: boolean }) {
    const nq = patch.query !== undefined ? normQuery(patch.query) : this.query;
    const ns = patch.sort ?? this.sortMode;
    const nsl = patch.searchLyrics !== undefined ? patch.searchLyrics : this.searchLyrics;
    const isSortExplicit = patch.sort !== undefined;
    if (!isSortExplicit && nq === this.query && ns === this.sortMode && nsl === this.searchLyrics) return;
    this.settleTransition();
    this.query = nq;
    this.sortMode = ns;
    this.searchLyrics = nsl;
    // При явном выборе режима сортировки (не default) отключаем shuffle
    const shuffle = ns !== 'default' ? false : this.state.shuffle;
    const d = this.deriveQueue(undefined, shuffle);
    this.prep = null;
    this.set({
      shuffle,
      queue: d.queue,
      index: d.index,
      pinned: d.pinned,
      sort: ns,
      filtered: nq.length > 0 || nsl,
    });
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

  playTrack(trackOrId: TrackFile | string, seekTo?: number) {
    const id = typeof trackOrId === 'string' ? trackOrId : trackOrId.id;
    const idx = this.state.queue.findIndex((t) => t.id === id);
    if (idx >= 0) {
      this.playIndex(idx, seekTo);
    } else {
      const libIdx = this.library.findIndex((t) => t.id === id);
      if (libIdx >= 0) {
        this.query = '';
        const d = this.deriveQueue(id, false);
        this.set({ queue: d.queue, index: d.index, filtered: false });
        if (d.index >= 0) this.playIndex(d.index, seekTo);
      }
    }
  }

  /** Воспроизведение треков из Топ-10: сначала играет выбранный трек, затем остальные из топа, затем обычная библиотека */
  playTopTracks(topList: TrackFile[], startIndex: number) {
    if (topList.length === 0 || startIndex < 0 || startIndex >= topList.length) return;
    this.settleTransition();
    const selectedId = topList[startIndex].id;
    // берём только треки, реально существующие в библиотеке (иначе индексы очереди разъезжаются с топом)
    const byId = new Map(this.library.map((t) => [t.id, t]));
    const playable = topList.map((t) => byId.get(t.id)).filter((t): t is TrackFile => !!t);
    const start = playable.findIndex((t) => t.id === selectedId);
    if (start < 0) return;
    const topIds = new Set(playable.map((t) => t.id));
    const topOrdered = [...playable.slice(start), ...playable.slice(0, start)];
    const rest = this.library.filter((t) => !topIds.has(t.id));
    this.baseOrder = [...topOrdered, ...rest].map((t) => t.id);
    this.shufflePerm = this.makeShufflePerm(selectedId);
    // сбрасываем поиск/сортировку ВНУТРИ движка, иначе deriveQueue пересортирует/отфильтрует очередь
    this.query = '';
    this.sortMode = 'default';
    const d = this.deriveQueue(selectedId, false);
    this.prep = null;
    this.set({ queue: d.queue, index: d.index, sort: 'default', filtered: false, shuffle: false, pinned: d.pinned });
    this.playIndex(d.index);
  }

  /**
   * Smart Shuffle: трек, пропущенный в первые SKIP_DEMOTE_SEC секунд, уходит ближе к концу оставшейся очереди.
   * Возвращает актуальный индекс целевого трека (очередь могла сдвинуться).
   */
  private demoteEarlySkip(targetId: string, fallbackIndex: number): number {
    const leaving = this.currentTrack;
    if (!leaving || leaving.id === targetId || !this.state.shuffle || this.sortMode !== 'default') return fallbackIndex;
    const listened = statsService.currentListened(leaving.id);
    if (listened === null || listened >= SKIP_DEMOTE_SEC) return fallbackIndex;
    const perm = this.shufflePerm.filter((id) => id !== leaving.id);
    const at = perm.indexOf(targetId);
    if (at < 0) return fallbackIndex;
    // в последнюю треть оставшейся части очереди (не в самый конец — чтобы не был предсказуем)
    const tail = perm.length - (at + 1);
    const pos = perm.length - Math.floor(Math.random() * Math.max(1, Math.ceil(tail / 3)));
    perm.splice(Math.max(at + 1, pos), 0, leaving.id);
    this.shufflePerm = perm;
    const d = this.deriveQueue(targetId, true);
    if (d.index < 0) return fallbackIndex;
    this.set({ queue: d.queue, index: d.index, pinned: d.pinned });
    return d.index;
  }

  playIndex(index: number, seekTo?: number, isAutoSkip = false) {
    if (!isAutoSkip && this.state.queue[index]) index = this.demoteEarlySkip(this.state.queue[index].id, index);
    const t = this.state.queue[index];
    if (!t) return;
    // отложенный пропуск «битого» трека не должен сработать поверх нового выбора (иначе лишний +1)
    if (this.errorSkipTimer) {
      clearTimeout(this.errorSkipTimer);
      this.errorSkipTimer = null;
    }
    if (this.trans) this.cancelTransition();
    this.mixBlockedFor = null;
    if (!isAutoSkip) {
      this.errorSkips = 0;
    }
    this.playIntent = true;
    this.lastCommandAt = Date.now();
    const token = ++this.playToken;

    // 1. Мгновенно переключаем визуальный UI (0ms): обложка, название, карточка и очередь обновляются без малейшей задержки
    this.prep = null;
    this.set({ index, isPlaying: true, duration: 0, player: this.A, mixing: false });
    this.updateLockScreen(this.A, t);
    this.onTrackChange(t, this.upcoming());
    this.persist();

    // 2. Умная защита от заклинивания нативного AVPlayer при быстром перелистывании (2+ трека подряд)
    const now = Date.now();
    const isBurst = now - this.lastSkipTime < 260;
    this.lastSkipTime = now;

    if (this.skipDebounceTimer) {
      clearTimeout(this.skipDebounceTimer);
      this.skipDebounceTimer = null;
    }

    if (isBurst) {
      // Быстрое пролистывание: сразу глушим звук предыдущего трека
      safe(() => {
        this.A.pause();
        this.B.pause();
      });
      // Откладываем тяжелый native replaceCurrentItem на 120ms:
      // если пользователь нажмет еще раз, этот таймер сбросится и AVPlayer загрузит ТОЛЬКО финальный трек,
      // полностью исключая 2-3 секундный затуп из-за отмены очередей AVPlayerItem
      this.skipDebounceTimer = setTimeout(() => {
        this.skipDebounceTimer = null;
        this.performLoadAndPlay(t, seekTo, token);
      }, 120);
    } else {
      // Одиночное переключение — стартуем сразу без задержек
      this.performLoadAndPlay(t, seekTo, token);
    }
  }

  private performLoadAndPlay(t: TrackFile, seekTo: number | undefined, token: number) {
    if (token !== this.playToken || !this.playIntent) return;
    this.trackStartedAt = Date.now();
    this.applyPendingMode(false);
    const a = this.A;
    const uri = resolveTrackUri(t.uri || t.id);
    safe(() => {
      this.B.pause();
      this.load(a, uri);
      if (typeof seekTo === 'number' && seekTo > 0) {
        a.seekTo(seekTo);
      }
      a.volume = Math.max(0.05, this.master());
      a.muted = false;
    });
    this.applyFx(a);
    this.setRate(a, 1);

    const doPlay = () => {
      if (token !== this.playToken || !this.playIntent) return;
      safe(() => {
        if (typeof seekTo === 'number' && seekTo > 0) {
          a.seekTo(seekTo);
        }
        a.play();
      });
    };

    if (this.audioSessionConfigured) {
      doPlay();
    } else {
      configureAudioSession(true).then(() => {
        this.audioSessionConfigured = true;
        doPlay();
      });
    }

    statsService.onTrackStart(t, this.state.duration, seekTo ?? 0);
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
      if (this.skipDebounceTimer) {
        clearTimeout(this.skipDebounceTimer);
        this.skipDebounceTimer = null;
      }
      safe(() => {
        this.A.pause();
        if (this.trans) this.trans.to.pause();
      });
      statsService.finalizeCurrent(true);
      this.set({ isPlaying: false });
      if (this.pendingNative && !this.trans) this.applyPendingMode(true);
      this.syncLockScreenPlayback();
    } else {
      this.playIntent = true;
      const token = ++this.playToken;
      const a = this.A;
      const to = this.trans?.to;
      const cur = this.currentTrack;

      // Если плеер пуст или еще не был готов: загружаем текущий трек с гарантированным URI
      if (cur && !(safe(() => a.isLoaded) ?? false)) {
        this.performLoadAndPlay(cur, this.getPosition(), token);
        return;
      }

      const doPlay = () => {
        if (token !== this.playToken || !this.playIntent) return;
        safe(() => {
          a.muted = false;
          a.play();
          to?.play();
        });
      };
      if (this.audioSessionConfigured) {
        doPlay();
      } else {
        configureAudioSession(true).then(() => {
          this.audioSessionConfigured = true;
          doPlay();
        });
      }
      if (this.currentTrack) {
        statsService.onTrackStart(this.currentTrack, this.state.duration, this.getPosition());
      }
      this.set({ isPlaying: true });
      this.syncLockScreenPlayback();
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

  previous(forceTrackChange = false) {
    const n = this.state.queue.length;
    if (n === 0) return;
    if (this.trans) {
      if (this.trans.uiSwitched) this.commitTransition();
      else this.cancelTransition();
    }

    const now = Date.now();
    const isDoubleTap = now - this.lastPrevTapTime < 2000;
    this.lastPrevTapTime = now;

    // Свайп обложки или повторное нажатие кнопки в течение 2 секунд: всегда переключаем на предыдущий трек
    if (forceTrackChange || isDoubleTap) {
      this.playIndex((this.state.index - 1 + n) % n);
      return;
    }

    // Первое нажатие: если прошло больше 3 секунд — перематываем в начало трека
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
    const clamped = Math.max(0, seconds);
    this.lastSeekTarget = { time: clamped, requestedAt: Date.now() };
    safe(() => this.A.seekTo(clamped));
    const fx = WoufyFX;
    if (fx) {
      safe(() => fx.updateNowPlaying(clamped, this.state.isPlaying ? 1.0 : 0.0));
    }
  }

  /* ───────────── обработка событий плеера ───────────── */

  private onStatus(player: AudioPlayer, s: AudioStatus) {
    if (player !== this.uiPlayer()) {
      // конец трека A во время склейки обрабатывается в tick()
      return;
    }
    const pos = player.currentTime;
    if (typeof pos === 'number' && !isNaN(pos)) statsService.onTrackPosition(pos, s.duration);
    const patch: Partial<EngineState> = {};
    if (s.duration > 0 && s.duration !== this.state.duration) {
      patch.duration = s.duration;
      const fx = WoufyFX;
      if (fx && this.currentTrack) {
        const cur = this.currentTrack;
        safe(() => {
          fx.setNowPlaying(cur.title, cur.artist, cur.album || 'WouFY.no', cur.artworkUri ?? null, s.duration);
          fx.updateNowPlaying(typeof pos === 'number' ? pos : 0, this.state.isPlaying ? 1.0 : 0.0);
        });
      }
    }

    // Синхронизация с внешними событиями (звонок, наушники, экран блокировки)
    // У плеера эффектов статус «играет/пауза» — лишь отражение наших же команд (внешние паузы приходят отдельным событием onRemote),
    // поэтому сверять с ним нечего: именно такая сверка и «выключала» музыку при включении эффектов.
    const settled = Date.now() - this.lastCommandAt > 800 && Date.now() > this.syncGuardUntil;
    if (settled && !this.trans && !player.isFx) {
      if (s.timeControlStatus === 'paused' && this.playIntent && s.isLoaded && !s.didJustFinish && !s.isBuffering) {
        this.playIntent = false;
        patch.isPlaying = false;
      } else if (s.timeControlStatus === 'playing' && !this.playIntent) {
        this.playIntent = true;
        patch.isPlaying = true;
      }
    }

    // счётчик сбрасываем только когда трек реально играет (а не на «загружен и сразу закончился»),
    // иначе лимит автопропуска никогда не срабатывает и треки листаются бесконечно
    if (s.isLoaded && s.duration > 0 && !s.error && !s.didJustFinish && typeof pos === 'number' && pos > 1.5) {
      this.errorSkips = 0;
    }

    if (Object.keys(patch).length) this.set(patch);

    if (s.error && this.playIntent) {
      this.handleTrackError();
      return;
    }

    if (s.didJustFinish && !this.trans) {
      if (!this.playIntent) return;

      // Защита от бесконечного пролистывания треков:
      // если трек только что запустился (< 1.2 с) и позиция у нуля (< 1 с),
      // а плеер уже рапортует didJustFinish — файл пустой/не читается, это ошибка,
      // а не естественное окончание воспроизведения.
      const curPos = typeof pos === 'number' ? pos : 0;
      const justStarted = Date.now() - this.trackStartedAt < 1200;
      if (justStarted && curPos < 1.0) {
        console.warn('[engine] abrupt finish on track:', this.currentTrack?.id);
        this.handleTrackError();
        return;
      }

      this.onEnded();
    }
  }

  private handleTrackError() {
    if (!this.playIntent) return;
    if (this.errorSkipTimer) return; // пропуск уже запланирован (статус с ошибкой приходит каждые 250 мс)
    if (this.errorSkips < 3 && this.state.queue.length > 1) {
      this.errorSkips++;
      const nextIdx = (this.state.index + 1) % this.state.queue.length;
      this.errorSkipTimer = setTimeout(() => {
        this.errorSkipTimer = null;
        if (this.playIntent) {
          this.playIndex(nextIdx, undefined, true);
        }
      }, 180);
    } else {
      this.errorSkips = 0;
      this.playIntent = false;
      safe(() => {
        this.A.pause();
        this.B.pause();
      });
      this.set({ isPlaying: false });
    }
  }

  private nextIndexAuto(): number | null {
    const { queue, index, repeat } = this.state;
    if (queue.length === 0 || index < 0) return null;
    if (repeat === 'one') return index;
    if (index + 1 < queue.length) return index + 1;
    return repeat === 'all' ? 0 : null;
  }

  private onEnded() {
    if (!this.playIntent) return;
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
      const uri = resolveTrackUri(nxt.uri || nxt.id);
      safe(() => {
        idle.pause();
        this.load(idle, uri);
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

  private setTickRate(ms: number) {
    if (ms === this.tickMs) return;
    this.tickMs = ms;
    if (this.timer) clearInterval(this.timer);
    this.timer = setInterval(this.tick, ms);
  }

  private tick = () => {
    if (!this.playIntent) {
      this.setTickRate(TICK_IDLE_MS);
      return;
    }
    const a = this.A;
    const pos = safe(() => a.currentTime) ?? 0;
    const dur = safe(() => a.duration) ?? 0;
    if (dur <= 0) {
      this.setTickRate(TICK_IDLE_MS);
      return;
    }

    if (this.trans) {
      this.setTickRate(TICK_MS);
      this.setBusy(true);
      this.driveTransition(pos, dur);
      return;
    }

    const X = this.dj.crossfadeDuration;
    const remaining0 = dur - pos;
    // фоновый анализ BPM не мешает только вдали от склейки: перед ней и во время неё он приостанавливается
    this.setBusy(this.dj.crossfadeEnabled && remaining0 <= PRELOAD_AHEAD_SEC + X * 1.5 + 10);
    // таймер частый только рядом со склейкой; во всё остальное время — редкий (раньше 25 раз в секунду круглые сутки)
    const nearMix = this.dj.crossfadeEnabled && remaining0 <= PRELOAD_AHEAD_SEC + X * 1.5 + 14;
    this.setTickRate(nearMix ? TICK_MS : TICK_IDLE_MS);
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
      seeks: 0,
      lastSeekAt: now,
      seeking: false,
    };
    this.setTickRate(TICK_MS);
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

  /**
   * Нативный движок: непрерывная смена темпа (шаг 45 мс) + фазовая автоподстройка (PLL), чтобы удары легли ДРУГ НА ДРУГА, а не рядом.
   * Раньше B стартовал с разбросом в десятки миллисекунд (задержка команды play), а петля была слишком медленной и включалась
   * только через 0.6 с — удары «двоились». Теперь: (1) позиция нативного плеера считается по реально отрендеренным семплам,
   * (2) в первые доли склейки, пока B почти не слышен, он одной короткой перемоткой встаёт на бит, (3) дальше фазу доводит быстрый PLL.
   */
  private driveSmoothTempo(t: Transition, p: number, pos: number, now: number) {
    if (now - t.lastRateAt < FX_RATE_STEP_MS) return;
    const base = ratesAt(t.plan, p);
    let rateB = base.rateB;

    if (t.plan.beatSync && t.elapsedMs > 140 && !t.seeking) {
      const tb = safe(() => t.to.currentTime);
      if (tb !== undefined && Number.isFinite(tb)) {
        const phiA = beatPhase(pos, t.plan.phaseA, t.plan.periodA);
        const phiB = beatPhase(tb, t.plan.phaseB, t.plan.periodB);
        const err = wrapHalf(phiA - phiB); // >0 — B отстаёт от бита
        const errSec = err * t.plan.periodB; // то же в секундах файла B

        // грубая подгонка: одна короткая перемотка, пока B тихий (громкость B при p<0.16 ниже −20 дБ)
        if (t.seeks < 2 && p < 0.16 && now - t.lastSeekAt > 380 && Math.abs(errSec) > 0.012 && Math.abs(errSec) < 0.3) {
          t.seeks++;
          t.seeking = true;
          t.lastSeekAt = now;
          const rb = Math.max(0.5, t.lastRateB / Math.max(this.fxd.speed, 0.01));
          Promise.resolve(safe(() => t.to.seekTo(Math.max(0, tb + errSec + 0.02 * rb))))
            .catch(() => {})
            .finally(() => {
              t.seeking = false;
              t.lastSeekAt = Date.now();
              t.corr = 0;
            });
          return;
        }
        // тонкая подгонка: чуть подруливаем скорость B (без перемоток)
        const target = clamp(err * PLL_GAIN, -PLL_MAX, PLL_MAX);
        t.corr += (target - t.corr) * 0.3;
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
    const fx = WoufyFX;
    if (fx) {
      safe(() => {
        fx.enableRemote(true);
        fx.setNowPlaying(
          t.title,
          t.artist,
          t.album || 'WouFY.no',
          t.artworkUri ?? null,
          this.state.duration > 0 ? this.state.duration : 0
        );
        const pos = this.getPosition();
        fx.updateNowPlaying(pos, this.state.isPlaying ? 1.0 : 0.0);
      });
      // на экран блокировки — оригинал обложки (миниатюра там выглядела бы размытой)
      getFullArtwork(t)
        .then((full) => {
          if (!full || full === t.artworkUri || this.currentTrack?.id !== t.id) return;
          safe(() => {
            fx.setNowPlaying(t.title, t.artist, t.album || 'WouFY.no', full, this.state.duration > 0 ? this.state.duration : 0);
            fx.updateNowPlaying(this.getPosition(), this.state.isPlaying ? 1.0 : 0.0);
          });
        })
        .catch(() => {});
      return;
    }
    // Fallback для сред без нативного модуля (строго запрещаем 10s skip)
    safe(() =>
      player.setActiveForLockScreen(
        true,
        { title: t.title, artist: t.artist, albumTitle: t.album || 'WouFY.no', artworkUrl: t.artworkUri },
        { showNextTrack: true, showPreviousTrack: true, showSeekForward: false, showSeekBackward: false, isLiveStream: false }
      )
    );
  }

  private syncLockScreenPlayback() {
    const fx = WoufyFX;
    if (fx) {
      safe(() => {
        const pos = this.getPosition();
        fx.updateNowPlaying(pos, this.state.isPlaying ? 1.0 : 0.0);
      });
    }
  }

  dispose() {
    if (this.timer) clearInterval(this.timer);
    if (this.skipDebounceTimer) {
      clearTimeout(this.skipDebounceTimer);
      this.skipDebounceTimer = null;
    }
    fxRemote.handler = undefined;
    this.subs.forEach((s) => safe(() => s.remove()));
    this.players.forEach((p) => safe(() => p.remove()));
  }
}
