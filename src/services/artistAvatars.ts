import * as FileSystem from 'expo-file-system/legacy';
import { DATA_DIR, ensureDataDir } from './library';
import { TrackFile } from '../types';
import { splitArtists } from './queueOrder';

const AVATARS_FILE = `${DATA_DIR}artist_avatars_v4.json`;

// Официальные проверенные портреты артистов из Apple Music Connect (мгновенная загрузка без задержек)
const VERIFIED_ARTIST_AVATARS: Record<string, string> = {
  nextime:
    'https://is1-ssl.mzstatic.com/image/thumb/AMCArtistImages221/v4/e5/09/a9/e509a98a-a348-a788-9027-51fcad5601e8/file_cropped.png/500x500bb.jpg',
  'даник':
    'https://is1-ssl.mzstatic.com/image/thumb/Features221/v4/4d/eb/9a/4deb9ac1-01bc-48b2-1238-b236f0bc2662/mzl.wrxngoxa.jpg/500x500bb.jpg',
  mildix:
    'https://is1-ssl.mzstatic.com/image/thumb/AMCArtistImages221/v4/f4/93/9f/f4939f40-ca24-1bc9-c887-029c3c540605/file_cropped.png/500x500bb.jpg',
  morgenshtern:
    'https://is1-ssl.mzstatic.com/image/thumb/AMCArtistImages211/v4/73/2d/a0/732da044-3496-a11c-b6ec-f3f493e9abda/ami-identity-f74de44858acf4e46cf73df69aa7c4f8-2026-08-31T19-01-28.637Z_cropped.png/500x500bb.jpg',
};

// В памяти кэш: нормализованное имя артиста -> URL аватарки
const memoryCache = new Map<string, string>();
let isLoaded = false;
let initPromise: Promise<void> | null = null;
const inFlight = new Map<string, Promise<string | null>>();
let saveTimer: ReturnType<typeof setTimeout> | null = null;

function normalizeArtist(artist: string): string {
  if (!artist) return '';
  return artist
    .split(/[\/,&]|(?:\b(?:feat|ft)\.?\b)/i)[0]
    .trim()
    .toLowerCase();
}

function findArtistTracks(artistNorm: string, tracks?: TrackFile[]): TrackFile[] {
  if (!tracks || tracks.length === 0) return [];
  return tracks.filter(
    (t) =>
      normalizeArtist(t.artist) === artistNorm ||
      splitArtists(t.artist).some((a) => a.trim().toLowerCase() === artistNorm)
  );
}

async function fetchWithTimeout(url: string, timeoutMs = 6000, headers?: Record<string, string>): Promise<Response> {
  const ctrl = new AbortController();
  const timeout = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, { headers, signal: ctrl.signal });
  } finally {
    clearTimeout(timeout);
  }
}

async function extractAppleMusicPortrait(artistLinkUrl: string): Promise<string | null> {
  try {
    const res = await fetchWithTimeout(artistLinkUrl, 6000, { 'User-Agent': 'Mozilla/5.0' });
    if (!res.ok) return null;
    const html = await res.text();

    const ogMatch =
      html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i) ||
      html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i);
    const imgUrl = ogMatch?.[1];

    if (
      imgUrl &&
      !imgUrl.includes('apple-music-share') &&
      !imgUrl.includes('default_') &&
      (imgUrl.includes('AMCArtistImages') || imgUrl.includes('Features') || imgUrl.includes('image/thumb/'))
    ) {
      return imgUrl.replace(/\/\d+x\d+.*?(\.(jpg|png|webp))$/i, '/500x500bb.jpg');
    }
  } catch {
    // ignore
  }
  return null;
}

export function initArtistAvatars(): Promise<void> {
  if (isLoaded) return Promise.resolve();
  if (initPromise) return initPromise;

  initPromise = (async () => {
    for (const [k, v] of Object.entries(VERIFIED_ARTIST_AVATARS)) {
      memoryCache.set(k, v);
    }

    try {
      const info = await FileSystem.getInfoAsync(AVATARS_FILE);
      if (info.exists) {
        const raw = await FileSystem.readAsStringAsync(AVATARS_FILE);
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object') {
          for (const [k, v] of Object.entries(parsed)) {
            if (typeof v === 'string' && v.length > 0 && !VERIFIED_ARTIST_AVATARS[k]) {
              memoryCache.set(k, v);
            }
          }
        }
      }
    } catch {
      // игнорируем ошибку чтения
    } finally {
      isLoaded = true;
    }
  })();

  return initPromise;
}

initArtistAvatars().catch(() => {});

function scheduleSave(): void {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    try {
      await ensureDataDir();
      const obj: Record<string, string> = {};
      for (const [k, v] of memoryCache.entries()) {
        if (v && v.length > 0) obj[k] = v;
      }
      await FileSystem.writeAsStringAsync(AVATARS_FILE, JSON.stringify(obj));
    } catch {
      // игнорируем ошибку сохранения
    }
  }, 800);
}

/**
 * Синхронное чтение из памяти для мгновенного рендера без мигания
 */
export function getCachedArtistAvatar(artist: string): string | null {
  const norm = normalizeArtist(artist);
  if (!norm) return null;
  const verified = VERIFIED_ARTIST_AVATARS[norm];
  if (verified) return verified;
  const val = memoryCache.get(norm);
  return val && val.length > 0 ? val : null;
}

/**
 * Загрузить официальную аватарку артиста:
 * 1) Apple Music Connect (с уточнением по трекам библиотеки, чтобы исключить тёзок и чужие фото)
 * 2) Запасной источник: Deezer API (строгий поиск по артисту + треку)
 * 3) Локальный фолбэк: обложка трека артиста из библиотеки, если официального портрета нет
 */
export async function getArtistAvatar(artist: string, tracks?: TrackFile[]): Promise<string | null> {
  const norm = normalizeArtist(artist);
  if (!norm) return null;

  const verified = VERIFIED_ARTIST_AVATARS[norm];
  if (verified) return verified;

  await initArtistAvatars();

  if (memoryCache.has(norm)) {
    const val = memoryCache.get(norm);
    if (val && val.length > 0) return val;
  }

  const existing = inFlight.get(norm);
  if (existing) return existing;

  const task = (async (): Promise<string | null> => {
    const clean = artist.split(/[\/,&]|(?:\b(?:feat|ft)\.?\b)/i)[0].trim();
    if (!clean) return null;

    const artistTracks = findArtistTracks(norm, tracks);
    const sampleTitle = artistTracks.find((t) => t.title && t.title.trim().length > 0)?.title?.trim();

    // 1. Основной источник: Apple Music Connect
    try {
      let artistLinkUrl: string | undefined;

      // Если есть трек этого артиста — сначала пробуем найти точного артиста через его песню (защита от однофамильцев и чужих фото)
      if (sampleTitle) {
        try {
          const songUrl = `https://itunes.apple.com/search?term=${encodeURIComponent(`${clean} ${sampleTitle}`)}&entity=song&country=RU&limit=5`;
          const songRes = await fetchWithTimeout(songUrl, 5000);
          if (songRes.ok) {
            const songData = await songRes.json();
            const songs: any[] = songData?.results || [];
            const songMatch = songs.find(
              (s) => s.artistName && s.artistName.trim().toLowerCase() === clean.toLowerCase() && s.artistViewUrl
            );
            if (songMatch?.artistViewUrl) {
              artistLinkUrl = songMatch.artistViewUrl;
            }
          }
        } catch {
          // переходим к обычному поиску артиста
        }
      }

      if (!artistLinkUrl) {
        const itunesUrl = `https://itunes.apple.com/search?term=${encodeURIComponent(clean)}&entity=musicArtist&country=RU&limit=10`;
        const res = await fetchWithTimeout(itunesUrl, 6000);
        if (res.ok) {
          const data = await res.json();
          const results: any[] = data?.results || [];
          // Только строгое совпадение имени артиста (никакого случайного results[0]!)
          const exactMatches = results.filter(
            (r) => r.artistName && r.artistName.trim().toLowerCase() === clean.toLowerCase()
          );
          const match =
            exactMatches.find((r) => r.artistName === clean) ||
            exactMatches.find(
              (r) =>
                r.primaryGenreName?.includes('Хип') ||
                r.primaryGenreName?.includes('Hip') ||
                r.primaryGenreName?.includes('Поп') ||
                r.primaryGenreName?.includes('Рок')
            ) ||
            exactMatches[0];

          if (match?.artistLinkUrl) {
            artistLinkUrl = match.artistLinkUrl;
          }
        }
      }

      if (artistLinkUrl) {
        const squareUrl = await extractAppleMusicPortrait(artistLinkUrl);
        if (squareUrl) {
          memoryCache.set(norm, squareUrl);
          scheduleSave();
          return squareUrl;
        }
      }
    } catch {
      // сетевая ошибка Apple Music
    }

    // 2. Запасной источник: Deezer API (строгий поиск по имени + поиск по треку)
    try {
      const deezerUrl = `https://api.deezer.com/search/artist?q=${encodeURIComponent(clean)}&limit=10`;
      const res = await fetchWithTimeout(deezerUrl, 5000);
      if (res.ok) {
        const json = await res.json();
        const list: any[] = json?.data || [];
        const exact = list.find((item) => item?.name && item.name.trim().toLowerCase() === clean.toLowerCase());
        const pic = exact?.picture_xl || exact?.picture_big || exact?.picture_medium;
        if (pic && !pic.includes('2e018122cb56986277102d2041a592c8')) {
          memoryCache.set(norm, pic);
          scheduleSave();
          return pic;
        }
      }

      if (sampleTitle) {
        const dzTrackUrl = `https://api.deezer.com/search?q=${encodeURIComponent(`artist:"${clean}" track:"${sampleTitle}"`)}&limit=5`;
        const trRes = await fetchWithTimeout(dzTrackUrl, 5000);
        if (trRes.ok) {
          const trJson = await trRes.json();
          const trList: any[] = trJson?.data || [];
          const matched = trList.find(
            (item) => item?.artist?.name && item.artist.name.trim().toLowerCase() === clean.toLowerCase()
          );
          const pic = matched?.artist?.picture_xl || matched?.artist?.picture_big || matched?.artist?.picture_medium;
          if (pic && !pic.includes('2e018122cb56986277102d2041a592c8')) {
            memoryCache.set(norm, pic);
            scheduleSave();
            return pic;
          }
        }
      }
    } catch {
      // игнорируем
    }

    // 3. Финальный запасной вариант: обложка трека этого артиста из библиотеки пользователя
    const localArt = artistTracks.find((t) => t.artworkUri && t.artworkUri.length > 0)?.artworkUri;
    if (localArt) {
      return localArt;
    }

    return null;
  })().finally(() => {
    inFlight.delete(norm);
  });

  inFlight.set(norm, task);
  return task;
}
