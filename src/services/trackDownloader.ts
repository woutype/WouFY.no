import * as FileSystem from 'expo-file-system/legacy';
import { AudioExtension, TrackFile } from '../types';
import { ensureAppFolders, musicDir } from './fileScanner';
import { getState, normalizeTrackId, patchState, resolveTrackUri } from './library';
import { downloadCoverToCache } from './onlineArtwork';
import { parseAudioTags } from './id3Parser';
import { parseLrc, saveLrc } from './lyrics';

/* ───────── Конфигурация Render-бэкенда ───────── */

const ENV_API_URL =
  process.env.EXPO_PUBLIC_DOWNLOAD_API_URL ??
  process.env.EXPO_PUBLIC_MUSIC_API_URL ??
  '';

const ENV_API_KEY = process.env.EXPO_PUBLIC_DOWNLOAD_API_KEY ?? '';

/** Маппинг VK genre_id -> название жанра (из референса VK Music Saver) */
const VK_GENRES: Record<number, string> = {
  1: 'Rock',
  2: 'Pop',
  3: 'Rap & Hip-Hop',
  4: 'Easy Listening',
  5: 'Dance & House',
  6: 'Instrumental',
  7: 'Metal',
  8: 'Dubstep',
  10: 'Drum & Bass',
  11: 'Trance',
  12: 'Chanson',
  13: 'Ethnic',
  14: 'Acoustic & Vocal',
  15: 'Reggae',
  16: 'Classical',
  17: 'Indie Pop',
  18: 'Other',
  19: 'Speech',
  21: 'Alternative',
  22: 'Electropop & Disco',
  1001: 'Jazz & Blues',
};

const VALID_EXTENSIONS = new Set<AudioExtension>(['mp3', 'm4a', 'aac', 'wav', 'flac', 'aiff']);

export interface DownloadApiConfig {
  baseUrl: string;
  apiKey: string;
  source: 'custom' | 'env' | 'none';
}

export function normalizeBaseUrl(raw?: string): string {
  const trimmed = (raw ?? '').trim().replace(/\/+$/, '');
  if (!trimmed) return '';
  if (!/^https?:\/\//i.test(trimmed)) return `https://${trimmed}`;
  return trimmed;
}

export function getDownloadApiConfig(): DownloadApiConfig {
  const custom = normalizeBaseUrl(getState().downloadApiUrl);
  if (custom) {
    return { baseUrl: custom, apiKey: ENV_API_KEY.trim(), source: 'custom' };
  }
  const envUrl = normalizeBaseUrl(ENV_API_URL);
  if (envUrl) {
    return { baseUrl: envUrl, apiKey: ENV_API_KEY.trim(), source: 'env' };
  }
  return { baseUrl: '', apiKey: ENV_API_KEY.trim(), source: 'none' };
}

export function isDownloadApiConfigured(): boolean {
  return getDownloadApiConfig().baseUrl.length > 0;
}

export function setCustomDownloadApiUrl(url: string): string {
  const normalized = normalizeBaseUrl(url);
  patchState({ downloadApiUrl: normalized || undefined });
  return normalized;
}

function buildHeaders(extra?: Record<string, string>): Record<string, string> {
  const { apiKey } = getDownloadApiConfig();
  const headers: Record<string, string> = {
    Accept: 'application/json',
    ...extra,
  };
  if (apiKey) {
    headers['Authorization'] = `Bearer ${apiKey}`;
    headers['X-API-Key'] = apiKey;
  }
  return headers;
}

/* ───────── Модели удалённого трека ───────── */

export interface RemoteTrackResult {
  /** Уникальный идентификатор трека на бэкенде (например, VK `ownerId_audioId` или `ownerId_audioId_accessKey`) */
  id: string;
  title: string;
  subtitle?: string;
  artist: string;
  album?: string;
  year?: number;
  genre?: string;
  duration?: number;
  bitrate?: number;
  bpm?: number;
  trackNumber?: number;
  discNumber?: number;
  coverUrl?: string;
  thumbnailUrl?: string;
  explicit?: boolean;
  hasLyrics?: boolean;
  /** Прямая ссылка на готовый аудиофайл, если бэкенд отдаёт её сразу */
  downloadUrl?: string;
  extension: AudioExtension;
}

export interface RemoteTrackMetadata {
  title?: string;
  subtitle?: string;
  artist?: string;
  album?: string;
  year?: number;
  genre?: string;
  bpm?: number;
  trackNumber?: number;
  discNumber?: number;
  coverUrl?: string;
  lyrics?: string;
  syncedLyrics?: string;
  duration?: number;
  extension?: AudioExtension;
  downloadUrl?: string;
}

export type DownloadPhase = 'preparing' | 'downloading' | 'tagging' | 'done';

export interface DownloadProgressEvent {
  phase: DownloadPhase;
  /** 0..1 */
  progress: number;
  bytesWritten?: number;
  totalBytes?: number;
}

export class DownloadApiError extends Error {
  status?: number;
  code?: 'NOT_CONFIGURED' | 'NETWORK' | 'ABORTED' | 'HTTP' | 'EMPTY_FILE';

  constructor(
    message: string,
    opts?: { status?: number; code?: 'NOT_CONFIGURED' | 'NETWORK' | 'ABORTED' | 'HTTP' | 'EMPTY_FILE' }
  ) {
    super(message);
    this.name = 'DownloadApiError';
    this.status = opts?.status;
    this.code = opts?.code;
  }
}

/* ───────── Нормализация ответов (совместимо с VK / VKMS полями и REST-схемой) ───────── */

function pickBestThumb(raw: any): { coverUrl?: string; thumbnailUrl?: string } {
  const directLarge = raw.coverUrl ?? raw.cover_url ?? raw.coverUrl_l ?? raw.artworkUrl ?? raw.artwork_url;
  const directSmall = raw.thumbnailUrl ?? raw.thumbnail_url ?? raw.coverUrl_s ?? raw.coverUrl_m;

  const thumbObj = !Array.isArray(raw.album) ? raw.album?.thumb ?? raw.photo : undefined;
  let bestUrl: string | undefined;
  let bestSize = 0;
  let smallUrl: string | undefined;
  let smallSize = Infinity;

  if (thumbObj && typeof thumbObj === 'object') {
    for (const [k, v] of Object.entries(thumbObj)) {
      if (typeof v !== 'string' || !v.startsWith('http')) continue;
      const parts = k.split('_');
      const num = Number(parts[1]);
      if (Number.isFinite(num) && num > 0) {
        if (num > bestSize) {
          bestSize = num;
          bestUrl = v;
        }
        if (num < smallSize) {
          smallSize = num;
          smallUrl = v;
        }
      } else if (!bestUrl) {
        bestUrl = v;
      }
    }
  }

  const coverUrl = (typeof directLarge === 'string' && directLarge) || bestUrl || (typeof directSmall === 'string' && directSmall) || undefined;
  const thumbnailUrl = (typeof directSmall === 'string' && directSmall) || smallUrl || coverUrl;
  return { coverUrl, thumbnailUrl };
}

function normalizeExtension(raw?: string): AudioExtension {
  const ext = (raw ?? 'mp3').toLowerCase().replace(/^\./, '') as AudioExtension;
  return VALID_EXTENSIONS.has(ext) ? ext : 'mp3';
}

function normalizeRemoteTrack(raw: any): RemoteTrackResult | null {
  if (!raw || typeof raw !== 'object') return null;

  let id = raw.id != null ? String(raw.id) : '';
  if (raw.owner_id != null && raw.id != null && !id.includes('_')) {
    const parts = [String(raw.owner_id), String(raw.id)];
    const accessKey = raw.access_key ?? raw.accessKey;
    if (accessKey) parts.push(String(accessKey));
    id = parts.join('_');
  }
  if (!id) return null;

  const title = String(raw.title ?? '').trim();
  if (!title) return null;

  const subtitle = String(raw.subtitle ?? raw.subTitle ?? '').trim() || undefined;

  let artist = String(raw.artist ?? raw.performer ?? '').trim();
  if (!artist) {
    const main = Array.isArray(raw.main_artists) ? raw.main_artists : Array.isArray(raw.mainArtists) ? raw.mainArtists : [];
    const feat = Array.isArray(raw.featured_artists) ? raw.featured_artists : [];
    const names = [...main, ...feat]
      .map((a: any) => (typeof a === 'string' ? a : a?.name))
      .filter((n: any): n is string => typeof n === 'string' && n.trim().length > 0);
    artist = names.join(', ') || 'Неизвестный исполнитель';
  }

  const album =
    typeof raw.album === 'string'
      ? raw.album.trim() || undefined
      : typeof raw.album?.title === 'string'
        ? raw.album.title.trim() || undefined
        : undefined;

  const yearRaw = Number(raw.year ?? raw.album?.year);
  const year = Number.isFinite(yearRaw) && yearRaw > 1900 && yearRaw < 2100 ? yearRaw : undefined;

  const genreId = Number(raw.genre_id ?? raw.genreId);
  const genre =
    (typeof raw.genre === 'string' && raw.genre.trim()) ||
    (Number.isFinite(genreId) ? VK_GENRES[genreId] : undefined) ||
    undefined;

  const durationRaw = Number(raw.duration);
  const duration = Number.isFinite(durationRaw) && durationRaw > 0 ? Math.round(durationRaw) : undefined;

  const bitrateRaw = Number(raw.bitrate);
  const bitrate = Number.isFinite(bitrateRaw) && bitrateRaw > 0 ? Math.round(bitrateRaw) : undefined;

  const bpmRaw = Number(raw.bpm);
  const bpm = Number.isFinite(bpmRaw) && bpmRaw >= 40 && bpmRaw <= 240 ? bpmRaw : undefined;

  const trackNumberRaw = Number(raw.trackNumber ?? raw.track_number);
  const trackNumber = Number.isFinite(trackNumberRaw) && trackNumberRaw > 0 ? trackNumberRaw : undefined;

  const discNumberRaw = Number(raw.discNumber ?? raw.disc_number);
  const discNumber = Number.isFinite(discNumberRaw) && discNumberRaw > 0 ? discNumberRaw : undefined;

  const { coverUrl, thumbnailUrl } = pickBestThumb(raw);

  return {
    id,
    title,
    subtitle,
    artist,
    album,
    year,
    genre,
    duration,
    bitrate,
    bpm,
    trackNumber,
    discNumber,
    coverUrl,
    thumbnailUrl,
    explicit: Boolean(raw.explicit ?? raw.is_explicit),
    hasLyrics: Boolean(raw.hasLyrics ?? raw.has_lyrics ?? raw.lyrics_id),
    downloadUrl: typeof (raw.downloadUrl ?? raw.download_url) === 'string' ? (raw.downloadUrl ?? raw.download_url) : undefined,
    extension: normalizeExtension(raw.extension ?? raw.format),
  };
}

function resolveEndpointUrl(baseUrl: string, pathOrUrl: string): string {
  if (/^https?:\/\//i.test(pathOrUrl)) return pathOrUrl;
  const cleanPath = pathOrUrl.startsWith('/') ? pathOrUrl : `/${pathOrUrl}`;
  return `${baseUrl}${cleanPath}`;
}

/* ───────── API-методы ───────── */

/** Проверка доступности Render-бэкенда (и «прогрев» инстанса при cold start) */
export async function checkDownloadBackendHealth(signal?: AbortSignal): Promise<boolean> {
  const { baseUrl } = getDownloadApiConfig();
  if (!baseUrl) return false;
  try {
    const res = await fetch(`${baseUrl}/health`, {
      method: 'GET',
      headers: buildHeaders(),
      signal,
    });
    return res.ok;
  } catch {
    return false;
  }
}

/** Поиск треков на бэкенде в реальном времени */
export async function searchRemoteTracks(params: {
  title: string;
  artist?: string;
  limit?: number;
  signal?: AbortSignal;
}): Promise<RemoteTrackResult[]> {
  const { baseUrl } = getDownloadApiConfig();
  if (!baseUrl) {
    throw new DownloadApiError('Не указан URL сервера скачивания (EXPO_PUBLIC_DOWNLOAD_API_URL).', {
      code: 'NOT_CONFIGURED',
    });
  }

  const title = params.title.trim();
  const artist = (params.artist ?? '').trim();
  const combinedQuery = [artist, title].filter(Boolean).join(' ').trim();
  if (!combinedQuery) return [];

  const qs = new URLSearchParams();
  qs.set('q', combinedQuery);
  if (title) qs.set('title', title);
  if (artist) qs.set('artist', artist);
  qs.set('limit', String(params.limit ?? 25));

  const url = `${baseUrl}/api/search?${qs.toString()}`;

  let res: Response;
  try {
    res = await fetch(url, {
      method: 'GET',
      headers: buildHeaders(),
      signal: params.signal,
    });
  } catch (e: any) {
    if (e?.name === 'AbortError' || params.signal?.aborted) {
      throw new DownloadApiError('Поиск отменён', { code: 'ABORTED' });
    }
    throw new DownloadApiError('Не удалось подключиться к серверу. Возможно, инстанс на Render просыпается — попробуйте ещё раз.', {
      code: 'NETWORK',
    });
  }

  if (!res.ok) {
    let detail = '';
    try {
      const errJson = await res.json();
      detail = errJson?.error || errJson?.message || '';
    } catch {
      /* ignore */
    }
    throw new DownloadApiError(detail || `Ошибка сервера (${res.status})`, {
      status: res.status,
      code: 'HTTP',
    });
  }

  const payload = await res.json();
  const rawItems: any[] = Array.isArray(payload)
    ? payload
    : Array.isArray(payload?.items)
      ? payload.items
      : Array.isArray(payload?.tracks)
        ? payload.tracks
        : Array.isArray(payload?.response?.items)
          ? payload.response.items
          : [];

  const out: RemoteTrackResult[] = [];
  const seen = new Set<string>();
  for (const item of rawItems) {
    const normalized = normalizeRemoteTrack(item);
    if (!normalized || seen.has(normalized.id)) continue;
    seen.add(normalized.id);
    out.push(normalized);
  }
  return out;
}

/** Получение расширенных метаданных (текст, LRC, HD-обложка, прямая ссылка на скачивание) */
export async function fetchRemoteTrackMetadata(
  track: RemoteTrackResult,
  signal?: AbortSignal
): Promise<RemoteTrackMetadata | null> {
  const { baseUrl } = getDownloadApiConfig();
  if (!baseUrl) return null;

  try {
    const url = `${baseUrl}/api/tracks/${encodeURIComponent(track.id)}/metadata`;
    const res = await fetch(url, {
      method: 'GET',
      headers: buildHeaders(),
      signal,
    });
    if (!res.ok) return null;
    const data = await res.json();
    if (!data || typeof data !== 'object') return null;

    const { coverUrl } = pickBestThumb(data);
    return {
      title: typeof data.title === 'string' ? data.title.trim() : undefined,
      subtitle: typeof (data.subtitle ?? data.subTitle) === 'string' ? (data.subtitle ?? data.subTitle).trim() : undefined,
      artist: typeof (data.artist ?? data.performer) === 'string' ? (data.artist ?? data.performer).trim() : undefined,
      album: typeof data.album === 'string' ? data.album.trim() : typeof data.album?.title === 'string' ? data.album.title.trim() : undefined,
      year: Number.isFinite(Number(data.year)) ? Number(data.year) : undefined,
      genre: typeof data.genre === 'string' ? data.genre.trim() : undefined,
      bpm: Number.isFinite(Number(data.bpm)) ? Number(data.bpm) : undefined,
      trackNumber: Number.isFinite(Number(data.trackNumber ?? data.track_number))
        ? Number(data.trackNumber ?? data.track_number)
        : undefined,
      discNumber: Number.isFinite(Number(data.discNumber ?? data.disc_number))
        ? Number(data.discNumber ?? data.disc_number)
        : undefined,
      coverUrl,
      lyrics: typeof data.lyrics === 'string' ? data.lyrics : undefined,
      syncedLyrics: typeof (data.syncedLyrics ?? data.synced_lyrics ?? data.lrc) === 'string'
        ? (data.syncedLyrics ?? data.synced_lyrics ?? data.lrc)
        : undefined,
      duration: Number.isFinite(Number(data.duration)) ? Number(data.duration) : undefined,
      extension: data.extension || data.format ? normalizeExtension(data.extension ?? data.format) : undefined,
      downloadUrl: typeof (data.downloadUrl ?? data.download_url) === 'string' ? (data.downloadUrl ?? data.download_url) : undefined,
    };
  } catch {
    return null;
  }
}

/* ───────── Сохранение файла и метаданных в локальную библиотеку ───────── */

function sanitizeFilenamePart(text: string): string {
  return text
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 90);
}

async function allocateUniqueFilePath(artist: string, title: string, ext: AudioExtension): Promise<{ uri: string; filename: string }> {
  const dir = musicDir();
  const safeArtist = sanitizeFilenamePart(artist) || 'Unknown Artist';
  const safeTitle = sanitizeFilenamePart(title) || 'Track';
  const base = `${safeArtist} - ${safeTitle}`;

  let candidate = `${base}.${ext}`;
  let targetUri = `${dir}${candidate}`;
  let attempt = 2;

  while (attempt <= 50) {
    const info = await FileSystem.getInfoAsync(targetUri).catch(() => ({ exists: false }));
    if (!info.exists) break;
    candidate = `${base} (${attempt}).${ext}`;
    targetUri = `${dir}${candidate}`;
    attempt++;
  }

  return { uri: targetUri, filename: candidate };
}

/**
 * Полный цикл скачивания трека:
 * 1. Запрос метаданных (обложка, текст/LRC, прямая ссылка) при поддержке бэкенда.
 * 2. Потоковая загрузка MP3 с прогрессом через expo-file-system.
 * 3. Сохранение в папку Music/, кэширование обложки и LRC, чтение встроенных ID3-тегов.
 * 4. Возврат готового TrackFile для мгновенного добавления в локальную библиотеку.
 */
export async function downloadRemoteTrack(
  track: RemoteTrackResult,
  options?: {
    onProgress?: (event: DownloadProgressEvent) => void;
    signal?: AbortSignal;
  }
): Promise<TrackFile> {
  const { baseUrl } = getDownloadApiConfig();
  if (!baseUrl) {
    throw new DownloadApiError('Не указан URL сервера скачивания.', { code: 'NOT_CONFIGURED' });
  }

  const onProgress = options?.onProgress;
  const signal = options?.signal;

  if (signal?.aborted) {
    throw new DownloadApiError('Скачивание отменено', { code: 'ABORTED' });
  }

  onProgress?.({ phase: 'downloading', progress: 0 });

  const initialExt = track.extension ?? 'mp3';
  const cacheDir = FileSystem.cacheDirectory ?? FileSystem.documentDirectory ?? '';
  const tempPath = `${cacheDir}woufy_dl_${Date.now()}_${Math.random().toString(36).slice(2, 7)}.${initialExt}.part`;

  const rawDownloadUrl =
    track.downloadUrl || `${baseUrl}/api/tracks/${encodeURIComponent(track.id)}/download`;
  const downloadUrl = resolveEndpointUrl(baseUrl, rawDownloadUrl);

  const resumable = FileSystem.createDownloadResumable(
    downloadUrl,
    tempPath,
    { headers: buildHeaders({ Accept: 'audio/mpeg, audio/*, application/octet-stream' }) },
    (dp) => {
      const ratio =
        dp.totalBytesExpectedToWrite > 0
          ? Math.max(0, Math.min(1, dp.totalBytesWritten / dp.totalBytesExpectedToWrite))
          : dp.totalBytesWritten > 0
            ? Math.min(0.92, dp.totalBytesWritten / (8 * 1024 * 1024))
            : 0;
      onProgress?.({
        phase: 'downloading',
        progress: ratio,
        bytesWritten: dp.totalBytesWritten,
        totalBytes: dp.totalBytesExpectedToWrite > 0 ? dp.totalBytesExpectedToWrite : undefined,
      });
    }
  );

  const onAbort = () => {
    resumable.cancelAsync().catch(() => {});
  };
  signal?.addEventListener('abort', onAbort);

  // Запускаем подготовку папок, скачивание аудио, запрос текста/метаданных и кэширование ТОЧНОЙ обложки из поиска ПАРАЛЛЕЛЬНО
  const foldersPromise = ensureAppFolders();
  const metaPromise = fetchRemoteTrackMetadata(track, signal).catch(() => null);
  const searchCoverCandidates = [track.coverUrl, track.thumbnailUrl].filter(Boolean) as string[];
  const initialCoverPromise =
    searchCoverCandidates.length > 0
      ? foldersPromise.then(() => downloadCoverToCache(searchCoverCandidates, track.id)).catch(() => null)
      : Promise.resolve(null);

  let downloadResult: FileSystem.FileSystemDownloadResult | undefined;
  let extraMeta: RemoteTrackMetadata | null = null;
  let cachedCoverUri: string | null = null;

  try {
    const [, dlRes, metaRes, coverRes] = await Promise.all([
      foldersPromise,
      resumable.downloadAsync(),
      metaPromise,
      initialCoverPromise,
    ]);
    downloadResult = dlRes;
    extraMeta = metaRes;
    cachedCoverUri = coverRes;
  } catch (e: any) {
    await FileSystem.deleteAsync(tempPath, { idempotent: true }).catch(() => {});
    if (signal?.aborted) {
      throw new DownloadApiError('Скачивание отменено', { code: 'ABORTED' });
    }
    throw new DownloadApiError(e?.message || 'Ошибка при загрузке аудиофайла', { code: 'NETWORK' });
  } finally {
    signal?.removeEventListener('abort', onAbort);
  }

  if (signal?.aborted) {
    await FileSystem.deleteAsync(tempPath, { idempotent: true }).catch(() => {});
    throw new DownloadApiError('Скачивание отменено', { code: 'ABORTED' });
  }

  if (!downloadResult || downloadResult.status < 200 || downloadResult.status >= 300) {
    await FileSystem.deleteAsync(tempPath, { idempotent: true }).catch(() => {});
    throw new DownloadApiError(
      `Сервер вернул ошибку (${downloadResult?.status ?? 'нет ответа'}) при скачивании трека.`,
      { status: downloadResult?.status, code: 'HTTP' }
    );
  }

  const tempInfo = await FileSystem.getInfoAsync(tempPath).catch(() => null);
  const fileSize = tempInfo && tempInfo.exists && 'size' in tempInfo ? tempInfo.size : 0;
  if (!tempInfo?.exists || !fileSize || fileSize < 1024) {
    await FileSystem.deleteAsync(tempPath, { idempotent: true }).catch(() => {});
    throw new DownloadApiError('Скачанный файл пуст или повреждён.', { code: 'EMPTY_FILE' });
  }

  onProgress?.({ phase: 'tagging', progress: 1 });

  // Если у элемента поиска не было обложки, пробуем обложку из метаданных
  if (!cachedCoverUri && extraMeta?.coverUrl) {
    cachedCoverUri = await downloadCoverToCache([extraMeta.coverUrl], track.id).catch(() => null);
  }

  // Читаем ID3 из файла только если обложка ещё не получена
  const embeddedTags = !cachedCoverUri
    ? await parseAudioTags(tempPath, track.id, initialExt).catch(() => null)
    : null;

  const fullTitle = (() => {
    const t = track.title || extraMeta?.title || 'Track';
    const sub = track.subtitle || extraMeta?.subtitle;
    if (sub && !t.toLowerCase().includes(sub.toLowerCase())) {
      return `${t} (${sub})`;
    }
    return t;
  })();

  const artist = track.artist || extraMeta?.artist || 'Неизвестный исполнитель';
  const album = track.album || extraMeta?.album;
  const year = track.year ?? extraMeta?.year;
  const genre = track.genre || extraMeta?.genre;
  const bpm = track.bpm ?? extraMeta?.bpm;
  const trackNumber = track.trackNumber ?? extraMeta?.trackNumber;
  const discNumber = track.discNumber ?? extraMeta?.discNumber;
  const ext = extraMeta?.extension ?? track.extension ?? 'mp3';

  // Переносим готовый файл в Music/ в самом конце, когда обложка и метаданные уже готовы
  const { uri: destUri, filename } = await allocateUniqueFilePath(artist, fullTitle, ext);
  await FileSystem.moveAsync({ from: tempPath, to: destUri });

  const destInfo = await FileSystem.getInfoAsync(destUri).catch(() => null);
  const actualMtime =
    destInfo && destInfo.exists && 'modificationTime' in destInfo && typeof destInfo.modificationTime === 'number'
      ? Math.round(destInfo.modificationTime)
      : Date.now();

  const id = normalizeTrackId(destUri);
  const canonicalUri = resolveTrackUri(id);
  const finalArtworkUri = cachedCoverUri || embeddedTags?.artworkUri || undefined;

  const rawLyrics = extraMeta?.syncedLyrics || extraMeta?.lyrics || embeddedTags?.lyrics || undefined;
  const parsedSynced =
    (extraMeta?.syncedLyrics ? parseLrc(extraMeta.syncedLyrics) : null) ??
    (rawLyrics ? parseLrc(rawLyrics) : null);

  const trackFile: TrackFile = {
    id,
    uri: canonicalUri,
    filename,
    title: fullTitle || embeddedTags?.title || filename.replace(/\.[^/.]+$/, ''),
    artist: artist || embeddedTags?.artist || 'Неизвестный исполнитель',
    album: album || embeddedTags?.album || 'Сингл',
    year,
    genre,
    artworkUri: finalArtworkUri,
    thumbDone: Boolean(finalArtworkUri),
    lyrics: rawLyrics,
    syncedLyrics: parsedSynced
      ? parsedSynced.map((l) => ({ time: l.time, text: l.text }))
      : embeddedTags?.syncedLyrics,
    bpmTag: bpm ?? embeddedTags?.bpm,
    size: fileSize,
    mtime: actualMtime,
    trackNumber: trackNumber ?? embeddedTags?.trackNumber,
    discNumber: discNumber ?? embeddedTags?.discNumber,
    extension: ext,
    tagged: true,
  };

  if (parsedSynced && parsedSynced.length > 0) {
    await saveLrc(trackFile, parsedSynced).catch(() => {});
  }

  onProgress?.({ phase: 'done', progress: 1 });
  return trackFile;
}
