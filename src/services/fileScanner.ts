import * as FileSystem from 'expo-file-system/legacy';
import { parseAudioTags } from './id3Parser';
import { loadCachedTracks, saveCachedTracks, DATA_DIR, LEGACY_DIR, ensureDataDir } from './library';
import { AudioExtension, TrackFile } from '../types';
import { WoufyFX } from '../../modules/woufy-fx';
import { cleanupOrphanCovers, cleanupTrash, cleanupTempCache } from './storageService';
import { statsService } from './statsService';

/** Основная папка для музыки (пользователь может класть треки и сюда, и прямо в корень WouFY.no) */
export const MUSIC_DIR_NAME = 'Music';
const AUDIO_RE = /\.(mp3|m4a|aac|wav|flac|aiff?)$/i;
const NON_DIR_RE = /\.(jpe?g|png|txt|cue|log|m3u8?|pdf|nfo|webp|gif|heic|ds_store|plist)$/i;

const docDir = () => FileSystem.documentDirectory ?? '';
export const musicDir = () => `${docDir()}${MUSIC_DIR_NAME}/`;

let cleaned = false;

/** Одноразовая уборка старых служебных файлов из Documents */
async function cleanupLegacy(): Promise<void> {
  if (cleaned) return;
  cleaned = true;
  const root = docDir();
  try {
    const hint = `${root}Положи музыку в папку Music.txt`;
    const hi = await FileSystem.getInfoAsync(hint);
    if (hi.exists) await FileSystem.deleteAsync(hint, { idempotent: true });

    const legacyLyrics = `${root}lyrics_cache/`;
    const li = await FileSystem.getInfoAsync(legacyLyrics);
    if (li.exists && li.isDirectory) {
      const target = `${DATA_DIR}lyrics_cache/`;
      await FileSystem.makeDirectoryAsync(target, { intermediates: true }).catch(() => {});
      const names = await FileSystem.readDirectoryAsync(legacyLyrics).catch(() => [] as string[]);
      for (const n of names) {
        await FileSystem.moveAsync({ from: `${legacyLyrics}${n}`, to: `${target}${n}` }).catch(() => {});
      }
      await FileSystem.deleteAsync(legacyLyrics, { idempotent: true }).catch(() => {});
    }
  } catch (e) {
    console.warn('[fileScanner] legacy cleanup failed:', e);
  }
}

/** Создаёт структуру папок приложения */
export async function ensureAppFolders(): Promise<void> {
  try {
    const dir = musicDir();
    const info = await FileSystem.getInfoAsync(dir);
    if (!info.exists) await FileSystem.makeDirectoryAsync(dir, { intermediates: true });
    await ensureDataDir();
    await cleanupLegacy();
  } catch (e) {
    console.warn('[fileScanner] ensureAppFolders failed:', e);
  }
}

interface RawFoundFile {
  uri: string;
  name: string;
  size?: number;
  mtime?: number;
}

/**
 * JS-сбор файлов (запасной вариант, если нативный модуль недоступен):
 * проверяет расширения по именам и рекурсивно заходит в подпапки (исключая скрытые служебные папки).
 */
async function collectJS(dir: string, out: RawFoundFile[], lrc: Set<string>, root: string) {
  let items: string[] = [];
  try {
    items = await FileSystem.readDirectoryAsync(dir);
  } catch {
    return;
  }

  const subdirs: string[] = [];
  for (const item of items) {
    if (item.startsWith('.')) continue; // скрытые папки и файлы (.woufy, .Trash, .DS_Store)
    const uri = `${dir}${item}`;
    if (AUDIO_RE.test(item)) {
      out.push({ uri, name: item });
    } else if (/\.lrc$/i.test(item)) {
      lrc.add(uri);
    } else if (!NON_DIR_RE.test(item)) {
      subdirs.push(uri);
    }
  }

  if (subdirs.length > 0) {
    await Promise.all(
      subdirs.map(async (s) => {
        try {
          const info = await FileSystem.getInfoAsync(s);
          if (info.exists && info.isDirectory) await collectJS(`${s}/`, out, lrc, root);
        } catch {
          /* ignore */
        }
      })
    );
  }
}

function parseName(baseName: string): { title: string; artist: string } {
  const clean = baseName.replace(/^\d{1,3}[\s.\-_)]+(?=\D)/, '').trim() || baseName;
  if (clean.includes(' - ')) {
    const parts = clean.split(' - ');
    return { artist: parts[0].trim(), title: parts.slice(1).join(' - ').trim() };
  }
  return { title: clean, artist: 'Неизвестный исполнитель' };
}

export interface ScanResult {
  tracks: TrackFile[];
  added: number;
  removed: number;
  /** сколько треков ещё без прочитанных тегов */
  untagged: number;
}

const collator = new Intl.Collator('ru', { numeric: true, sensitivity: 'base' });

let scanning: Promise<ScanResult> | null = null;

/**
 * МГНОВЕННЫЙ показ библиотеки (архитектура Spotify Local Files).
 * Сканирует директорию нативного файлового хранилища за миллисекунды.
 * Новые файлы сразу появляются на экране с парсингом из имени файла,
 * а теги и обложки дочитываются аппаратным ImageIO в фоне без фризов UI.
 */
export function scanLibrary(): Promise<ScanResult> {
  if (scanning) return scanning;
  scanning = doScan().finally(() => {
    scanning = null;
  });
  return scanning;
}

function quickTrack(f: RawFoundFile, id: string, ext: AudioExtension, lrcUri?: string): TrackFile {
  const baseName = f.name.replace(/\.[^/.]+$/, '');
  const fb = parseName(baseName);
  let trackNumber: number | undefined;
  const m = baseName.match(/^(\d{1,3})[\s.\-_)]+\D/);
  if (m) trackNumber = parseInt(m[1], 10);
  return {
    id,
    uri: f.uri,
    filename: f.name,
    title: fb.title,
    artist: fb.artist,
    album: 'Сингл',
    trackNumber,
    lrcUri,
    size: f.size,
    mtime: f.mtime,
    extension: ext,
    tagged: false,
  };
}

async function doScan(): Promise<ScanResult> {
  await ensureAppFolders();

  const cachedTracks = await loadCachedTracks();
  const cacheMap = new Map<string, TrackFile>(cachedTracks.map((t) => [t.id, t]));

  const found: RawFoundFile[] = [];
  const lrcSet = new Set<string>();
  const root = docDir();

  // 1. Быстрое сканирование (нативное через Swift или fallback через JS)
  let nativeSuccess = false;
  if (WoufyFX?.nativeScanDirectory) {
    try {
      const nativeItems = await WoufyFX.nativeScanDirectory(root);
      if (Array.isArray(nativeItems)) {
        for (const item of nativeItems) {
          found.push({
            uri: item.uri,
            name: item.filename,
            size: item.size,
            mtime: item.mtime,
          });
          if (item.lrcUri) lrcSet.add(item.lrcUri);
        }
        nativeSuccess = true;
      }
    } catch (e) {
      console.warn('[fileScanner] nativeScanDirectory fallback to JS:', e);
    }
  }

  if (!nativeSuccess) {
    // Сканируем и корень Documents, и Music, избегая дублирования
    await collectJS(root, found, lrcSet, root);
  }

  const tracks: TrackFile[] = [];
  let added = 0;
  let untagged = 0;
  const seen = new Set<string>();

  for (const f of found) {
    const id = f.uri.startsWith(root) ? f.uri.slice(root.length) : f.uri;
    if (seen.has(id)) continue;
    seen.add(id);

    const lrcUri = f.uri.replace(/\.[^/.]+$/, '.lrc');
    const hasLrc = lrcSet.has(lrcUri);

    const cached = cacheMap.get(id);
    if (cached) {
      // Инкрементальная сверка: если размер и дата изменения не менялись, берём готовые теги из кэша
      const changed =
        (f.mtime && cached.mtime && f.mtime !== cached.mtime) ||
        (f.size && cached.size && f.size !== cached.size);

      if (!changed && cached.tagged) {
        tracks.push({
          ...cached,
          uri: f.uri,
          lrcUri: hasLrc ? lrcUri : undefined,
          size: f.size ?? cached.size,
          mtime: f.mtime ?? cached.mtime,
        });
        continue;
      }
      if (!changed && cached.tagged === false) {
        tracks.push({
          ...cached,
          uri: f.uri,
          lrcUri: hasLrc ? lrcUri : undefined,
          size: f.size ?? cached.size,
          mtime: f.mtime ?? cached.mtime,
        });
        untagged++;
        continue;
      }
    }

    const extMatch = f.name.match(/\.([a-z0-9]+)$/i);
    let ext = (extMatch ? extMatch[1].toLowerCase() : 'mp3') as string;
    if (ext === 'aif') ext = 'aiff';

    tracks.push(quickTrack(f, id, ext as AudioExtension, hasLrc ? lrcUri : undefined));
    added++;
    untagged++;
  }

  const removed = cachedTracks.filter((t) => !seen.has(t.id)).length;
  tracks.sort((a, b) => collator.compare(a.id, b.id));

  // Кэш обновляем сразу, чтобы мгновенный запуск работал даже при внезапном закрытии
  if (added > 0 || removed > 0) saveCachedTracks(tracks);

  // Автоматическая сборка мусора: гарантируем, что на диске остаются ТОЛЬКО обложки существующих треков,
  // а корзина .Trash и временные системные кэши очищаются без бесконечного накопления
  const activeCovers = new Set<string>();
  for (const t of tracks) {
    if (t.artworkUri) {
      const file = t.artworkUri.split('/').pop();
      if (file) activeCovers.add(file);
    }
  }
  cleanupOrphanCovers(activeCovers).catch(() => {});
  cleanupTrash().catch(() => {});
  cleanupTempCache().catch(() => {});
  statsService.cleanupOrphanSessions(new Set(tracks.map((t) => t.id)));

  return { tracks, added, removed, untagged };
}

let enriching = false;

/**
 * Высокоскоростное фоновое чтение тегов и обложек (как в Spotify).
 * При наличии нативного модуля читает через AVURLAsset и сжимает обложки в 512x512 JPEG нативно (ImageIO),
 * минуя медленный JS-bridge и base64.
 */
export async function enrichTracks(
  tracks: TrackFile[],
  onBatch: (updated: TrackFile[]) => void,
  isCancelled: () => boolean = () => false,
  /** id треков, чьи теги и обложки нужны в первую очередь (играющий и ближайшие в очереди) */
  priority: string[] = []
): Promise<boolean> {
  if (enriching) return false;
  const rank = new Map(priority.map((id, i) => [id, i]));
  const todo = tracks
    .filter((t) => t.tagged === false)
    .sort((a, b) => (rank.get(a.id) ?? 1e9) - (rank.get(b.id) ?? 1e9));

  if (todo.length === 0) return true;
  enriching = true;

  try {
    const all = new Map(tracks.map((t) => [t.id, t]));
    let pending: TrackFile[] = [];
    let lastFlush = Date.now();
    let sinceSave = 0;

    const coversDir = `${DATA_DIR}covers/`;
    const useNative = Boolean(WoufyFX?.nativeExtractMetadata);
    const BATCH = useNative ? 32 : 8;

    for (let i = 0; i < todo.length; i += BATCH) {
      if (isCancelled()) break;
      const batch = todo.slice(i, i + BATCH);

      let done: TrackFile[] = [];

      if (useNative && WoufyFX?.nativeExtractMetadata) {
        try {
          const rawMetas = await WoufyFX.nativeExtractMetadata(
            batch.map((t) => ({ id: t.id, uri: t.uri })),
            coversDir
          );
          const metaMap = new Map(rawMetas.map((m) => [m.id, m]));

          done = batch.map((t) => {
            const meta = metaMap.get(t.id);
            const baseName = t.filename.replace(/\.[^/.]+$/, '');
            const fb = parseName(baseName);
            return {
              ...t,
              title: meta?.title?.trim() || fb.title,
              artist: meta?.artist?.trim() || fb.artist,
              album: meta?.album?.trim() || 'Сингл',
              artworkUri: meta?.artworkUri,
              lyrics: meta?.lyrics,
              bpmTag: meta?.bpmTag,
              trackNumber: meta?.trackNumber ?? t.trackNumber,
              discNumber: meta?.discNumber,
              tagged: true,
            };
          });
        } catch (nativeErr) {
          console.warn('[fileScanner] nativeExtractMetadata error, fallback to JS for batch:', nativeErr);
        }
      }

      // Если нативный метод не сработал или отсутствует — JS fallback
      if (done.length === 0) {
        done = await Promise.all(
          batch.map(async (t) => {
            const meta = await parseAudioTags(t.uri, t.id, t.extension);
            const baseName = t.filename.replace(/\.[^/.]+$/, '');
            const fb = parseName(baseName);
            return {
              ...t,
              title: meta.title?.trim() || fb.title,
              artist: meta.artist?.trim() || fb.artist,
              album: meta.album?.trim() || 'Сингл',
              artworkUri: meta.artworkUri,
              lyrics: meta.lyrics,
              syncedLyrics: meta.syncedLyrics,
              bpmTag: meta.bpm,
              trackNumber: meta.trackNumber ?? t.trackNumber,
              discNumber: meta.discNumber,
              tagged: true,
            };
          })
        );
      }

      for (const u of done) all.set(u.id, u);
      pending.push(...done);
      sinceSave += done.length;

      // Первая пачка (играющий трек) отдаётся немедленно
      if (Date.now() - lastFlush > 600 || i === 0) {
        onBatch(pending);
        pending = [];
        lastFlush = Date.now();
      }

      if (sinceSave >= 300) {
        sinceSave = 0;
        saveCachedTracks([...all.values()]);
      }

      await new Promise((r) => setTimeout(r, useNative ? 4 : 12));
    }

    if (pending.length) onBatch(pending);
    await saveCachedTracks([...all.values()]);
  } finally {
    enriching = false;
  }
  return true;
}

/**
 * Наблюдатель за файловой системой на уровне ядра iOS:
 * когда пользователь закидывает файлы через «Файлы», AirDrop или Telegram,
 * сразу вызывается onChanged.
 */
export function startLibraryWatcher(onChanged: () => void): () => void {
  const root = docDir();
  if (WoufyFX?.startDirectoryWatcher) {
    try {
      WoufyFX.startDirectoryWatcher(root);
      const sub = WoufyFX.addListener('onLibraryChanged', onChanged);
      return () => {
        sub.remove();
        WoufyFX?.stopDirectoryWatcher?.();
      };
    } catch (e) {
      console.warn('[fileScanner] failed to start native directory watcher:', e);
    }
  }
  return () => {};
}
