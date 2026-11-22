import * as FileSystem from 'expo-file-system/legacy';
import { Platform } from 'react-native';
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
  /** пользовательский URL бэкенда скачивания (переопределяет EXPO_PUBLIC_DOWNLOAD_API_URL) */
  downloadApiUrl?: string;
}

export function getDocRoot(): string {
  const dir = FileSystem.documentDirectory ?? '';
  if (!dir) return '';
  return dir.endsWith('/') ? dir : `${dir}/`;
}

/** Нормализует id трека к относительному пути внутри Documents (например, 'Music/Track.mp3') */
export function normalizeTrackId(idOrUri: string): string {
  if (!idOrUri) return '';
  let clean = idOrUri;
  const root = getDocRoot();
  if (root && clean.startsWith(root)) {
    clean = clean.slice(root.length);
  } else if (clean.includes('/Documents/')) {
    clean = clean.split('/Documents/')[1];
  } else if (clean.startsWith('file://')) {
    clean = clean.replace(/^file:\/\//, '');
  }
  // В Expo Go documentDirectory заканчивается на ExponentExperienceData/<scope>/<slug>/ —
  // убираем этот префикс, если он остался от старого кэша или другого контейнера
  clean = clean.replace(/^ExponentExperienceData\/[^/]+\/[^/]+\//, '');
  return clean.replace(/^\.?\/+/, '');
}

/** Строит абсолютный file:// URI для трека от ТЕКУЩЕГО контейнера приложения */
export function resolveTrackUri(idOrUri: string): string {
  const root = getDocRoot();
  if (!idOrUri) return root;
  const relId = normalizeTrackId(idOrUri);
  if (
    Platform.OS === 'android' &&
    (relId.startsWith('storage/') || relId.startsWith('sdcard/') || relId.startsWith('mnt/') || relId.startsWith('data/'))
  ) {
    return `file:///${relId}`;
  }
  return `${root}${relId}`;
}

export function resolveDataDir(): string {
  const doc = getDocRoot();
  if (/\/Documents\/$/.test(doc)) return doc.replace(/\/Documents\/$/, '/Library/Application Support/WouFY/');
  return `${doc}.woufy/`;
}

export const DATA_DIR = resolveDataDir();
export const LEGACY_DIR = `${getDocRoot()}.woufy/`;
const FILE = `${DATA_DIR}state.json`;
const TRACKS_CACHE_FILE = `${DATA_DIR}library_cache.json`;
/** версия формата кэша треков: при смене старый кэш перепроверяется и пересохраняется в новом формате */
const TRACKS_CACHE_VERSION = 6;

let cache: PersistedState = {};
let loaded = false;
let writeTimer: ReturnType<typeof setTimeout> | null = null;

export async function ensureDataDir(): Promise<void> {
  try {
    const info = await FileSystem.getInfoAsync(DATA_DIR);
    if (!info.exists) await FileSystem.makeDirectoryAsync(DATA_DIR, { intermediates: true });
    const coversDir = `${DATA_DIR}covers/`;
    const cInfo = await FileSystem.getInfoAsync(coversDir);
    if (!cInfo.exists) await FileSystem.makeDirectoryAsync(coversDir, { intermediates: true });
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
    const raw = await readJson<{ v?: number; tracks?: TrackFile[] } | TrackFile[]>(TRACKS_CACHE_FILE);
    let tracks: TrackFile[] = [];
    const isCurrentVersion = raw && !Array.isArray(raw) && raw.v === TRACKS_CACHE_VERSION;
    if (raw && !Array.isArray(raw) && Array.isArray(raw.tracks)) {
      tracks = raw.tracks;
    } else if (Array.isArray(raw)) {
      tracks = raw;
    }
    if (tracks.length > 0) {
      const dataDir = resolveDataDir();
      return tracks.map((t) => {
        const id = normalizeTrackId(t.id || t.uri || t.filename);
        const uri = resolveTrackUri(id);
        const coverName = t.artworkUri ? t.artworkUri.split('/').pop() : undefined;
        // Если версия кэша старая или обложка ещё ни разу не проверялась (!thumbDone), переобогащаем в фоне
        const needsReenrich = !isCurrentVersion || (!coverName && !t.thumbDone);
        return {
          ...t,
          id,
          uri,
          artworkUri: coverName ? `${dataDir}covers/${coverName}` : undefined,
          lrcUri: t.lrcUri ? uri.replace(/\.[^/.]+$/, '.lrc') : undefined,
          tagged: needsReenrich ? false : t.tagged,
          thumbDone: needsReenrich ? false : Boolean(t.thumbDone || coverName),
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
    const cleanTracks = tracks.map((t) => {
      const id = normalizeTrackId(t.id || t.uri || t.filename);
      const uri = resolveTrackUri(id);
      return {
        ...t,
        id,
        uri,
      };
    });
    await FileSystem.writeAsStringAsync(TRACKS_CACHE_FILE, JSON.stringify({ v: TRACKS_CACHE_VERSION, tracks: cleanTracks }));
  } catch (e) {
    console.warn('[library] failed to save cached tracks:', e);
  }
}

/** Удаляет из state.json записи (bpm, lyricsOffset, order, lastTrackId) для треков, которых больше нет */
export async function pruneDeletedTrackState(validIds: Set<string>): Promise<void> {
  try {
    const state = await loadState();
    const patch: Partial<PersistedState> = {};
    let changed = false;

    if (state.bpm) {
      const nextBpm: Record<string, BpmRecord> = {};
      for (const [id, rec] of Object.entries(state.bpm)) {
        if (validIds.has(id)) nextBpm[id] = rec;
        else changed = true;
      }
      if (changed) patch.bpm = nextBpm;
    }

    if (state.lyricsOffset) {
      let offChanged = false;
      const nextOff: Record<string, number> = {};
      for (const [id, off] of Object.entries(state.lyricsOffset)) {
        if (validIds.has(id)) nextOff[id] = off;
        else offChanged = true;
      }
      if (offChanged) {
        patch.lyricsOffset = nextOff;
        changed = true;
      }
    }

    if (state.order) {
      const nextOrder = state.order.filter((id) => validIds.has(id));
      if (nextOrder.length !== state.order.length) {
        patch.order = nextOrder;
        changed = true;
      }
    }

    if (state.lastTrackId && !validIds.has(state.lastTrackId)) {
      patch.lastTrackId = undefined;
      changed = true;
    }

    if (changed) patchState(patch);
  } catch (e) {
    console.warn('[library] pruneDeletedTrackState failed:', e);
  }
}


