import * as FileSystem from 'expo-file-system/legacy';
import { parseAudioTags } from './id3Parser';
import { loadCachedTracks, saveCachedTracks, DATA_DIR, LEGACY_DIR, ensureDataDir } from './library';
import { AudioExtension, TrackFile } from '../types';

/** Папка, в которую пользователь кладёт музыку (Файлы → На iPhone → WouFY.no → Music). Только треки — никаких служебных файлов. */
export const MUSIC_DIR_NAME = 'Music';
const AUDIO_RE = /\.(mp3|m4a|aac|wav|flac|aiff?)$/i;
const NON_DIR_RE = /\.(jpe?g|png|txt|cue|log|m3u8?|pdf|nfo|webp|gif|heic|ds_store)$/i;

const docDir = () => FileSystem.documentDirectory ?? '';
export const musicDir = () => `${docDir()}${MUSIC_DIR_NAME}/`;

let cleaned = false;

/**
 * Одноразовая уборка наследия старых версий:
 *  • файл-подсказка «Положи музыку в папку Music.txt» в корне Documents — удаляется;
 *  • папка lyrics_cache/ в корне Documents → переезжает в служебную папку и удаляется;
 *  • аудиофайлы, лежащие в корне Documents, переезжают в Music.
 * Служебные данные приложения теперь живут вне Documents и вне Music.
 */
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

    // кэш текстов в скрытой .woufy → в новую папку
    const hiddenLyrics = `${LEGACY_DIR}lyrics_cache/`;
    if (hiddenLyrics !== `${DATA_DIR}lyrics_cache/`) {
      const hl = await FileSystem.getInfoAsync(hiddenLyrics);
      if (hl.exists && hl.isDirectory) {
        const target = `${DATA_DIR}lyrics_cache/`;
        await FileSystem.makeDirectoryAsync(target, { intermediates: true }).catch(() => {});
        const names = await FileSystem.readDirectoryAsync(hiddenLyrics).catch(() => [] as string[]);
        for (const n of names) {
          await FileSystem.moveAsync({ from: `${hiddenLyrics}${n}`, to: `${target}${n}` }).catch(() => {});
        }
      }
    }

    // музыка из корня → Music
    const top = await FileSystem.readDirectoryAsync(root).catch(() => [] as string[]);
    for (const n of top) {
      if (AUDIO_RE.test(n)) {
        await FileSystem.moveAsync({ from: `${root}${n}`, to: `${musicDir()}${n}` }).catch(() => {});
      }
    }
  } catch (e) {
    console.warn('[fileScanner] legacy cleanup failed:', e);
  }
}

/** Создаёт папку Music. Больше ничего в Documents не пишется. */
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

/**
 * Быстрый сбор файлов: не вызывает getInfoAsync на каждый аудиофайл, а проверяет расширения по именам
 * и рекурсивно заходит только в подпапки.
 */
async function collect(dir: string, out: { uri: string; name: string }[], lrc: Set<string>) {
  let items: string[] = [];
  try {
    items = await FileSystem.readDirectoryAsync(dir);
  } catch {
    return;
  }

  const subdirs: string[] = [];
  for (const item of items) {
    if (item.startsWith('.')) continue;
    const uri = `${dir}${item}`;
    if (AUDIO_RE.test(item)) {
      out.push({ uri, name: item });
    } else if (/\.lrc$/i.test(item)) {
      lrc.add(uri);
    } else if (!NON_DIR_RE.test(item)) {
      subdirs.push(uri); // вероятная подпапка (в том числе с точкой в имени: «Vol. 2»)
    }
  }

  if (subdirs.length > 0) {
    await Promise.all(
      subdirs.map(async (s) => {
        try {
          const info = await FileSystem.getInfoAsync(s);
          if (info.exists && info.isDirectory) await collect(`${s}/`, out, lrc);
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
 * МГНОВЕННЫЙ показ библиотеки (как скачанные файлы в Spotify).
 * Здесь только чтение списка файлов (миллисекунды на 1300 треков): новые файлы сразу попадают в список
 * с названием/артистом из имени файла. Теги и обложки читаются потом, в фоне — см. enrichTracks().
 * Параллельные вызовы объединяются в один.
 */
export function scanLibrary(): Promise<ScanResult> {
  if (scanning) return scanning;
  scanning = doScan().finally(() => {
    scanning = null;
  });
  return scanning;
}

function quickTrack(f: { uri: string; name: string }, id: string, ext: AudioExtension, lrcUri?: string): TrackFile {
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
    extension: ext,
    tagged: false,
  };
}

async function doScan(): Promise<ScanResult> {
  await ensureAppFolders();

  const cachedTracks = await loadCachedTracks();
  const cacheMap = new Map<string, TrackFile>(cachedTracks.map((t) => [t.id, t]));

  const found: { uri: string; name: string }[] = [];
  const lrcSet = new Set<string>();
  await collect(musicDir(), found, lrcSet);

  const root = docDir();
  const tracks: TrackFile[] = [];
  let added = 0;
  let untagged = 0;
  const seen = new Set<string>();

  for (const f of found) {
    const id = f.uri.startsWith(root) ? f.uri.slice(root.length) : f.uri;
    seen.add(id);
    const lrcUri = f.uri.replace(/\.[^/.]+$/, '.lrc');
    const hasLrc = lrcSet.has(lrcUri);

    const cached = cacheMap.get(id);
    if (cached) {
      tracks.push({ ...cached, uri: f.uri, lrcUri: hasLrc ? lrcUri : undefined });
      if (cached.tagged === false) untagged++;
      continue;
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
  // кэш обновляем сразу, чтобы следующий запуск был мгновенным даже если фоновое чтение тегов прервут
  if (added > 0 || removed > 0) saveCachedTracks(tracks);
  return { tracks, added, removed, untagged };
}

let enriching = false;

/**
 * Фоновое чтение тегов и обложек. Небольшими пачками, с «дыханием» между ними, чтобы интерфейс не подтормаживал.
 * onBatch получает обновлённые треки (раз в ~1.2 с), полный список по завершении сохраняется в кэш.
 * Возвращает false, если чтение уже идёт.
 */
export async function enrichTracks(
  tracks: TrackFile[],
  onBatch: (updated: TrackFile[]) => void,
  isCancelled: () => boolean = () => false
): Promise<boolean> {
  if (enriching) return false;
  const todo = tracks.filter((t) => t.tagged === false);
  if (todo.length === 0) return true;
  enriching = true;
  try {
    const all = new Map(tracks.map((t) => [t.id, t]));
    let pending: TrackFile[] = [];
    let lastFlush = Date.now();
    let sinceSave = 0;
    const BATCH = 6;
    for (let i = 0; i < todo.length; i += BATCH) {
      if (isCancelled()) break;
      const batch = todo.slice(i, i + BATCH);
      const done = await Promise.all(
        batch.map(async (t) => {
          const meta = await parseAudioTags(t.uri, t.id, t.extension);
          const baseName = t.filename.replace(/\.[^/.]+$/, '');
          const fb = parseName(baseName);
          const upd: TrackFile = {
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
          return upd;
        })
      );
      for (const u of done) all.set(u.id, u);
      pending.push(...done);
      sinceSave += done.length;
      if (Date.now() - lastFlush > 1200) {
        onBatch(pending);
        pending = [];
        lastFlush = Date.now();
      }
      if (sinceSave >= 150) {
        sinceSave = 0;
        saveCachedTracks([...all.values()]);
      }
      await new Promise((r) => setTimeout(r, 12)); // отдаём поток интерфейсу
    }
    if (pending.length) onBatch(pending);
    await saveCachedTracks([...all.values()]);
  } finally {
    enriching = false;
  }
  return true;
}
