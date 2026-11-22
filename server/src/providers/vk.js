import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

const VK_API_BASE = 'https://api.vk.com/method';
const VK_API_VERSION = '5.131';
const DEFAULT_UA =
  process.env.VK_USER_AGENT ||
  'KateMobileAndroid/56 lite-460 (Android 4.4.2; SDK 19; x86; unknown Android SDK built for x86; en)';

/** Маппинг VK genre_id -> название жанра (из референса vkms-src) */
const VK_GENRES = {
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

/** Краткосрочный кэш найденных треков (TTL 30 мин), чтобы /metadata и /download не делали лишних запросов */
const trackCache = new Map();
const CACHE_TTL_MS = 30 * 60 * 1000;

function cacheSet(id, item) {
  trackCache.set(id, { item, expiresAt: Date.now() + CACHE_TTL_MS });
  if (trackCache.size > 600) {
    const firstKey = trackCache.keys().next().value;
    if (firstKey) trackCache.delete(firstKey);
  }
}

function cacheGet(id) {
  const entry = trackCache.get(id);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    trackCache.delete(id);
    return null;
  }
  return entry.item;
}

function getVkToken() {
  return (process.env.VK_TOKEN || '').trim();
}

export function isVkConfigured() {
  return getVkToken().length > 0;
}

async function callVkApi(method, params = {}) {
  const token = getVkToken();
  if (!token) throw new Error('VK_TOKEN не задан на сервере');

  const body = new URLSearchParams({
    ...params,
    access_token: token,
    v: VK_API_VERSION,
  });

  const res = await fetch(`${VK_API_BASE}/${method}`, {
    method: 'POST',
    headers: {
      'User-Agent': DEFAULT_UA,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body,
  });

  if (!res.ok) {
    throw new Error(`VK HTTP ${res.status}`);
  }

  const json = await res.json();
  if (json.error) {
    throw new Error(`VK API ${json.error.error_code}: ${json.error.error_msg}`);
  }
  return json.response;
}

function pickBestCover(raw) {
  const thumb = raw?.album?.thumb;
  if (!thumb || typeof thumb !== 'object') return { coverUrl: undefined, thumbnailUrl: undefined };

  let bestUrl;
  let bestSize = 0;
  let smallUrl;
  let smallSize = Infinity;

  for (const [k, v] of Object.entries(thumb)) {
    if (typeof v !== 'string' || !v.startsWith('http')) continue;
    const size = Number(k.split('_')[1]);
    if (Number.isFinite(size) && size > 0) {
      if (size > bestSize) {
        bestSize = size;
        bestUrl = v;
      }
      if (size < smallSize) {
        smallSize = size;
        smallUrl = v;
      }
    } else if (!bestUrl) {
      bestUrl = v;
    }
  }
  return { coverUrl: bestUrl || smallUrl, thumbnailUrl: smallUrl || bestUrl };
}

function normalizeVkAudio(raw) {
  if (!raw || raw.owner_id == null || raw.id == null) return null;
  const idParts = [String(raw.owner_id), String(raw.id)];
  if (raw.access_key) idParts.push(String(raw.access_key));
  const id = `vk:${idParts.join('_')}`;

  const { coverUrl, thumbnailUrl } = pickBestCover(raw);

  return {
    id,
    vkAudioId: idParts.join('_'),
    title: String(raw.title || '').trim() || 'Без названия',
    subtitle: raw.subtitle ? String(raw.subtitle).trim() : undefined,
    artist: String(raw.artist || '').trim() || 'Неизвестный исполнитель',
    album: raw.album?.title ? String(raw.album.title).trim() : undefined,
    year: Number.isFinite(Number(raw.album?.year)) ? Number(raw.album.year) : undefined,
    genre: VK_GENRES[Number(raw.genre_id)] || undefined,
    duration: Number.isFinite(Number(raw.duration)) ? Number(raw.duration) : undefined,
    coverUrl,
    thumbnailUrl,
    explicit: Boolean(raw.is_explicit),
    hasLyrics: Boolean(raw.lyrics_id),
    lyricsId: raw.lyrics_id ? Number(raw.lyrics_id) : undefined,
    streamUrl: typeof raw.url === 'string' && raw.url ? raw.url : undefined,
    extension: 'mp3',
  };
}

export async function searchVkTracks({ q, artist, title, limit = 25 }) {
  const query = (q || [artist, title].filter(Boolean).join(' ')).trim();
  if (!query) return [];

  const resp = await callVkApi('audio.search', {
    q: query,
    auto_complete: '1',
    sort: '2', // по популярности
    count: String(Math.min(50, Math.max(1, limit))),
  });

  const rawItems = Array.isArray(resp?.items) ? resp.items : [];
  const results = [];
  for (const raw of rawItems) {
    if (!raw?.url && !raw?.owner_id) continue;
    const item = normalizeVkAudio(raw);
    if (!item) continue;
    cacheSet(item.id, item);
    results.push({
      id: item.id,
      title: item.title,
      subtitle: item.subtitle,
      artist: item.artist,
      album: item.album,
      year: item.year,
      genre: item.genre,
      duration: item.duration,
      coverUrl: item.coverUrl,
      thumbnailUrl: item.thumbnailUrl,
      explicit: item.explicit,
      hasLyrics: item.hasLyrics,
      extension: 'mp3',
    });
  }
  return results;
}

export async function resolveVkTrack(id) {
  const cached = cacheGet(id);
  const vkAudioId = id.replace(/^vk:/, '');

  // Если в кэше нет или нет прямой ссылки на поток — обновляем через audio.getById (как в vkms-src)
  if (cached && cached.streamUrl) {
    return cached;
  }

  const resp = await callVkApi('audio.getById', { audios: vkAudioId });
  const raw = Array.isArray(resp) ? resp[0] : null;
  if (!raw) return cached;

  const fresh = normalizeVkAudio(raw);
  if (fresh) cacheSet(fresh.id, fresh);
  return fresh || cached;
}

export async function fetchVkLyrics(lyricsId) {
  if (!lyricsId) return undefined;
  try {
    const resp = await callVkApi('audio.getLyrics', { lyrics_id: String(lyricsId) });
    return typeof resp?.text === 'string' && resp.text.trim() ? resp.text.trim() : undefined;
  } catch {
    return undefined;
  }
}

function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    const proc = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    proc.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
      if (stderr.length > 4000) stderr = stderr.slice(-4000);
    });
    proc.on('error', reject);
    proc.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg exited with code ${code}: ${stderr.slice(-400)}`));
    });
  });
}

/**
 * Скачивает поток VK (HLS .m3u8 или прямой .mp3), конвертирует в MP3 320 kbps
 * и вшивает ID3v2.3 теги + обложку (APIC) через ffmpeg.
 */
export async function downloadVkTrackToMp3(track, outPath) {
  if (!track?.streamUrl) {
    throw new Error('У трека отсутствует ссылка на аудиопоток VK');
  }

  let coverTempPath = null;
  if (track.coverUrl) {
    try {
      const res = await fetch(track.coverUrl);
      if (res.ok) {
        const buf = Buffer.from(await res.arrayBuffer());
        if (buf.length > 512) {
          coverTempPath = path.join(os.tmpdir(), `woufy_cover_${Date.now()}_${Math.random().toString(36).slice(2)}.jpg`);
          await fs.writeFile(coverTempPath, buf);
        }
      }
    } catch {
      coverTempPath = null;
    }
  }

  const fullTitle = track.subtitle && !track.title.toLowerCase().includes(track.subtitle.toLowerCase())
    ? `${track.title} (${track.subtitle})`
    : track.title;

  const args = ['-y', '-loglevel', 'error', '-user_agent', DEFAULT_UA, '-i', track.streamUrl];

  if (coverTempPath) {
    args.push('-i', coverTempPath, '-map', '0:a:0', '-map', '1:v:0', '-c:v', 'mjpeg', '-id3v2_version', '3');
    args.push('-metadata:s:v', 'title=Album cover', '-metadata:s:v', 'comment=Cover (front)');
  } else {
    args.push('-map', '0:a:0', '-id3v2_version', '3');
  }

  args.push('-c:a', 'libmp3lame', '-b:a', '320k');
  if (fullTitle) args.push('-metadata', `title=${fullTitle}`);
  if (track.artist) args.push('-metadata', `artist=${track.artist}`);
  if (track.album) args.push('-metadata', `album=${track.album}`);
  if (track.year) args.push('-metadata', `date=${track.year}`);
  if (track.genre) args.push('-metadata', `genre=${track.genre}`);

  args.push(outPath);

  try {
    await runFfmpeg(args);
  } finally {
    if (coverTempPath) {
      await fs.unlink(coverTempPath).catch(() => {});
    }
  }
}
