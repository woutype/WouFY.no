import * as FileSystem from 'expo-file-system/legacy';
import { Asset } from 'expo-asset';
import { parseID3Tags } from './id3Parser';
import { getState, patchState } from './library';
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

const metaCache = new Map<string, Awaited<ReturnType<typeof parseID3Tags>>>();

async function collect(dir: string, out: { uri: string; name: string; size?: number }[], lrc: Set<string>) {
  let items: string[] = [];
  try {
    items = await FileSystem.readDirectoryAsync(dir);
  } catch (e) {
    console.warn(`[fileScanner] cannot read ${dir}:`, e);
    return;
  }
  for (const item of items) {
    if (item.startsWith('.')) continue;
    const uri = `${dir}${item}`;
    try {
      const info = await FileSystem.getInfoAsync(uri);
      if (!info.exists) continue;
      if (info.isDirectory) {
        await collect(`${uri}/`, out, lrc);
      } else if (AUDIO_RE.test(item)) {
        out.push({ uri, name: item, size: info.size });
      } else if (/\.lrc$/i.test(item)) {
        lrc.add(uri);
      }
    } catch {
      /* пропускаем проблемный файл */
    }
  }
}

/** Рекурсивно сканирует Documents (в том числе вложенные папки, например «MusicHub») */
export async function scanLibrary(): Promise<TrackFile[]> {
  await ensureAppFolders();

  let found: { uri: string; name: string; size?: number }[] = [];
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

  for (const f of found) {
    const id = f.uri.startsWith(root) ? f.uri.slice(root.length) : f.uri;
    const extMatch = f.name.match(/\.([a-z0-9]+)$/i);
    let ext = (extMatch ? extMatch[1].toLowerCase() : 'mp3') as AudioExtension | 'aif';
    if (ext === ('aif' as string)) ext = 'aiff';

    const cacheKey = `${id}|${f.size ?? 0}`;
    let meta = metaCache.get(cacheKey);
    if (!meta) {
      meta = ext === 'mp3' ? await parseID3Tags(f.uri, cacheKey) : {};
      metaCache.set(cacheKey, meta);
    }

    const lrcUri = f.uri.replace(/\.[^/.]+$/, '.lrc');

    tracks.push({
      id,
      uri: f.uri,
      filename: f.name,
      title: meta.title || f.name.replace(/\.[^/.]+$/, ''),
      artist: meta.artist || 'Неизвестный исполнитель',
      album: meta.album,
      artworkUri: meta.artworkUri,
      lyrics: meta.lyrics,
      syncedLyrics: meta.syncedLyrics,
      lrcUri: lrcSet.has(lrcUri) ? lrcUri : undefined,
      bpmTag: meta.bpm,
      size: f.size,
      extension: ext as AudioExtension,
    });
  }

  tracks.sort((a, b) => a.id.localeCompare(b.id, 'ru'));
  return tracks;
}
