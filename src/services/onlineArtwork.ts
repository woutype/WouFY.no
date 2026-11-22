import * as FileSystem from 'expo-file-system/legacy';
import { DATA_DIR } from './library';

export interface OnlineCoverResult {
  thumbnailUrl: string;
  highResUrl: string;
  albumName: string;
  artistName: string;
  trackName: string;
}

function hash(str: string): string {
  let h = 5381;
  for (let i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

/**
 * Поиск обложек высокого разрешения через публичный iTunes Search API (1000x1000)
 */
export async function searchOnlineCovers(artist: string, title: string): Promise<OnlineCoverResult[]> {
  try {
    const cleanArtist = artist.replace(/[\/\\]/g, ' ').trim();
    const cleanTitle = title.replace(/\(.*?\)|\[.*?\]/g, '').trim();
    const query = `${cleanArtist} ${cleanTitle}`.trim();
    if (!query) return [];

    const url = `https://itunes.apple.com/search?term=${encodeURIComponent(query)}&entity=song&limit=6`;
    const res = await fetch(url);
    if (!res.ok) return [];

    const json = await res.json();
    const results: any[] = json.results ?? [];

    const list: OnlineCoverResult[] = [];
    const seen = new Set<string>();

    for (const item of results) {
      if (!item.artworkUrl100) continue;
      const thumb = item.artworkUrl100;
      // Подменяем 100x100 на оригинальное качество Apple Music 1000x1000
      const highRes = thumb.replace('100x100bb.jpg', '1000x1000bb.jpg');
      if (seen.has(highRes)) continue;
      seen.add(highRes);

      list.push({
        thumbnailUrl: thumb,
        highResUrl: highRes,
        albumName: item.collectionName || 'Альбом',
        artistName: item.artistName || artist,
        trackName: item.trackName || title,
      });
    }

    return list;
  } catch (e) {
    console.warn('[onlineArtwork] search failed:', e);
    return [];
  }
}

/**
 * Скачивание выбранной обложки в локальный кэш приложения (с поддержкой фоллбека по списку URL и проверкой целостности файла)
 */
export async function downloadCoverToCache(
  remoteUrlOrUrls: string | (string | undefined)[],
  trackId: string
): Promise<string | null> {
  const urls = (Array.isArray(remoteUrlOrUrls) ? remoteUrlOrUrls : [remoteUrlOrUrls]).filter(
    (u): u is string => typeof u === 'string' && /^https?:\/\//i.test(u.trim())
  );
  if (urls.length === 0) return null;

  const coversDir = `${DATA_DIR}covers/`;
  const info = await FileSystem.getInfoAsync(coversDir);
  if (!info.exists) {
    await FileSystem.makeDirectoryAsync(coversDir, { intermediates: true }).catch(() => {});
  }

  for (const url of urls) {
    const filename = `online_${hash(`${trackId}_${url}`)}_${Date.now()}.jpg`;
    const targetPath = `${coversDir}${filename}`;
    try {
      const res = await FileSystem.downloadAsync(url, targetPath);
      if (res.status >= 200 && res.status < 300) {
        const fileInfo = await FileSystem.getInfoAsync(targetPath);
        if (fileInfo.exists && 'size' in fileInfo && (fileInfo.size ?? 0) > 512) {
          return res.uri;
        }
      }
    } catch {
      /* пробуем следующий URL */
    }
    await FileSystem.deleteAsync(targetPath, { idempotent: true }).catch(() => {});
  }
  return null;
}
