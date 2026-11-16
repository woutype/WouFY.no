import * as FileSystem from 'expo-file-system/legacy';
import { DATA_DIR, ensureDataDir } from './library';
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

class StatsService {
  private sessions: PlaySession[] = [];
  private loaded = false;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private lastLiveNotifyAt = 0;
  private currentPlayStart: {
    track: TrackFile;
    startAt: number;
    posStart: number;
    lastPos: number;
    duration: number;
  } | null = null;

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
        this.sessions = JSON.parse(raw);
      }
    } catch (e) {
      console.warn('[StatsService] load failed:', e);
      this.sessions = [];
    }
    this.loaded = true;
    this.notify();
  }

  private scheduleSave() {
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
    }, 1200);
  }

  /** Вызывается движком при старте трека */
  onTrackStart(track: TrackFile, duration: number, position = 0) {
    this.finalizeCurrent();
    this.currentPlayStart = {
      track,
      startAt: Date.now(),
      posStart: position,
      lastPos: position,
      duration,
    };
    this.lastLiveNotifyAt = Date.now();
    this.notify();
  }

  /** Вызывается движком при обновлении позиции трека */
  onTrackPosition(position: number) {
    if (!this.currentPlayStart) return;
    const cur = this.currentPlayStart;
    cur.lastPos = Math.max(cur.lastPos, position);
    const now = Date.now();
    const elapsedWall = (now - cur.startAt) / 1000;
    const deltaPos = Math.max(0, cur.lastPos - cur.posStart);
    const listened = Math.min(elapsedWall, deltaPos > 0 ? deltaPos + 1 : elapsedWall);

    // Как только трек проиграл 2 секунды, обновляем слушателей, чтобы он появился в Топе вживую
    if (listened >= 2 && now - this.lastLiveNotifyAt > 2500) {
      this.lastLiveNotifyAt = now;
      this.notify();
    }
  }

  /** Завершение текущей сессии (смена трека, пауза, выход) */
  finalizeCurrent() {
    if (!this.currentPlayStart) return;
    const cur = this.currentPlayStart;
    this.currentPlayStart = null;

    const elapsedWall = (Date.now() - cur.startAt) / 1000;
    const deltaPos = Math.max(0, cur.lastPos - cur.posStart);
    const listened = Math.min(elapsedWall, deltaPos > 0 ? deltaPos + 1 : elapsedWall);

    if (listened < 2) return;

    const dur = cur.duration > 0 ? cur.duration : 180;
    const isCompleted = listened >= dur * 0.75 || cur.lastPos >= dur - 5;
    const isSkipped = !isCompleted && (listened < 18 || listened / dur < 0.15);

    this.sessions.push({
      trackId: cur.track.id,
      artist: cur.track.artist,
      title: cur.track.title,
      album: cur.track.album,
      artworkUri: cur.track.artworkUri,
      timestamp: Date.now(),
      durationListened: Math.round(listened),
      completed: isCompleted,
      skipped: isSkipped,
    });

    this.notify();
    this.scheduleSave();
  }

  /** Вычисление веса трека для Smart Shuffle */
  getTrackWeight(trackId: string): number {
    let plays = 0;
    let skips = 0;
    const cutoff = Date.now() - 30 * 86400 * 1000;

    for (let i = this.sessions.length - 1; i >= 0; i--) {
      const s = this.sessions[i];
      if (s.timestamp < cutoff) break;
      if (s.trackId === trackId) {
        if (s.completed || s.durationListened >= 45) plays++;
        else if (s.skipped) skips++;
      }
    }

    const weight = 1.0 + plays * 0.8 - skips * 0.5;
    return Math.max(0.15, Math.min(8.0, weight));
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
      const elapsedWall = (now - cur.startAt) / 1000;
      const deltaPos = Math.max(0, cur.lastPos - cur.posStart);
      const listened = Math.min(elapsedWall, deltaPos > 0 ? deltaPos + 1 : elapsedWall);
      if (listened >= 2) {
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
