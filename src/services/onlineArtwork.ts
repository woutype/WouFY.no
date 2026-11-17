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
 * Скачивание выбранной обложки в локальный кэш приложения
 */
export async function downloadCoverToCache(remoteUrl: string, trackId: string): Promise<string | null> {
  const coversDir = `${DATA_DIR}covers/`;
  const info = await FileSystem.getInfoAsync(coversDir);
  if (!info.exists) {
    await FileSystem.makeDirectoryAsync(coversDir, { intermediates: true }).catch(() => {});
  }

  const filename = `online_${hash(trackId)}_${Date.now()}.jpg`;
  const targetPath = `${coversDir}${filename}`;

  const res = await FileSystem.downloadAsync(remoteUrl, targetPath);
  if (res.status < 200 || res.status >= 300) {
    await FileSystem.deleteAsync(targetPath, { idempotent: true }).catch(() => {});
    return null;
  }
  return res.uri;
}
