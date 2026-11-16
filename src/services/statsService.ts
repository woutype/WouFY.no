import * as FileSystem from 'expo-file-system/legacy';
import { DATA_DIR, ensureDataDir, normalizeTrackId, resolveDataDir } from './library';
import { splitArtists, UNKNOWN_ARTIST } from './queueOrder';
import { TrackFile } from '../types';

export interface PlaySession {
  trackId: string;
  artist: string;
  title: string;
  album?: string;
  artworkUri?: string;
  timestamp: number;
  durationListened: number; // секунды
  completed: boolean;
  skipped: boolean;
}

export interface TrackStatsSummary {
  trackId: string;
  title: string;
  artist: string;
  artworkUri?: string;
  playCount: number;
  totalDuration: number; // секунды
}

export interface ArtistStatsSummary {
  artist: string;
  playCount: number;
  totalDuration: number; // секунды
  trackCount: number;
}

export type StatsPeriod = '3days' | 'week' | 'month';

const STATS_FILE = `${DATA_DIR}listening_stats.json`;
const MAX_SESSIONS = 5000;
/** скип раньше этого порога (сек) — «ранний»: сильно понижает вес трека в Smart Shuffle */
const EARLY_SKIP_SEC = 10;
/** пауза → продолжение с той же позиции в пределах окна считается одним прослушиванием */
const RESUME_WINDOW_MS = 30 * 60 * 1000;

class StatsService {
  private sessions: PlaySession[] = [];
  private loaded = false;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private lastLiveNotifyAt = 0;
  private currentPlayStart: {
    track: TrackFile;
    /** накопленные реально проигранные секунды */
    listened: number;
    /** предыдущая позиция/время тика — для расчёта прироста */
    prevPos: number;
    prevAt: number;
    /** максимальная достигнутая позиция */
    lastPos: number;
    duration: number;
    /** сессия, которую продолжаем после паузы (не создаём новое «прослушивание») */
    resumeOf?: PlaySession;
  } | null = null;
  private lastSess: { s: PlaySession; endPos: number } | null = null;

  version = 0;
  private listeners = new Set<() => void>();

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notify() {
    this.version++;
    this.listeners.forEach((l) => l());
  }

  async load(): Promise<void> {
    if (this.loaded) return;
    try {
      await ensureDataDir();
      const info = await FileSystem.getInfoAsync(STATS_FILE);
      if (info.exists) {
        const raw = await FileSystem.readAsStringAsync(STATS_FILE);
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) {
          const dataDir = resolveDataDir();
          this.sessions = parsed.map((s: PlaySession) => {
            const coverName = s.artworkUri ? s.artworkUri.split('/').pop() : undefined;
            return {
              ...s,
              trackId: normalizeTrackId(s.trackId),
              artworkUri: coverName ? `${dataDir}covers/${coverName}` : undefined,
            };
          });
        }
      }
    } catch (e) {
      console.warn('[StatsService] load failed:', e);
      this.sessions = [];
    }
    this.loaded = true;
    this.notify();
  }

  private scheduleSave(delay = 1200) {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(async () => {
      try {
        await ensureDataDir();
        if (this.sessions.length > MAX_SESSIONS) {
          this.sessions = this.sessions.slice(-MAX_SESSIONS);
        }
        await FileSystem.writeAsStringAsync(STATS_FILE, JSON.stringify(this.sessions));
      } catch (e) {
        console.warn('[StatsService] save failed:', e);
      }
    }, delay);
  }

  /** Реально прослушанные секунды (включая ещё не зачтённый хвост до последнего тика) */
  private calcListened(cur: { listened: number }): number {
    return cur.listened;
  }

  private classify(listened: number, duration: number, lastPos: number, paused: boolean) {
    const dur = duration > 0 ? duration : 180;
    // «доскроллил в конец» не считается дослушиванием
    const completed = listened >= dur * 0.75 || (lastPos >= dur - 5 && listened >= Math.min(dur * 0.5, 30));
    // пауза пользователя — не скип
    const skipped = !completed && !paused && (listened < 18 || listened / dur < 0.15);
    return { completed, skipped };
  }

  /** Сколько секунд реально прослушано в текущей сессии трека (null — трек не отслеживается) */
  currentListened(trackId: string): number | null {
    const cur = this.currentPlayStart;
    return cur && cur.track.id === trackId ? cur.listened : null;
  }

  /** Трек уже отслеживается (идёт сессия) — повторный старт не нужен */
  isTracking(trackId: string): boolean {
    return this.currentPlayStart?.track.id === trackId;
  }

  /** Вызывается движком при старте трека */
  onTrackStart(track: TrackFile, duration: number, position = 0) {
    this.finalizeCurrent();
    const now = Date.now();
    const last = this.lastSess;
    const resumeOf =
      last &&
      last.s.trackId === track.id &&
      position > 0.5 &&
      Math.abs(position - last.endPos) < 3 &&
      now - last.s.timestamp < RESUME_WINDOW_MS &&
      this.sessions.includes(last.s)
        ? last.s
        : undefined;
    this.currentPlayStart = {
      track,
      listened: 0,
      prevPos: position,
      prevAt: now,
      lastPos: position,
      duration,
      resumeOf,
    };
    this.lastLiveNotifyAt = now;
    this.notify();
  }

  /** Вызывается движком при обновлении позиции трека (duration — реальная длительность, когда она известна) */
  onTrackPosition(position: number, duration?: number) {
    if (!this.currentPlayStart) return;
    const cur = this.currentPlayStart;
    if (duration && duration > 0) cur.duration = duration;
    const now = Date.now();
    // прирост позиции засчитываем только если он правдоподобен по реальному времени:
    // перемотки, сброс позиции и «чужая» позиция предыдущего трека (скачки) не считаются прослушиванием
    const dp = position - cur.prevPos;
    const dt = (now - cur.prevAt) / 1000;
    if (dp > 0 && dp <= dt * 1.3 + 0.75) cur.listened += Math.min(dp, dt * 1.3 + 0.75);
    cur.prevPos = position;
    cur.prevAt = now;
    cur.lastPos = Math.max(cur.lastPos, position);
    const listened = this.calcListened(cur);

    // Как только трек проиграл 2 секунды, обновляем слушателей, чтобы он появился в Топе вживую
    if (listened >= 2 && now - this.lastLiveNotifyAt > 2500) {
      this.lastLiveNotifyAt = now;
      this.notify();
    }
  }

  /** Завершение текущей сессии (смена трека, пауза, выход). paused=true — остановка пользователем, не скип */
  finalizeCurrent(paused = false) {
    if (!this.currentPlayStart) return;
    const cur = this.currentPlayStart;
    this.currentPlayStart = null;

    const now = Date.now();
    const listened = this.calcListened(cur);
    if (listened < (cur.resumeOf ? 0.5 : 2)) return;

    if (cur.resumeOf) {
      const s = cur.resumeOf;
      s.durationListened += Math.round(listened);
      s.timestamp = now;
      Object.assign(s, this.classify(s.durationListened, cur.duration, cur.lastPos, paused));
      this.lastSess = { s, endPos: cur.prevPos };
    } else {
      const s: PlaySession = {
        trackId: cur.track.id,
        artist: cur.track.artist,
        title: cur.track.title,
        album: cur.track.album,
        artworkUri: cur.track.artworkUri,
        timestamp: now,
        durationListened: Math.round(listened),
        ...this.classify(listened, cur.duration, cur.lastPos, paused),
      };
      this.sessions.push(s);
      this.lastSess = { s, endPos: cur.prevPos };
    }

    this.notify();
    this.scheduleSave();
  }

  /** Сохраняет накопленное, не обрывая играющий трек (сворачивание приложения) */
  checkpoint() {
    const cur = this.currentPlayStart;
    if (!cur) return;
    const { track, duration, prevPos } = cur;
    this.finalizeCurrent(true);
    this.onTrackStart(track, duration, prevPos);
    this.scheduleSave(0);
  }

  /**
   * Веса треков для Smart Shuffle за один проход по истории (30 дней):
   * дослушал → +0.8, скип в первые EARLY_SKIP_SEC секунд → −0.6, поздний скип → −0.3, ≥45 с → +0.4.
   */
  getTrackWeights(): Map<string, number> {
    const weights = new Map<string, number>();
    const cutoff = Date.now() - 30 * 86400 * 1000;
    for (const s of this.sessions) {
      if (s.timestamp < cutoff) continue;
      let d = 0;
      if (s.completed) d = 0.8;
      else if (s.durationListened < EARLY_SKIP_SEC) d = -0.6;
      else if (s.skipped) d = -0.3;
      else if (s.durationListened >= 45) d = 0.4;
      weights.set(s.trackId, (weights.get(s.trackId) ?? 1) + d);
    }
    for (const [id, w] of weights) weights.set(id, Math.max(0.15, Math.min(8.0, w)));
    return weights;
  }

  /** Фильтрация сессий по периоду (включая активный играющий трек в реальном времени) */
  private filterSessions(period: StatsPeriod): PlaySession[] {
    const now = Date.now();
    let ms = 3 * 86400 * 1000;
    if (period === 'week') ms = 7 * 86400 * 1000;
    if (period === 'month') ms = 30 * 86400 * 1000;
    const cutoff = now - ms;

    const list = this.sessions.filter((s) => s.timestamp >= cutoff);

    // Добавляем текущий играющий трек в реальном времени, если он играет хотя бы 2 сек
    if (this.currentPlayStart) {
      const cur = this.currentPlayStart;
      const listened = this.calcListened(cur);
      const idx = cur.resumeOf ? list.indexOf(cur.resumeOf) : -1;
      if (idx >= 0) {
        // продолжение после паузы: то же прослушивание, без лишнего +1 к playCount
        list[idx] = { ...cur.resumeOf!, durationListened: cur.resumeOf!.durationListened + Math.round(listened) };
      } else if (listened >= 2) {
        list.push({
          trackId: cur.track.id,
          artist: cur.track.artist,
          title: cur.track.title,
          album: cur.track.album,
          artworkUri: cur.track.artworkUri,
          timestamp: now,
          durationListened: Math.round(listened),
          completed: false,
          skipped: false,
        });
      }
    }

    return list;
  }

  /** Топ-10 треков за период */
  getTopTracks(period: StatsPeriod, limit = 10): TrackStatsSummary[] {
    const list = this.filterSessions(period);
    const map = new Map<string, TrackStatsSummary>();

    for (const s of list) {
      let rec = map.get(s.trackId);
      if (!rec) {
        rec = {
          trackId: s.trackId,
          title: s.title,
          artist: s.artist,
          artworkUri: s.artworkUri,
          playCount: 0,
          totalDuration: 0,
        };
        map.set(s.trackId, rec);
      }
      rec.playCount += 1;
      rec.totalDuration += s.durationListened;
      if (s.artworkUri && !rec.artworkUri) rec.artworkUri = s.artworkUri;
    }

    return Array.from(map.values())
      .sort((a, b) => b.playCount - a.playCount || b.totalDuration - a.totalDuration)
      .slice(0, limit);
  }

  /** Топ-10 артистов за период с корректным разбиением дуэтов */
  getTopArtists(period: StatsPeriod, limit = 10): ArtistStatsSummary[] {
    const list = this.filterSessions(period);
    const map = new Map<string, { playCount: number; totalDuration: number; trackIds: Set<string> }>();

    for (const s of list) {
      const artists = splitArtists(s.artist);
      for (const a of artists) {
        if (!a || a === UNKNOWN_ARTIST) continue;
        let rec = map.get(a);
        if (!rec) {
          rec = { playCount: 0, totalDuration: 0, trackIds: new Set() };
          map.set(a, rec);
        }
        rec.playCount += 1;
        rec.totalDuration += s.durationListened;
        rec.trackIds.add(s.trackId);
      }
    }

    return Array.from(map.entries())
      .map(([artist, data]) => ({
        artist,
        playCount: data.playCount,
        totalDuration: data.totalDuration,
        trackCount: data.trackIds.size,
      }))
      .sort((a, b) => b.totalDuration - a.totalDuration || b.playCount - a.playCount)
      .slice(0, limit);
  }

  /** Сброс статистики по конкретному треку (удаление из Топ-10 и истории) */
  resetTrackStats(trackId: string) {
    if (this.currentPlayStart?.track.id === trackId) {
      this.currentPlayStart = null;
    }
    this.sessions = this.sessions.filter((s) => s.trackId !== trackId);
    this.notify();
    this.scheduleSave();
  }

  /** Сброс статистики по артисту (удаление всех его прослушиваний из Топ-10) */
  resetArtistStats(artistName: string) {
    const target = artistName.trim().toLowerCase();
    if (this.currentPlayStart) {
      const curArtists = splitArtists(this.currentPlayStart.track.artist).map((a) => a.trim().toLowerCase());
      if (curArtists.includes(target)) {
        this.currentPlayStart = null;
      }
    }
    this.sessions = this.sessions.filter((s) => {
      const artists = splitArtists(s.artist).map((a) => a.trim().toLowerCase());
      return !artists.includes(target);
    });
    this.notify();
    this.scheduleSave();
  }

  /** Удаление из статистики записей о несуществующих/удалённых файлах */
  cleanupOrphanSessions(validTrackIds: Set<string>) {
    const before = this.sessions.length;
    this.sessions = this.sessions.filter((s) => validTrackIds.has(s.trackId));
    if (this.sessions.length !== before) {
      this.notify();
      this.scheduleSave();
    }
  }
}

export const statsService = new StatsService();
