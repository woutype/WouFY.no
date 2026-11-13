import { createAudioPlayer, AudioPlayer } from 'expo-audio';
import { TrackFile } from '../types';
import { BpmRecord, BeatGridRecord, getState, patchState } from './library';
import { EnvelopeBuilder, estimateBpm, fitBeatGrid, mixedOnset, round3, HOP } from './bpmAnalyzer';

const WIN1_SEC = 20; // окно у начала трека: темп + фаза (нужна треку B — он входит с начала)
const WIN2_SEC = 14; // окно у конца трека: уточняет темп и даёт фазу рядом с местом склейки (трек A)
const STANDARD_RATES = [22050, 32000, 44100, 48000, 88200, 96000];
const PAUSED = Symbol('paused');

type Listener = () => void;

interface Window {
  energies: number[];
  lows: number[];
  sr: number;
  /** медиа-время начала первого хопа окна */
  c: number;
}

interface AnalysisResult {
  bpm: number;
  grid?: BeatGridRecord;
}

const median = (xs: number[]) => {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
};

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Хранит BPM и сетку битов треков: ручной > тег TBPM > авто-анализ.
 * Авто-анализ: «разведчик» — отдельный беззвучный плеер (volume 0) проигрывает два фрагмента
 * трека (у начала и у конца) и через аудио-семплы находит темп и положение битов.
 * По двум фрагментам темп уточняется до сотых долей BPM — сетка не «уплывает» за весь трек.
 * Во время DJ-склейки анализ приостанавливается, чтобы не нагружать процессор.
 */
class BpmService {
  private listeners = new Set<Listener>();
  private queue: TrackFile[] = [];
  private queued = new Set<string>();
  private failed = new Set<string>();
  private running = false;
  private paused = false;
  private tags = new Map<string, number>();
  /** растёт при каждом изменении — дёшево отслеживать из React */
  version = 0;

  subscribe(l: Listener) {
    this.listeners.add(l);
    return () => {
      this.listeners.delete(l);
    };
  }

  private emit() {
    this.version++;
    this.listeners.forEach((l) => l());
  }

  /** Пауза анализа (на время DJ-склейки) */
  setPaused(on: boolean) {
    this.paused = on;
    if (!on) this.pump();
  }

  registerTags(tracks: TrackFile[]) {
    this.tags.clear();
    for (const t of tracks) if (t.bpmTag) this.tags.set(t.id, t.bpmTag);
  }

  get(id: string): number | undefined {
    const rec = getState().bpm?.[id];
    if (rec?.source === 'manual') return rec.value;
    const tag = this.tags.get(id);
    if (tag) return tag;
    return rec?.value;
  }

  /** Сетка битов, согласованная с «официальным» BPM трека (иначе — undefined) */
  gridOf(id: string): BeatGridRecord | undefined {
    const g = getState().bpm?.[id]?.grid;
    if (!g) return undefined;
    const v = this.get(id);
    if (!v) return g;
    return Math.abs(g.bpm - v) / v < 0.04 ? g : undefined;
  }

  sourceOf(id: string): 'manual' | 'tag' | 'auto' | undefined {
    const rec = getState().bpm?.[id];
    if (rec?.source === 'manual') return 'manual';
    if (this.tags.get(id)) return 'tag';
    if (rec) return 'auto';
    return undefined;
  }

  setManual(id: string, value: number | null) {
    const bpm = { ...(getState().bpm ?? {}) };
    const prev = bpm[id];
    if (value === null) {
      if (prev?.grid) bpm[id] = { value: prev.grid.bpm, source: 'auto', grid: prev.grid };
      else delete bpm[id];
    } else {
      bpm[id] = { value, source: 'manual', grid: prev?.grid } as BpmRecord;
    }
    patchState({ bpm });
    this.emit();
  }

  private setAuto(id: string, res: AnalysisResult) {
    const bpm = { ...(getState().bpm ?? {}) };
    const prev = bpm[id];
    if (prev?.source === 'manual') {
      bpm[id] = { ...prev, grid: res.grid ?? prev.grid };
    } else {
      bpm[id] = { value: res.bpm, source: 'auto', grid: res.grid };
    }
    patchState({ bpm });
    this.emit();
  }

  /** Пауза анализа во время активного воспроизведения музыки */
  setActivePlayback(isPlaying: boolean) {
    this.setPaused(isPlaying);
  }

  /** Поставить трек в очередь анализа (если сетка битов ещё неизвестна). urgent — в начало очереди. */
  request(track: TrackFile | undefined, urgent = false) {
    if (!track) return;
    if (this.tags.has(track.id) || track.bpmTag) return;
    if (getState().bpm?.[track.id]?.grid || this.failed.has(track.id)) return;
    if (this.queued.has(track.id)) {
      if (urgent) {
        this.queue = [track, ...this.queue.filter((t) => t.id !== track.id)];
      }
      return;
    }
    this.queued.add(track.id);
    if (urgent) this.queue.unshift(track);
    else this.queue.push(track);
    this.pump();
  }

  private async pump() {
    if (this.running) return;
    this.running = true;
    try {
      while (this.queue.length > 0) {
        if (this.paused) {
          await wait(400);
          continue;
        }
        const t = this.queue[0];
        let res: AnalysisResult | null | typeof PAUSED = null;
        try {
          res = await this.analyze(t);
        } catch (e) {
          console.warn('[bpm] analyze failed', t.title, e);
        }
        if (res === PAUSED) continue; // трек остаётся в очереди — повторим после склейки
        this.queue.shift();
        this.queued.delete(t.id);
        if (res) this.setAuto(t.id, res);
        else this.failed.add(t.id);
      }
    } finally {
      this.running = false;
    }
  }

  private analyze(track: TrackFile): Promise<AnalysisResult | null | typeof PAUSED> {
    return new Promise((resolve) => {
      let player: AudioPlayer | null = null;
      let done = false;
      let sub: { remove: () => void } | null = null;
      let current: { env: EnvelopeBuilder; marks: { x: number; y: number }[] } | null = null;

      const finish = (value: AnalysisResult | null | typeof PAUSED) => {
        if (done) return;
        done = true;
        clearTimeout(guard);
        try {
          sub?.remove();
          player?.setAudioSamplingEnabled(false);
          player?.pause();
          player?.remove();
        } catch {
          /* ignore */
        }
        resolve(value);
      };

      const guard = setTimeout(() => finish(null), 90000);
      const knownBpm = this.get(track.id);

      /** Проигрывает [start, start+len] беззвучно и собирает огибающие энергии + привязку ко времени трека */
      const sampleWindow = async (p: AudioPlayer, start: number, len: number): Promise<Window | null> => {
        const env = new EnvelopeBuilder(44100);
        const marks: { x: number; y: number }[] = [];
        current = { env, marks };
        try {
          p.pause();
          await p.seekTo(start);
        } catch {
          /* продолжаем — позиция всё равно читается из плеера */
        }
        p.play();
        const began = Date.now();
        while (!done && !this.paused) {
          const t = p.currentTime ?? 0;
          if (t >= start + len) break;
          if (Date.now() - began > len * 1000 * 1.8 + 3000) break;
          await wait(200);
        }
        p.pause();
        current = null;
        if (done) return null;
        if (this.paused) return null;
        if (marks.length < 4 || env.energies.length < Math.ceil(6 / (HOP / 44100))) return null;

        // фактическая частота дискретизации по счётчику фреймов за время трека
        const first = marks[0];
        const last = marks[marks.length - 1];
        const dy = last.y - first.y;
        let sr = dy > 3 ? (last.x - first.x) / dy : 44100;
        let nearest = 44100;
        for (const s of STANDARD_RATES) if (Math.abs(s - sr) < Math.abs(nearest - sr)) nearest = s;
        sr = Math.abs(nearest - sr) / nearest < 0.08 ? nearest : 44100;
        // привязка кадров к времени трека; медиана устойчива к запоздавшим колбэкам
        const c = median(marks.map((m) => m.y - m.x / sr));
        return { energies: env.energies, lows: env.lows, sr, c };
      };

      (async () => {
        try {
          player = createAudioPlayer(null, { updateInterval: 250 });
          const p = player;
          if (!p.isAudioSamplingSupported) return finish(null);
          p.volume = 0;
          p.replace({ uri: track.uri });

          for (let i = 0; i < 60 && !p.isLoaded; i++) await wait(100);
          if (!p.isLoaded) return finish(null);

          const dur = p.duration || 0;
          if (dur < 14) return finish(null);

          p.setAudioSamplingEnabled(true);
          sub = p.addListener('audioSampleUpdate', (s) => {
            const ch = s.channels?.[0]?.frames;
            if (!ch || ch.length === 0 || !current) return;
            current.env.push(ch);
            current.marks.push({ x: current.env.totalFrames, y: p.currentTime ?? 0 });
          });

          const w1Start = dur > 90 ? Math.min(30, dur * 0.2) : 0;
          const w1Len = Math.min(WIN1_SEC, dur - w1Start - 1);
          const w1 = await sampleWindow(p, w1Start, w1Len);
          if (done) return;
          if (!w1) return finish(this.paused ? PAUSED : null);

          const dt1 = HOP / w1.sr;
          const onset1 = mixedOnset(w1.energies, w1.lows);

          // центр поиска темпа: известный BPM (тег / вручную) или оценка по автокорреляции
          let center = knownBpm;
          if (!center) {
            const est = estimateBpm(w1.energies, w1.sr);
            if (!est || est.confidence <= 1.15) return finish(null);
            center = est.bpm;
          }
          const fit1 = fitBeatGrid(onset1, dt1, center * 0.985, center * 1.015, 0.02);
          if (!fit1) return finish(null);

          const p1 = 60 / fit1.bpm;
          const a1 = w1.c + fit1.offset; // момент первого бита в окне 1 (время трека)
          let bpm = fit1.bpm;
          let anchor = a1;

          // ── второе окно у конца трека: уточняем темп и привязываем сетку к месту склейки ──
          const w2Start = dur - 34;
          if (dur >= 100 && w2Start > w1Start + w1Len + 10) {
            const w2 = await sampleWindow(p, w2Start, WIN2_SEC);
            if (done) return;
            if (!w2 && this.paused) return finish(PAUSED);
            if (w2) {
              const dt2 = HOP / w2.sr;
              const fit2 = fitBeatGrid(mixedOnset(w2.energies, w2.lows), dt2, fit1.bpm * 0.996, fit1.bpm * 1.004, 0.01);
              if (fit2) {
                const a2 = w2.c + fit2.offset;
                const delta = a2 - a1;
                const n = Math.round(delta / p1);
                if (n >= 8) {
                  const pRef = delta / n;
                  if (Math.abs(pRef - p1) / p1 < 0.01) {
                    bpm = 60 / pRef;
                    anchor = a1;
                  }
                }
              }
            }
          }

          const period = 60 / bpm;
          const phase = ((anchor % period) + period) % period;
          finish({
            bpm: Math.round((knownBpm ?? bpm) * 10) / 10,
            grid: { bpm: round3(bpm), phase: round3(phase) },
          });
        } catch (e) {
          console.warn('[bpm] scout error', e);
          finish(null);
        }
      })();
    });
  }
}

export const bpmService = new BpmService();
