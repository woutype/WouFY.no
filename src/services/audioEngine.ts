import { createAudioPlayer, AudioPlayer, AudioStatus } from 'expo-audio';
import { DJSettings, DEFAULT_DJ, RepeatMode, TrackFile } from '../types';
import { planMix, ratesAt, volumesAt, MixPlan } from './djMix';
import { configureAudioSession } from './audioService';

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
  /** «медиа-секунд» до конца A, с которых идёт склейка */
  trigger: number;
  uiSwitched: boolean;
  lastRateAt: number;
  lastRateA: number;
  lastRateB: number;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const TICK_MS = 50;

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
  private preloadedId: string | null = null;
  private mixBlockedFor: string | null = null;
  private playIntent = false;
  private lastCommandAt = 0;
  private errorSkips = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private subs: { remove: () => void }[] = [];
  private bpmLookup: (t: TrackFile) => number | undefined = () => undefined;
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
    onTrackChange?: (cur: TrackFile | undefined, upcoming: (TrackFile | undefined)[]) => void;
    onPersist?: (s: { order: string[]; shuffle: boolean; repeat: RepeatMode; volume: number; lastTrackId?: string }) => void;
  }) {
    if (opts.bpmLookup) this.bpmLookup = opts.bpmLookup;
    if (opts.onTrackChange) this.onTrackChange = opts.onTrackChange;
    if (opts.onPersist) this.onPersist = opts.onPersist;
  }

  setDJ(dj: DJSettings) {
    this.dj = dj;
    if (!dj.crossfadeEnabled && this.trans) this.cancelTransition();
    this.preloadedId = null;
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
      this.A.setPlaybackRate(1, 'high');
      this.A.volume = this.state.volume;
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
    this.preloadedId = null;
    this.set({ queue: q, index });
    this.persist();
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
    this.preloadedId = null;
    this.persist();
    this.onTrackChange(this.currentTrack, this.upcoming());
  }

  setRepeat(mode: RepeatMode) {
    this.set({ repeat: mode });
    this.persist();
  }

  setVolume(v: number) {
    const volume = clamp(v, 0, 1);
    this.set({ volume });
    if (!this.trans) safe(() => (this.A.volume = volume));
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
      this.A.setPlaybackRate(1, 'high');
      this.A.volume = this.state.volume;
      this.A.play();
    });
    this.preloadedId = null;
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
    if (dur < X * 2.5 + 2) return;

    const cur = this.currentTrack;
    const nxt = this.state.queue[nextIdx];
    const plan = planMix(this.bpmLookup(cur), this.bpmLookup(nxt), X, this.dj.bpmTransitionEnabled);
    const remaining = dur - pos;
    if (remaining > plan.triggerRemaining + 14) return;

    // предзагрузка следующего трека в свободный плеер (тихо, на паузе)
    const idle = this.B;
    if (this.preloadedId !== nxt.id) {
      safe(() => {
        idle.pause();
        idle.replace({ uri: nxt.uri });
        idle.volume = 0;
        idle.setPlaybackRate(1, 'high');
      });
      this.preloadedId = nxt.id;
    }
    if (remaining > plan.triggerRemaining || pos < 1) return;

    // время склейки
    const loaded = safe(() => idle.isLoaded) ?? false;
    const p0 = clamp(1 - remaining / plan.triggerRemaining, 0, 1);
    if (!loaded || p0 > 0.4) {
      if (remaining < plan.triggerRemaining * 0.55) this.mixBlockedFor = cur.id; // не успели — обычный переход
      return;
    }

    const { rateB } = ratesAt(plan, p0);
    const { volB } = volumesAt(p0, this.dj.fadeVolumeEnabled);
    safe(() => {
      idle.setPlaybackRate(rateB, 'high');
      idle.volume = volB * this.state.volume;
      idle.play();
    });
    this.trans = {
      from: a,
      to: idle,
      toId: nxt.id,
      plan,
      trigger: plan.triggerRemaining,
      uiSwitched: false,
      lastRateAt: 0,
      lastRateA: 1,
      lastRateB: rateB,
    };
    this.set({ mixing: true });
  };

  private driveTransition(pos: number, dur: number) {
    const t = this.trans!;
    const remaining = dur - pos;
    const aStopped = !(safe(() => t.from.playing) ?? true);
    const ended = remaining <= 0.03 || (aStopped && remaining < 0.35);
    const p = ended ? 1 : clamp(1 - remaining / t.trigger, 0, 1);

    const { volA, volB } = volumesAt(p, this.dj.fadeVolumeEnabled);
    const master = this.state.volume;
    safe(() => {
      t.from.volume = volA * master;
      t.to.volume = volB * master;
    });

    const now = Date.now();
    if (t.plan.tempo && now - t.lastRateAt >= 100) {
      const { rateA, rateB } = ratesAt(t.plan, p);
      if (Math.abs(rateA - t.lastRateA) > 0.002) {
        safe(() => t.from.setPlaybackRate(rateA, 'high'));
        t.lastRateA = rateA;
      }
      if (Math.abs(rateB - t.lastRateB) > 0.002) {
        safe(() => t.to.setPlaybackRate(rateB, 'high'));
        t.lastRateB = rateB;
      }
      t.lastRateAt = now;
    }

    if (p >= 0.5 && !t.uiSwitched) this.switchUiToIncoming();
    if (p >= 1) this.commitTransition();
  }

  /** На середине склейки обложка/название/текст переключаются на новый трек */
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
    this.notifyTrackChange();
  }

  /** Завершает склейку: B становится основным, A останавливается */
  private commitTransition() {
    const t = this.trans;
    if (!t) return;
    if (!t.uiSwitched) this.switchUiToIncoming();
    const master = this.state.volume;
    safe(() => {
      t.from.pause();
      t.from.volume = 0;
      t.to.setPlaybackRate(1, 'high');
      t.to.volume = master;
    });
    safe(() => t.from.seekTo(0));
    this.active = this.players.indexOf(t.to);
    this.trans = null;
    this.preloadedId = null;
    this.mixBlockedFor = null;
    this.lastCommandAt = Date.now();
    this.set({ mixing: false, player: t.to, isPlaying: this.playIntent });
  }

  private cancelTransition() {
    const t = this.trans;
    if (!t) return;
    safe(() => {
      t.to.pause();
      t.to.volume = 0;
      t.from.volume = this.state.volume;
      t.from.setPlaybackRate(1, 'high');
    });
    this.trans = null;
    this.preloadedId = null;
    this.mixBlockedFor = this.currentTrack?.id ?? null;
    this.set({ mixing: false, player: this.A });
  }

  /* ───────────── экран блокировки ───────────── */

  private updateLockScreen(player: AudioPlayer, t: TrackFile) {
    safe(() =>
      player.setActiveForLockScreen(
        true,
        { title: t.title, artist: t.artist, albumTitle: t.album || 'Woufy', artworkUrl: t.artworkUri },
        // next/prev для одиночного AudioPlayer в expo-audio не доставляются в JS — не показываем «мёртвые» кнопки
        { showNextTrack: false, showPreviousTrack: false, showSeekForward: false, showSeekBackward: false, isLiveStream: false }
      )
    );
  }

  dispose() {
    if (this.timer) clearInterval(this.timer);
    this.subs.forEach((s) => safe(() => s.remove()));
    this.players.forEach((p) => safe(() => p.remove()));
  }
}
