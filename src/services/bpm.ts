import { createAudioPlayer, AudioPlayer } from 'expo-audio';
import { TrackFile } from '../types';
import { BpmRecord, getState, patchState } from './library';
import { EnvelopeBuilder, estimateBpm } from './bpmAnalyzer';

const ANALYZE_SECONDS = 22;
const STANDARD_RATES = [22050, 32000, 44100, 48000, 88200, 96000];

type Listener = () => void;

/**
 * Хранит BPM треков: ручной > тег TBPM > авто-анализ.
 * Авто-анализ: «разведчик» — отдельный беззвучный плеер (volume 0) проигрывает фрагмент
 * трека и через аудио-семплы определяет темп. Одновременно работает один разведчик.
 */
class BpmService {
  private listeners = new Set<Listener>();
  private queue: TrackFile[] = [];
  private queued = new Set<string>();
  private failed = new Set<string>();
  private running = false;
  private tags = new Map<string, number>();

  subscribe(l: Listener) {
    this.listeners.add(l);
    return () => {
      this.listeners.delete(l);
    };
  }

  private emit() {
    this.listeners.forEach((l) => l());
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

  sourceOf(id: string): 'manual' | 'tag' | 'auto' | undefined {
    const rec = getState().bpm?.[id];
    if (rec?.source === 'manual') return 'manual';
    if (this.tags.get(id)) return 'tag';
    if (rec) return 'auto';
    return undefined;
  }

  setManual(id: string, value: number | null) {
    const bpm = { ...(getState().bpm ?? {}) };
    if (value === null) delete bpm[id];
    else bpm[id] = { value, source: 'manual' } as BpmRecord;
    patchState({ bpm });
    this.emit();
  }

  private setAuto(id: string, value: number) {
    const bpm = { ...(getState().bpm ?? {}) };
    if (bpm[id]?.source === 'manual') return;
    bpm[id] = { value, source: 'auto' };
    patchState({ bpm });
    this.emit();
  }

  /** Поставить трек в очередь анализа (если BPM ещё неизвестен). urgent — в начало очереди. */
  request(track: TrackFile | undefined, urgent = false) {
    if (!track) return;
    if (this.get(track.id) || this.failed.has(track.id) || this.queued.has(track.id)) return;
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
        const t = this.queue.shift()!;
        this.queued.delete(t.id);
        if (this.get(t.id)) continue;
        try {
          const bpm = await this.analyze(t);
          if (bpm) this.setAuto(t.id, bpm);
          else this.failed.add(t.id);
        } catch (e) {
          console.warn('[bpm] analyze failed', t.title, e);
          this.failed.add(t.id);
        }
      }
    } finally {
      this.running = false;
    }
  }

  private analyze(track: TrackFile): Promise<number | null> {
    return new Promise((resolve) => {
      let player: AudioPlayer | null = null;
      let done = false;
      let sub: { remove: () => void } | null = null;
      const env = new EnvelopeBuilder();
      let firstAt = 0;
      let lastAt = 0;

      const finish = (value: number | null) => {
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

      const guard = setTimeout(() => finish(null), 60000);

      (async () => {
        try {
          player = createAudioPlayer(null, { updateInterval: 500 });
          if (!player.isAudioSamplingSupported) return finish(null);
          player.volume = 0;
          player.replace({ uri: track.uri });

          // ждём загрузки
          for (let i = 0; i < 50 && !player.isLoaded; i++) await new Promise((r) => setTimeout(r, 100));
          if (!player.isLoaded) return finish(null);

          const dur = player.duration || 0;
          const start = dur > ANALYZE_SECONDS * 2 ? Math.min(30, dur * 0.25) : 0;
          if (start > 0) await player.seekTo(start);

          player.setAudioSamplingEnabled(true);
          sub = player.addListener('audioSampleUpdate', (s) => {
            const ch = s.channels?.[0]?.frames;
            if (!ch || ch.length === 0) return;
            const now = Date.now();
            if (!firstAt) firstAt = now;
            lastAt = now;
            env.push(ch);
          });

          player.play();

          // сэмплируем ~ANALYZE_SECONDS секунд реального времени
          const startedAt = Date.now();
          while (Date.now() - startedAt < ANALYZE_SECONDS * 1000 && !done) {
            await new Promise((r) => setTimeout(r, 250));
          }
          if (done) return;

          // частота дискретизации: по счётчику фреймов за реальное время (timestamp у tap всегда 0)
          const elapsed = (lastAt - firstAt) / 1000;
          let sr = elapsed > 5 ? env.totalFrames / elapsed : 44100;
          let nearest = 44100;
          for (const s of STANDARD_RATES) if (Math.abs(s - sr) < Math.abs(nearest - sr)) nearest = s;
          sr = Math.abs(nearest - sr) / nearest < 0.08 ? nearest : 44100;

          const est = estimateBpm(env.energies, sr);
          finish(est && est.confidence > 1.15 ? est.bpm : null);
        } catch (e) {
          console.warn('[bpm] scout error', e);
          finish(null);
        }
      })();
    });
  }
}

export const bpmService = new BpmService();
