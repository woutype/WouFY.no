import * as FileSystem from 'expo-file-system/legacy';
import { Asset } from 'expo-asset';
import { parseID3Tags } from './id3Parser';
import { getState, patchState, loadCachedTracks, saveCachedTracks } from './library';
import { AudioExtension, TrackFile } from '../types';

/** Папка, в которую пользователь кладёт музыку (видна в Файлах → На iPhone → Woufy → Music) */
export const MUSIC_DIR_NAME = 'Music';
const AUDIO_RE = /\.(mp3|m4a|aac|wav|flac|aiff?)$/i;

const docDir = () => FileSystem.documentDirectory ?? '';
export const musicDir = () => `${docDir()}${MUSIC_DIR_NAME}/`;

/**
 * Создаёт собственные папки приложения. Файл-подсказка в корне Documents гарантирует,
 * что iOS покажет папку Woufy в приложении «Файлы» даже если музыки ещё нет.
 */
export async function ensureAppFolders(): Promise<void> {
  try {
    const dir = musicDir();
    const info = await FileSystem.getInfoAsync(dir);
    if (!info.exists) await FileSystem.makeDirectoryAsync(dir, { intermediates: true });

    const hint = `${docDir()}Положи музыку в папку Music.txt`;
    const hintInfo = await FileSystem.getInfoAsync(hint);
    if (!hintInfo.exists) {
      await FileSystem.writeAsStringAsync(
        hint,
        'Woufy\n\nПоложи свою музыку (mp3, m4a, wav, flac) или целую папку с музыкой в папку Music рядом с этим файлом.\n' +
          'Чтобы текст песни был синхронизирован, положи рядом с треком файл .lrc с тем же именем.\n'
      );
    }
  } catch (e) {
    console.warn('[fileScanner] ensureAppFolders failed:', e);
  }
}

/** Копирует демо-треки при первом запуске, только если библиотека пуста */
async function seedSamples(): Promise<void> {
  const dest = musicDir();
  const files: [any, string][] = [
    [require('../../assets/sample.mp3'), 'NEXTIME - ТАЗОМ.mp3'],
    [require('../../assets/sample2.mp3'), 'NEXTIME - КИС Ю.mp3'],
  ];
  for (const [mod, name] of files) {
    try {
      const target = `${dest}${name}`;
      const info = await FileSystem.getInfoAsync(target);
      if (info.exists) continue;
      const asset = Asset.fromModule(mod);
      await asset.downloadAsync();
      if (asset.localUri) await FileSystem.copyAsync({ from: asset.localUri, to: target });
    } catch (e) {
      console.warn('[fileScanner] seed failed:', e);
    }
  }
}

/**
 * Быстрый сбор файлов:
 * Не вызывает getInfoAsync на каждый отдельный аудиофайл (что отнимало 30+ секунд на 1300 файлов),
 * а проверяет расширения по именам и рекурсивно заходит только в подпапки.
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
    } else {
      subdirs.push(uri);
    }
  }

  // Проверяем только потенциальные подкаталоги
  if (subdirs.length > 0) {
    await Promise.all(
      subdirs.map(async (s) => {
        try {
          const info = await FileSystem.getInfoAsync(s);
          if (info.exists && info.isDirectory) {
            await collect(`${s}/`, out, lrc);
          }
        } catch {
          /* ignore */
        }
      })
    );
  }
}

function parseName(baseName: string): { title: string; artist: string } {
  if (baseName.includes(' - ')) {
    const parts = baseName.split(' - ');
    return {
      artist: parts[0].trim(),
      title: parts.slice(1).join(' - ').trim(),
    };
  }
  return {
    title: baseName,
    artist: 'Неизвестный исполнитель',
  };
}

/**
 * Рекурсивно сканирует Documents (в том числе вложенные папки).
 * Использует дисковый кэш: при повторном запуске все 1300+ треков
 * загружаются мгновенно (за 50–100 мс), а новые файлы парсятся параллельно пачками.
 */
export async function scanLibrary(): Promise<TrackFile[]> {
  await ensureAppFolders();

  const cachedTracks = await loadCachedTracks();
  const cacheMap = new Map<string, TrackFile>(cachedTracks.map((t) => [t.id, t]));

  let found: { uri: string; name: string }[] = [];
  let lrcSet = new Set<string>();
  await collect(docDir(), found, lrcSet);

  if (found.length === 0 && !getState().samplesSeeded) {
    await seedSamples();
    patchState({ samplesSeeded: true });
    found = [];
    lrcSet = new Set<string>();
    await collect(docDir(), found, lrcSet);
  }

  const root = docDir();
  const tracks: TrackFile[] = [];
  const toParse: { f: { uri: string; name: string }; id: string; ext: AudioExtension }[] = [];

  for (const f of found) {
    const id = f.uri.startsWith(root) ? f.uri.slice(root.length) : f.uri;
    const lrcUri = f.uri.replace(/\.[^/.]+$/, '.lrc');
    const hasLrc = lrcSet.has(lrcUri);

    const cached = cacheMap.get(id);
    if (cached) {
      // Мгновенное попадание в кэш! Обновляем только наличие внешнего .lrc при необходимости
      if (hasLrc && cached.lrcUri !== lrcUri) {
        cached.lrcUri = lrcUri;
      }
      tracks.push(cached);
      continue;
    }

    const extMatch = f.name.match(/\.([a-z0-9]+)$/i);
    let ext = (extMatch ? extMatch[1].toLowerCase() : 'mp3') as AudioExtension | 'aif';
    if (ext === ('aif' as string)) ext = 'aiff';

    toParse.push({ f, id, ext: ext as AudioExtension });
  }

  // Если есть новые треки, которых ещё не было в кэше — парсим их параллельно пачками по 12 штук
  if (toParse.length > 0) {
    const BATCH_SIZE = 12;
    for (let i = 0; i < toParse.length; i += BATCH_SIZE) {
      const batch = toParse.slice(i, i + BATCH_SIZE);
      const parsedBatch = await Promise.all(
        batch.map(async ({ f, id, ext }) => {
          const baseName = f.name.replace(/\.[^/.]+$/, '');
          const fallback = parseName(baseName);
          const meta = ext === 'mp3' ? await parseID3Tags(f.uri, id) : {};

          let title = meta.title?.trim() || fallback.title;
          let artist = meta.artist?.trim() || fallback.artist;
          let album = meta.album?.trim() || 'Сингл';

          let trackNumber = meta.trackNumber;
          if (!trackNumber) {
            const match = (title || baseName).match(/^(\d+)[\.\s\-_]/);
            if (match) trackNumber = parseInt(match[1], 10);
          }

          const lrcUri = f.uri.replace(/\.[^/.]+$/, '.lrc');
          const track: TrackFile = {
            id,
            uri: f.uri,
            filename: f.name,
            title,
            artist,
            album,
            artworkUri: meta.artworkUri,
            lyrics: meta.lyrics,
            syncedLyrics: meta.syncedLyrics,
            lrcUri: lrcSet.has(lrcUri) ? lrcUri : undefined,
            bpmTag: meta.bpm,
            trackNumber,
            extension: ext,
          };
          return track;
        })
      );
      tracks.push(...parsedBatch);
    }

    // Сохраняем обновлённый кэш на диск
    await saveCachedTracks(tracks);
  } else if (cachedTracks.length !== tracks.length) {
    // Если какие-то файлы были удалены пользователем из папки
    await saveCachedTracks(tracks);
  }

  tracks.sort((a, b) => a.id.localeCompare(b.id, 'ru'));
  return tracks;
}
