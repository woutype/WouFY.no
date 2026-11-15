import * as FileSystem from 'expo-file-system/legacy';
import { DJSettings, FxSettings, RepeatMode, TrackFile } from '../types';

/**
 * Небольшое JSON-хранилище состояния приложения.
 *
 * Служебные данные (состояние, кэш библиотеки, кэш текстов) лежат В ОТДЕЛЬНОЙ папке
 * Library/Application Support/WouFY — вне Documents, поэтому в «Файлах» и в папке Music
 * не появляется никакого мусора. Если системная папка недоступна, используется скрытая `.woufy`.
 */
/** Сетка битов трека: биты стоят в моменты phase + k·60/bpm (секунды от начала файла) */
export interface BeatGridRecord {
  bpm: number;
  phase: number;
}

export interface BpmRecord {
  value: number;
  source: 'auto' | 'manual';
  /** точная сетка битов (для наложения битов друг на друга при DJ-склейке) */
  grid?: BeatGridRecord;
  /** версия алгоритма анализа: при обновлении алгоритма старые результаты пересчитываются */
  algo?: number;
}

export interface PersistedState {
  dj?: DJSettings;
  fx?: FxSettings;
  musicHaptics?: boolean;
  bpm?: Record<string, BpmRecord>;
  order?: string[];
  shuffle?: boolean;
  repeat?: RepeatMode;
  volume?: number;
  lastTrackId?: string;
  samplesSeeded?: boolean;
  /** смещение синхро-текста для конкретного трека, сек */
  lyricsOffset?: Record<string, number>;
}

const docRoot = FileSystem.documentDirectory ?? '';

function resolveDataDir(): string {
  if (/\/Documents\/$/.test(docRoot)) return docRoot.replace(/\/Documents\/$/, '/Library/Application Support/WouFY/');
  return `${docRoot}.woufy/`;
}

export const DATA_DIR = resolveDataDir();
export const LEGACY_DIR = `${docRoot}.woufy/`;
const FILE = `${DATA_DIR}state.json`;
const TRACKS_CACHE_FILE = `${DATA_DIR}library_cache.json`;
/** версия формата кэша треков: при смене старый кэш игнорируется и библиотека перечитывается */
const TRACKS_CACHE_VERSION = 3;

let cache: PersistedState = {};
let loaded = false;
let writeTimer: ReturnType<typeof setTimeout> | null = null;

export async function ensureDataDir(): Promise<void> {
  try {
    const info = await FileSystem.getInfoAsync(DATA_DIR);
    if (!info.exists) await FileSystem.makeDirectoryAsync(DATA_DIR, { intermediates: true });
  } catch (e) {
    console.warn('[library] ensureDataDir failed', e);
  }
}

async function readJson<T>(path: string): Promise<T | undefined> {
  try {
    const info = await FileSystem.getInfoAsync(path);
    if (!info.exists) return undefined;
    return JSON.parse(await FileSystem.readAsStringAsync(path)) as T;
  } catch {
    return undefined;
  }
}

export async function loadState(): Promise<PersistedState> {
  if (loaded) return cache;
  await ensureDataDir();
  // новая папка → старая скрытая `.woufy` (миграция)
  const fresh = await readJson<PersistedState>(FILE);
  if (fresh) cache = fresh;
  else {
    const legacy = await readJson<PersistedState>(`${LEGACY_DIR}state.json`);
    cache = legacy ?? {};
    if (legacy) {
      try {
        await FileSystem.writeAsStringAsync(FILE, JSON.stringify(cache));
      } catch {
        /* необязательно */
      }
    }
  }
  loaded = true;
  return cache;
}

export function getState(): PersistedState {
  return cache;
}

export function patchState(patch: Partial<PersistedState>) {
  cache = { ...cache, ...patch };
  if (writeTimer) clearTimeout(writeTimer);
  writeTimer = setTimeout(flushState, 600);
}

export async function flushState() {
  if (writeTimer) {
    clearTimeout(writeTimer);
    writeTimer = null;
  }
  try {
    await ensureDataDir();
    await FileSystem.writeAsStringAsync(FILE, JSON.stringify(cache));
  } catch (e) {
    console.warn('[library] state save failed', e);
  }
}

/** Загрузка закэшированного списка треков с метаданными (мгновенно при старте) */
export async function loadCachedTracks(): Promise<TrackFile[]> {
  try {
    const parsed = (await readJson<{ v: number; tracks: TrackFile[] }>(TRACKS_CACHE_FILE)) ?? undefined;
    if (parsed && parsed.v === TRACKS_CACHE_VERSION && Array.isArray(parsed.tracks)) {
      // абсолютные пути (контейнер приложения может смениться при обновлении) пересобираем от текущих корней
      return parsed.tracks.map((t) => {
        const uri = `${docRoot}${t.id}`;
        return {
          ...t,
          uri,
          artworkUri: t.artworkUri ? `${DATA_DIR}covers/${t.artworkUri.split('/').pop()}` : undefined,
          lrcUri: t.lrcUri ? uri.replace(/\.[^/.]+$/, '.lrc') : undefined,
        };
      });
    }
  } catch (e) {
    console.warn('[library] failed to load cached tracks:', e);
  }
  return [];
}

/** Сохранение списка треков в постоянный кэш */
export async function saveCachedTracks(tracks: TrackFile[]): Promise<void> {
  try {
    await ensureDataDir();
    await FileSystem.writeAsStringAsync(TRACKS_CACHE_FILE, JSON.stringify({ v: TRACKS_CACHE_VERSION, tracks }));
  } catch (e) {
    console.warn('[library] failed to save cached tracks:', e);
  }
}
