import { createAudioPlayer, AudioPlayer, AudioStatus } from 'expo-audio';
import { DJSettings, DEFAULT_DJ, RepeatMode, TrackFile } from '../types';
import { planMix, ratesAt, volumesAt, beatPhase, wrapHalf, MixPlan, TrackTempo, BeatGrid } from './djMix';
import { configureAudioSession } from './audioService';
import { volumeService } from './volumeService';

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
  /** выполнена первичная подгонка фазы B */
  hardSynced: boolean;
  /** до этого момента (мс склейки) PLL не трогает скорость — идёт перемотка */
  holdUntilMs: number;
  lastVolA: number;
  lastVolB: number;
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
/** Как часто обновляем скорость воспроизведения во время склейки (чаще — рывки AVPlayer) */
const RATE_STEP_MS = 150;
/** Опережение старта B, сек (задержка команды play) */
const START_LEAD_SEC = 0.05;
/** Усиление и предел фазовой автоподстройки B к битам A */
const PLL_GAIN = 0.5;
const PLL_MAX = 0.05;
/** Если B в начале склейки сдвинут от бита больше чем на эту долю — один раз «довинчиваем» его перемоткой (B ещё почти неслышен) */
const HARD_SYNC_ERR = 0.05;
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
export class AudioEngine {
  private players: AudioPlayer[];
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

  constructor() {
    configureAudioSession();
    this.players = [0, 1].map(() => createAudioPlayer(null, { updateInterval: 100, keepAudioSessionActive: true }));
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
    this.players.forEach((p) => {
      const sub = p.addListener('playbackStatusUpdate', (s: AudioStatus) => this.onStatus(p, s));
      this.subs.push(sub);
    });
    this.timer = setInterval(this.tick, TICK_MS);

    // Синхронизация с физической громкостью телефона (кнопки iPhone и Центр управления)
    volumeService.addListener((vol) => {
      if (Date.now() - this.lastUserVolumeChangeAt < 400) return;
      if (Math.abs(this.state.volume - vol) >= 0.005) {
        this.set({ volume: vol });
        this.persist();
      }
    });
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
      queueIds = this.state.queue.map((t) => t.id).filter((id) => byId.has(id));
      for (const id of ordered) if (!queueIds.includes(id)) queueIds.push(id);
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
      this.A.replace({ uri: t.uri });
      this.A.setPlaybackRate(1, 'low');
      this.A.volume = 1;
    });
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

  private lastUserVolumeChangeAt = 0;

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
    if (volumeService.isAvailable()) {
      if (syncToDevice) volumeService.setVolume(volume);
      // плееры остаются на 1.0 — иначе громкость применилась бы дважды
    } else {
      if (syncToDevice) volumeService.setVolume(volume);
      if (!this.trans) {
        safe(() => {
          this.A.volume = volume;
        });
      }
    }
    this.persist();
  }

  /* ───────────── управление воспроизведением ───────────── */

  playIndex(index: number) {
    const t = this.state.queue[index];
    if (!t) return;
    if (this.trans) this.cancelTransition();
    this.mixBlockedFor = null;
    this.errorSkips = 0;
    this.playIntent = true;
    this.lastCommandAt = Date.now();
    safe(() => {
      this.B.pause();
      this.A.replace({ uri: t.uri });
      this.A.setPlaybackRate(1, 'low');
      this.A.volume = this.master();
      this.A.play();
    });
    this.prep = null;
    this.set({ index, isPlaying: true, duration: 0, player: this.A, mixing: false });
    this.updateLockScreen(this.A, t);
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
      safe(() => {
        this.A.pause();
        if (this.trans) this.trans.to.pause();
      });
      this.set({ isPlaying: false });
    } else {
      this.playIntent = true;
      safe(() => {
        this.A.play();
        if (this.trans) this.trans.to.play();
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
    const avg = plan.tempo ? plan.avgRateA : 1;
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
        idle.replace({ uri: nxt.uri });
        idle.volume = 0;
        idle.setPlaybackRate(1, 'low');
      });
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

  private tick = () => {
    if (!this.playIntent) return;
    const a = this.A;
    const pos = safe(() => a.currentTime) ?? 0;
    const dur = safe(() => a.duration) ?? 0;
    if (dur <= 0) return;

    if (this.trans) {
      this.driveTransition(pos, dur);
      return;
    }

    const X = this.dj.crossfadeDuration;
    if (!this.dj.crossfadeEnabled || this.state.repeat === 'one' || !this.currentTrack) return;
    if (this.mixBlockedFor === this.currentTrack.id) return;
    const nextIdx = this.nextIndexAuto();
    if (nextIdx === null || nextIdx === this.state.index) return;
    if (dur < X + 2) return;

    const cur = this.currentTrack;
    const nxt = this.state.queue[nextIdx];
    const plan = planMix(this.tempoOf(cur), this.tempoOf(nxt), this.dj.bpmTransitionEnabled);
    const remaining = dur - pos;
    const avg = plan.tempo ? plan.avgRateA : 1;

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
    safe(() => {
      idle.setPlaybackRate(initialRateB, 'low');
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
      lastRateA: 1,
      lastRateB: initialRateB,
      lastRateAt: now,
      corr: 0,
      hardSynced: false,
      holdUntilMs: 0,
      lastVolA: master,
      lastVolB: 0,
    };
    this.set({ mixing: true });
    this.onMixingChange(true);
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
    if (t.plan.tempo && p < 1 && now - t.lastRateAt >= RATE_STEP_MS) {
      const base = ratesAt(t.plan, p);
      let rateB = base.rateB;

      // Фазовая автоподстройка: сравниваем «долю бита» у A и у B и чуть подруливаем скорость B,
      // чтобы удары легли друг на друга (как при ручном питч-бенде у диджея)
      if (t.plan.beatSync && t.elapsedMs > 350 && t.elapsedMs >= t.holdUntilMs) {
        const tb = safe(() => t.to.currentTime);
        if (tb !== undefined && Number.isFinite(tb)) {
          const phiA = beatPhase(pos, t.plan.phaseA, t.plan.periodA);
          const phiB = beatPhase(tb, t.plan.phaseB, t.plan.periodB);
          const err = wrapHalf(phiA - phiB); // >0 — B отстаёт от бита
          if (!t.hardSynced) {
            t.hardSynced = true;
            if (Math.abs(err) > HARD_SYNC_ERR) {
              // B пока играет с громкостью ≈ 0 — перемотка на долю бита не слышна
              const target = Math.max(0, tb + err * t.plan.periodB);
              safe(() => t.to.seekTo(target));
              t.holdUntilMs = t.elapsedMs + 500;
              t.corr = 0;
            }
          } else {
            const target = clamp(err * PLL_GAIN, -PLL_MAX, PLL_MAX);
            t.corr += (target - t.corr) * 0.3;
          }
        }
      }
      rateB *= 1 + t.corr;

      if (Math.abs(base.rateA - t.lastRateA) >= 0.0025) {
        safe(() => t.from.setPlaybackRate(base.rateA, 'low'));
        t.lastRateA = base.rateA;
      }
      if (Math.abs(rateB - t.lastRateB) >= 0.0025) {
        safe(() => t.to.setPlaybackRate(rateB, 'low'));
        t.lastRateB = rateB;
      }
      t.lastRateAt = now;
    }

    if (p >= 0.5 && !t.uiSwitched) this.switchUiToIncoming();
    // A дошёл до конца файла — склейка завершена
    if (p >= 1 || pos >= dur - 0.06) this.commitTransition();
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
      t.to.setPlaybackRate(1.0, 'low');
      t.from.setPlaybackRate(1.0, 'low');
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
    this.onMixingChange(false);
    this.notifyTrackChange();
  }

  private cancelTransition() {
    const t = this.trans;
    if (!t) return;
    safe(() => {
      t.to.pause();
      t.to.volume = 0;
      t.to.setPlaybackRate(1.0, 'low');
      t.from.setPlaybackRate(1.0, 'low');
      t.from.volume = this.master();
    });
    this.trans = null;
    this.prep = null;
    this.mixBlockedFor = this.currentTrack?.id ?? null;
    this.set({ mixing: false, player: this.A });
    this.onMixingChange(false);
  }

  /* ───────────── экран блокировки и Dynamic Island ───────────── */

  private updateLockScreen(player: AudioPlayer, t: TrackFile) {
    safe(() =>
      player.setActiveForLockScreen(
        true,
        { title: t.title, artist: t.artist, albumTitle: t.album || 'Woufy', artworkUrl: t.artworkUri },
        { showNextTrack: true, showPreviousTrack: true, showSeekForward: true, showSeekBackward: true, isLiveStream: false }
      )
    );
  }

  dispose() {
    if (this.timer) clearInterval(this.timer);
    this.subs.forEach((s) => safe(() => s.remove()));
    this.players.forEach((p) => safe(() => p.remove()));
  }
}
