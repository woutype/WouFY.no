import * as FileSystem from 'expo-file-system/legacy';
import { DATA_DIR, ensureDataDir } from './library';
import { TrackFile } from '../types';

const AVATARS_FILE = `${DATA_DIR}artist_avatars_v3.json`;

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
let saveTimer: ReturnType<typeof setTimeout> | null = null;

function normalizeArtist(artist: string): string {
  if (!artist) return '';
  return artist
    .split(/[\/,&]|(?:\b(?:feat|ft)\.?\b)/i)[0]
    .trim()
    .toLowerCase();
}

export async function initArtistAvatars(): Promise<void> {
  if (isLoaded) return;
  isLoaded = true;

  // Инициализируем проверенными официальными портретами
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
          if (typeof v === 'string' && !VERIFIED_ARTIST_AVATARS[k]) {
            memoryCache.set(k, v);
          }
        }
      }
    }
  } catch (e) {
    // игнорируем ошибку чтения
  }
}

// Запускаем асинхронную инициализацию сразу при импорте
initArtistAvatars().catch(() => {});

function scheduleSave(): void {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    try {
      await ensureDataDir();
      const obj: Record<string, string> = {};
      for (const [k, v] of memoryCache.entries()) {
        obj[k] = v;
      }
      await FileSystem.writeAsStringAsync(AVATARS_FILE, JSON.stringify(obj));
    } catch (e) {
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
 * Загрузить официальную аватарку артиста из проверенного источника (Apple Music Connect)
 * Без фолбэка на обложки треков — только официальные портреты исполнителей!
 */
export async function getArtistAvatar(artist: string, _tracks?: TrackFile[]): Promise<string | null> {
  const norm = normalizeArtist(artist);
  if (!norm) return null;

  const verified = VERIFIED_ARTIST_AVATARS[norm];
  if (verified) return verified;

  await initArtistAvatars();

  if (memoryCache.has(norm)) {
    const val = memoryCache.get(norm);
    return val && val.length > 0 ? val : null;
  }

  const clean = artist.split(/[\/,&]|(?:\b(?:feat|ft)\.?\b)/i)[0].trim();
  if (!clean) {
    memoryCache.set(norm, '');
    return null;
  }

  // 1. Поиск официального портрета через Apple Music Connect (iTunes Search RU + профиль артиста)
  try {
    const itunesUrl = `https://itunes.apple.com/search?term=${encodeURIComponent(clean)}&entity=musicArtist&country=RU&limit=10`;
    const ctrl = new AbortController();
    const timeout = setTimeout(() => ctrl.abort(), 6000);
    const res = await fetch(itunesUrl, { signal: ctrl.signal });
    clearTimeout(timeout);

    if (res.ok) {
      const data = await res.json();
      const results: any[] = data?.results || [];
      const match =
        results.find((r) => r.artistName === clean) ||
        results.find(
          (r) =>
            r.artistName?.toLowerCase() === clean.toLowerCase() &&
            (r.primaryGenreName?.includes('Хип') || r.primaryGenreName?.includes('Hip') || r.primaryGenreName?.includes('Поп'))
        ) ||
        results.find((r) => r.artistName?.toLowerCase() === clean.toLowerCase()) ||
        results.find((r) => r.artistName?.toLowerCase().includes(clean.toLowerCase())) ||
        results[0];

      if (match?.artistLinkUrl) {
        const pageCtrl = new AbortController();
        const pageTimeout = setTimeout(() => pageCtrl.abort(), 6000);
        const html = await fetch(match.artistLinkUrl, {
          headers: { 'User-Agent': 'Mozilla/5.0' },
          signal: pageCtrl.signal,
        }).then((r) => r.text());
        clearTimeout(pageTimeout);

        const ogMatch = html.match(/<meta property=["']og:image["'] content=["']([^"']+)["']/i);
        let imgUrl = ogMatch?.[1];

        // Отсекаем стандартные заглушки без фото
        if (
          imgUrl &&
          !imgUrl.includes('apple-music-share') &&
          !imgUrl.includes('default_') &&
          (imgUrl.includes('AMCArtistImages') || imgUrl.includes('Features') || imgUrl.includes('image/thumb/'))
        ) {
          // Получаем квадратный HD-портрет артиста 500x500
          const squareUrl = imgUrl.replace(/\/\d+x\d+.*?(\.(jpg|png|webp))$/i, '/500x500bb.jpg');
          memoryCache.set(norm, squareUrl);
          scheduleSave();
          return squareUrl;
        }
      }
    }
  } catch (e) {
    // сетевая ошибка Apple Music
  }

  // 2. Дополнительный источник: Deezer API (только при строгом совпадении имени артиста)
  try {
    const deezerUrl = `https://api.deezer.com/search/artist?q=${encodeURIComponent(clean)}`;
    const ctrl = new AbortController();
    const timeout = setTimeout(() => ctrl.abort(), 5000);
    const res = await fetch(deezerUrl, { signal: ctrl.signal });
    clearTimeout(timeout);

    if (res.ok) {
      const json = await res.json();
      const first = json.data?.[0];
      if (
        first &&
        first.name &&
        first.name.toLowerCase() === clean.toLowerCase()
      ) {
        const pic = first.picture_big || first.picture_medium;
        if (pic && !pic.includes('2e018122cb56986277102d2041a592c8')) {
          memoryCache.set(norm, pic);
          scheduleSave();
          return pic;
        }
      }
    }
  } catch (e) {
    // игнорируем
  }

  // Если официальный портрет не найден — НЕ подставляем случайные обложки треков!
  // Запоминаем пустую строку, чтобы рендерить стильный монохромный силуэт
  memoryCache.set(norm, '');
  scheduleSave();
  return null;
}
