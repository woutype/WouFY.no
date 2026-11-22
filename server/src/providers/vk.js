import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

const VK_API_BASE = 'https://api.vk.com/method';
const VK_API_VERSION = '5.131';
const DEFAULT_UA =
  process.env.VK_USER_AGENT ||
  'KateMobileAndroid/56 lite-460 (Android 4.4.2; SDK 19; x86; unknown Android SDK built for x86; en)';

/** Маппинг VK genre_id -> название жанра (из vkms-src/2.13.3_0/js/7016.vms.js) */
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

const trackCache = new Map();
const CACHE_TTL_MS = 30 * 60 * 1000;
let cachedVkUserId = Number(process.env.VK_USER_ID) || 0;

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

async function ensureVkUserId() {
  if (cachedVkUserId > 0) return cachedVkUserId;
  try {
    const resp = await callVkApi('users.get', {});
    const id = Number(resp?.[0]?.id);
    if (Number.isFinite(id) && id > 0) {
      cachedVkUserId = id;
      return id;
    }
  } catch {
    /* ignore */
  }
  return 0;
}

/**
 * Точная реализация размаскировки ссылок VK Audio (`audio_api_unavailable?extra=...`)
 * напрямую из референса vkms-src/2.13.3_0/js/7495.vms.js (модуль 9141).
 */
const VK_B64_ALPHABET = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMN0PQRSTUVWXYZO123456789+/=';

function vkBase64Decode(str) {
  if (!str || str.length % 4 === 1) return false;
  let t = 0;
  let o = 0;
  let out = '';
  for (let a = 0; a < str.length; a++) {
    const idx = VK_B64_ALPHABET.indexOf(str.charAt(a));
    if (idx === -1) continue;
    t = o % 4 ? 64 * t + idx : idx;
    if (o++ % 4) {
      out += String.fromCharCode(255 & (t >> ((-2 * o) & 6)));
    }
  }
  return out;
}

function unmaskVkAudioUrl(url, vkUserId = 0) {
  if (!url || typeof url !== 'string' || !url.includes('audio_api_unavailable')) {
    return url;
  }
  try {
    const extraPart = url.split('?extra=')[1];
    if (!extraPart) return url;
    const parts = extraPart.split('#');
    let r = vkBase64Decode(parts[0]);
    const iStr = parts[1] === '' ? '' : vkBase64Decode(parts[1]);
    if (typeof iStr !== 'string' || !r) return url;

    const ops = {
      v: (e) => e.split('').reverse().join(''),
      r: (e, shift) => {
        const chars = e.split('');
        const doubleAlpha = VK_B64_ALPHABET + VK_B64_ALPHABET;
        for (let a = chars.length - 1; a >= 0; a--) {
          const pos = doubleAlpha.indexOf(chars[a]);
          if (pos !== -1) chars[a] = doubleAlpha.substr(pos - shift, 1);
        }
        return chars.join('');
      },
      s: (e, seed) => {
        const len = e.length;
        if (!len) return e;
        const indices = [];
        let s = Math.abs(Number(seed));
        for (let idx = len - 1; idx >= 0; idx--) {
          s = ((len * (idx + 1)) ^ (s + idx)) % len;
          indices[idx] = s;
        }
        const chars = e.split('');
        for (let o = 1; o < len; o++) {
          const swapIdx = indices[len - 1 - o];
          const tmp = chars[swapIdx];
          chars[swapIdx] = chars[o];
          chars[o] = tmp;
        }
        return chars.join('');
      },
      i: (e, seed) => ops.s(e, Number(seed) ^ Number(vkUserId)),
      x: (e, key) => {
        const k = String(key).charCodeAt(0);
        return e
          .split('')
          .map((ch) => String.fromCharCode(ch.charCodeAt(0) ^ k))
          .join('');
      },
    };

    const cmds = iStr ? iStr.split(String.fromCharCode(9)) : [];
    for (let idx = cmds.length - 1; idx >= 0; idx--) {
      const args = cmds[idx].split(String.fromCharCode(11));
      const opName = args.shift();
      if (!opName || !ops[opName]) return url;
      r = ops[opName](r, ...args);
    }
    if (r && r.startsWith('http')) return r;
  } catch {
    /* ignore */
  }
  return url;
}

/**
 * Преобразует HLS-ссылку VK (`.../index.m3u8`) в прямую ссылку на `.mp3`, если структура CDN VK это позволяет
 * (стандартный трюк для сегментированных потоков VK CDN).
 */
function tryConvertVkM3u8ToMp3Url(url) {
  if (!url || !url.includes('.m3u8')) return url;
  // На CDN VK пути вида /u12345/audios/abcdef/index.m3u8?extra=... -> /u12345/audios/abcdef.mp3?extra=...
  if (/\/[0-9a-f]+\/index\.m3u8/i.test(url)) {
    const parts = url.split('?');
    const base = parts[0].replace(/\/index\.m3u8$/i, '.mp3');
    return parts[1] ? `${base}?${parts[1]}` : base;
  }
  return url;
}

function pickBestCover(raw) {
  if (raw?.coverUrl_l) return { coverUrl: raw.coverUrl_l, thumbnailUrl: raw.coverUrl_s || raw.coverUrl_m || raw.coverUrl_l };
  const thumb = raw?.album?.thumb || raw?.photo;
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

function normalizeVkAudio(raw, vkUserId = 0) {
  if (!raw || raw.owner_id == null || raw.id == null) return null;
  const idParts = [String(raw.owner_id), String(raw.id)];
  const accessKey = raw.access_key || raw.accessKey;
  if (accessKey) idParts.push(String(accessKey));
  const id = `vk:${idParts.join('_')}`;

  const { coverUrl, thumbnailUrl } = pickBestCover(raw);

  let artist = String(raw.artist || raw.performer || '').trim();
  if (!artist && Array.isArray(raw.main_artists)) {
    const names = [...raw.main_artists, ...(Array.isArray(raw.featured_artists) ? raw.featured_artists : [])]
      .map((a) => a?.name)
      .filter(Boolean);
    artist = names.join(', ');
  }

  const rawUrl = typeof raw.url === 'string' && raw.url ? unmaskVkAudioUrl(raw.url, vkUserId) : undefined;

  return {
    id,
    vkAudioId: idParts.join('_'),
    title: String(raw.title || '').trim() || 'Без названия',
    subtitle: (raw.subtitle || raw.subTitle) ? String(raw.subtitle || raw.subTitle).trim() : undefined,
    artist: artist || 'Неизвестный исполнитель',
    album: raw.album?.title ? String(raw.album.title).trim() : undefined,
    year: Number.isFinite(Number(raw.album?.year)) ? Number(raw.album.year) : undefined,
    genre: VK_GENRES[Number(raw.genre_id)] || undefined,
    duration: Number.isFinite(Number(raw.duration)) ? Number(raw.duration) : undefined,
    coverUrl,
    thumbnailUrl,
    explicit: Boolean(raw.is_explicit),
    hasLyrics: Boolean(raw.lyrics_id),
    lyricsId: raw.lyrics_id ? Number(raw.lyrics_id) : undefined,
    streamUrl: rawUrl,
    extension: 'mp3',
  };
}

export async function searchVkTracks({ q, artist, title, limit = 25 }) {
  const query = (q || [artist, title].filter(Boolean).join(' ')).trim();
  if (!query) return [];

  const [vkUserId, resp] = await Promise.all([
    ensureVkUserId(),
    callVkApi('audio.search', {
      q: query,
      auto_complete: '1',
      sort: '2',
      count: String(Math.min(50, Math.max(1, limit))),
    }),
  ]);

  const rawItems = Array.isArray(resp?.items) ? resp.items : [];
  const results = [];
  for (const raw of rawItems) {
    if (!raw?.url && !raw?.owner_id) continue;
    const item = normalizeVkAudio(raw, vkUserId);
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
  if (cached && cached.streamUrl) {
    return cached;
  }

  const vkAudioId = id.replace(/^vk:/, '');
  const [vkUserId, resp] = await Promise.all([
    ensureVkUserId(),
    callVkApi('audio.getById', { audios: vkAudioId }),
  ]);
  const raw = Array.isArray(resp) ? resp[0] : null;
  if (!raw) return cached;

  const fresh = normalizeVkAudio(raw, vkUserId);
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
 * Скачивает поток VK (прямой .mp3 или HLS .m3u8) с минимальной нагрузкой на 0.1 vCPU Render
 * (использует прямое копирование потока `-c:a copy`, если поток уже MP3, или быстрый LAME `-compression_level 0`)
 * и вшивает обложку + ID3v2.3 теги.
 */
export async function downloadVkTrackToMp3(track, outPath) {
  if (!track?.streamUrl) {
    throw new Error('У трека отсутствует ссылка на аудиопоток VK');
  }

  // Проверяем, отдаёт ли CDN VK прямой .mp3 по замене /index.m3u8 -> .mp3
  let inputUrl = track.streamUrl;
  const directMp3Candidate = tryConvertVkM3u8ToMp3Url(track.streamUrl);

  const [directMp3Ok, coverTempPath] = await Promise.all([
    (async () => {
      if (directMp3Candidate === track.streamUrl) return false;
      try {
        const res = await fetch(directMp3Candidate, {
          method: 'HEAD',
          headers: { 'User-Agent': DEFAULT_UA },
        });
        return res.ok;
      } catch {
        return false;
      }
    })(),
    (async () => {
      if (!track.coverUrl) return null;
      try {
        const res = await fetch(track.coverUrl);
        if (!res.ok) return null;
        const buf = Buffer.from(await res.arrayBuffer());
        if (buf.length <= 512) return null;
        const p = path.join(os.tmpdir(), `woufy_vk_cover_${Date.now()}_${Math.random().toString(36).slice(2)}.jpg`);
        await fs.writeFile(p, buf);
        return p;
      } catch {
        return null;
      }
    })(),
  ]);

  if (directMp3Ok) {
    inputUrl = directMp3Candidate;
  }

  const fullTitle =
    track.subtitle && !track.title.toLowerCase().includes(track.subtitle.toLowerCase())
      ? `${track.title} (${track.subtitle})`
      : track.title;

  const buildArgs = (useStreamCopy) => {
    const args = ['-y', '-loglevel', 'error', '-user_agent', DEFAULT_UA, '-i', inputUrl];
    if (coverTempPath) {
      args.push('-i', coverTempPath, '-map', '0:a:0', '-map', '1:v:0', '-c:v', 'copy', '-id3v2_version', '3');
      args.push('-metadata:s:v', 'title=Album cover', '-metadata:s:v', 'comment=Cover (front)');
    } else {
      args.push('-map', '0:a:0', '-id3v2_version', '3');
    }

    if (useStreamCopy) {
      args.push('-c:a', 'copy');
    } else {
      args.push('-c:a', 'libmp3lame', '-q:a', '2', '-compression_level', '0');
    }

    if (fullTitle) args.push('-metadata', `title=${fullTitle}`);
    if (track.artist) args.push('-metadata', `artist=${track.artist}`);
    if (track.album) args.push('-metadata', `album=${track.album}`);
    if (track.year) args.push('-metadata', `date=${track.year}`);
    if (track.genre) args.push('-metadata', `genre=${track.genre}`);
    args.push(outPath);
    return args;
  };

  try {
    try {
      // Сначала пробуем мгновенное копирование MP3-потока без перекодирования (как в vkms-src)
      await runFfmpeg(buildArgs(true));
    } catch {
      // Если внутри HLS был fMP4/AAC — быстрый LAME
      await runFfmpeg(buildArgs(false));
    }
  } finally {
    if (coverTempPath) {
      await fs.unlink(coverTempPath).catch(() => {});
    }
  }
}
