import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

/** Краткосрочный кэш метаданных найденных треков (TTL 30 мин) */
const trackCache = new Map();
const CACHE_TTL_MS = 30 * 60 * 1000;

function cacheSet(id, item) {
  trackCache.set(id, { item, expiresAt: Date.now() + CACHE_TTL_MS });
  if (trackCache.size > 800) {
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

function runCommand(bin, args, timeoutMs = 60000) {
  return new Promise((resolve, reject) => {
    const proc = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      proc.kill('SIGKILL');
      reject(new Error(`${bin} timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    proc.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    proc.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
      if (stderr.length > 4000) stderr = stderr.slice(-4000);
    });
    proc.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    proc.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(stdout);
      else reject(new Error(`${bin} exited with code ${code}: ${stderr.slice(-400)}`));
    });
  });
}

/* ───────── 1. Мгновенный поиск через Deezer Public API (~150-250 мс) ───────── */

function mapDeezerTrack(raw) {
  if (!raw?.id || !raw?.title) return null;
  const id = `dz:${raw.id}`;
  const coverUrl =
    raw.album?.cover_xl ||
    raw.album?.cover_big ||
    raw.album?.cover_medium ||
    raw.album?.cover ||
    undefined;
  const thumbnailUrl =
    raw.album?.cover_medium ||
    raw.album?.cover_big ||
    raw.album?.cover ||
    coverUrl;

  const yearMatch = typeof raw.release_date === 'string' ? raw.release_date.match(/^(\d{4})/) : null;
  const year = yearMatch ? Number(yearMatch[1]) : undefined;

  return {
    id,
    title: String(raw.title).trim(),
    artist: String(raw.artist?.name || 'Неизвестный исполнитель').trim(),
    album: raw.album?.title ? String(raw.album.title).trim() : undefined,
    year,
    duration: Number.isFinite(Number(raw.duration)) && Number(raw.duration) > 0 ? Math.round(Number(raw.duration)) : undefined,
    bpm: Number.isFinite(Number(raw.bpm)) && Number(raw.bpm) >= 40 && Number(raw.bpm) <= 240 ? Math.round(Number(raw.bpm)) : undefined,
    trackNumber: Number.isFinite(Number(raw.track_position)) && Number(raw.track_position) > 0 ? Number(raw.track_position) : undefined,
    discNumber: Number.isFinite(Number(raw.disk_number)) && Number(raw.disk_number) > 0 ? Number(raw.disk_number) : undefined,
    coverUrl,
    thumbnailUrl,
    explicit: Boolean(raw.explicit_lyrics),
    extension: 'mp3',
  };
}

async function searchDeezer(query, limit) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  try {
    const url = `https://api.deezer.com/search?q=${encodeURIComponent(query)}&limit=${Math.min(30, limit)}`;
    const res = await fetch(url, {
      headers: { Accept: 'application/json' },
      signal: controller.signal,
    });
    if (!res.ok) return [];
    const json = await res.json();
    const list = Array.isArray(json?.data) ? json.data : [];
    const items = [];
    for (const raw of list) {
      const item = mapDeezerTrack(raw);
      if (!item) continue;
      cacheSet(item.id, item);
      items.push(item);
    }
    return items;
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}

/* ───────── 2. Резервный мгновенный поиск через iTunes Search API (~150-250 мс) ───────── */

function mapItunesTrack(raw) {
  if (!raw?.trackId || !raw?.trackName) return null;
  const id = `it:${raw.trackId}`;
  const thumb = typeof raw.artworkUrl100 === 'string' ? raw.artworkUrl100 : undefined;
  const coverUrl = thumb ? thumb.replace('100x100bb.jpg', '1000x1000bb.jpg') : undefined;
  const yearMatch = typeof raw.releaseDate === 'string' ? raw.releaseDate.match(/^(\d{4})/) : null;
  const year = yearMatch ? Number(yearMatch[1]) : undefined;
  const duration = Number.isFinite(Number(raw.trackTimeMillis))
    ? Math.round(Number(raw.trackTimeMillis) / 1000)
    : undefined;

  return {
    id,
    title: String(raw.trackName).trim(),
    artist: String(raw.artistName || 'Неизвестный исполнитель').trim(),
    album: raw.collectionName ? String(raw.collectionName).trim() : undefined,
    year,
    genre: raw.primaryGenreName ? String(raw.primaryGenreName).trim() : undefined,
    duration: duration && duration > 0 ? duration : undefined,
    trackNumber: Number.isFinite(Number(raw.trackNumber)) && Number(raw.trackNumber) > 0 ? Number(raw.trackNumber) : undefined,
    discNumber: Number.isFinite(Number(raw.discNumber)) && Number(raw.discNumber) > 0 ? Number(raw.discNumber) : undefined,
    coverUrl,
    thumbnailUrl: thumb || coverUrl,
    explicit: raw.trackExplicitness === 'explicit',
    extension: 'mp3',
  };
}

async function searchItunes(query, limit) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  try {
    const qs = new URLSearchParams({
      term: query,
      media: 'music',
      entity: 'song',
      limit: String(Math.min(30, limit)),
    });
    const res = await fetch(`https://itunes.apple.com/search?${qs.toString()}`, {
      headers: { Accept: 'application/json' },
      signal: controller.signal,
    });
    if (!res.ok) return [];
    const json = await res.json();
    const list = Array.isArray(json?.results) ? json.results : [];
    const items = [];
    for (const raw of list) {
      const item = mapItunesTrack(raw);
      if (!item) continue;
      cacheSet(item.id, item);
      items.push(item);
    }
    return items;
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}

export async function searchHybridTracks({ q, title, artist, limit = 25 }) {
  const cleanTitle = (title || '').trim();
  const cleanArtist = (artist || '').trim();
  const plainQuery = (q || [cleanArtist, cleanTitle].filter(Boolean).join(' ')).trim();
  if (!plainQuery) return [];

  let items = [];
  if (cleanArtist && cleanTitle) {
    items = await searchDeezer(`artist:"${cleanArtist}" track:"${cleanTitle}"`, limit);
  }
  if (items.length === 0) {
    items = await searchDeezer(plainQuery, limit);
  }
  if (items.length === 0) {
    items = await searchItunes(plainQuery, limit);
  }
  return items;
}

export async function resolveHybridTrack(id) {
  const cached = cacheGet(id);
  if (cached) return cached;

  if (id.startsWith('dz:')) {
    const dzId = id.slice(3);
    if (!/^\d+$/.test(dzId)) return null;
    try {
      const res = await fetch(`https://api.deezer.com/track/${dzId}`, { headers: { Accept: 'application/json' } });
      if (res.ok) {
        const mapped = mapDeezerTrack(await res.json());
        if (mapped) {
          cacheSet(mapped.id, mapped);
          return mapped;
        }
      }
    } catch {
      /* ignore */
    }
  } else if (id.startsWith('it:')) {
    const itId = id.slice(3);
    if (!/^\d+$/.test(itId)) return null;
    try {
      const res = await fetch(`https://itunes.apple.com/lookup?id=${itId}`, { headers: { Accept: 'application/json' } });
      if (res.ok) {
        const json = await res.json();
        const mapped = mapItunesTrack(json?.results?.[0]);
        if (mapped) {
          cacheSet(mapped.id, mapped);
          return mapped;
        }
      }
    } catch {
      /* ignore */
    }
  }
  return null;
}

/* ───────── 3. Надёжное скачивание аудио + вшивание HD-обложки и ID3v2.3 ───────── */

async function downloadAudioSource(query, tempBasePath) {
  const template = `${tempBasePath}.%(ext)s`;
  const attempts = [
    // 1. SoundCloud — не блокирует датацентр-IP Render и отдаёт чистый звук
    {
      label: 'soundcloud',
      args: [
        '-f',
        'bestaudio/best',
        '--no-playlist',
        '--no-warnings',
        '--max-filesize',
        '40M',
        '-o',
        template,
        `scsearch1:${query}`,
      ],
    },
    // 2. YouTube через клиенты tv_embedded / android_vr / ios (обходит bot-check на Render)
    {
      label: 'youtube',
      args: [
        '-f',
        'bestaudio/best',
        '--extractor-args',
        'youtube:player_client=tv_embedded,android_vr,ios',
        '--no-playlist',
        '--no-warnings',
        '--max-filesize',
        '40M',
        '-o',
        template,
        `ytsearch1:${query} audio`,
      ],
    },
  ];

  let lastErr = new Error('Не удалось найти аудиопоток для скачивания');
  const dir = path.dirname(tempBasePath);
  const prefix = `${path.basename(tempBasePath)}.`;

  for (const attempt of attempts) {
    try {
      await runCommand('yt-dlp', attempt.args, 55000);
      const files = await fs.readdir(dir);
      const found = files.find((f) => f.startsWith(prefix) && !f.endsWith('.part'));
      if (found) {
        return path.join(dir, found);
      }
    } catch (err) {
      lastErr = err;
      console.warn(`[hybrid:${attempt.label}] fallback:`, err?.message || err);
    }
  }

  throw lastErr;
}

export async function downloadHybridTrackToMp3(track, outPath) {
  const query = `${track.artist} - ${track.title}`.trim();
  const tempBase = path.join(
    os.tmpdir(),
    `woufy_src_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`
  );

  let rawAudioPath = null;
  let coverTempPath = null;

  try {
    // Параллельно скачиваем исходное аудио и официальную HD-обложку (1000x1000)
    const [audioFile, coverFile] = await Promise.all([
      downloadAudioSource(query, tempBase),
      (async () => {
        if (!track.coverUrl) return null;
        try {
          const res = await fetch(track.coverUrl);
          if (!res.ok) return null;
          const buf = Buffer.from(await res.arrayBuffer());
          if (buf.length < 512) return null;
          const p = `${tempBase}_cover.jpg`;
          await fs.writeFile(p, buf);
          return p;
        } catch {
          return null;
        }
      })(),
    ]);

    rawAudioPath = audioFile;
    coverTempPath = coverFile;

    const args = ['-y', '-loglevel', 'error', '-i', rawAudioPath];
    if (coverTempPath) {
      args.push('-i', coverTempPath, '-map', '0:a:0', '-map', '1:v:0', '-c:v', 'mjpeg', '-id3v2_version', '3');
      args.push('-metadata:s:v', 'title=Album cover', '-metadata:s:v', 'comment=Cover (front)');
    } else {
      args.push('-map', '0:a:0', '-id3v2_version', '3');
    }

    args.push('-c:a', 'libmp3lame', '-b:a', '320k');
    if (track.title) args.push('-metadata', `title=${track.title}`);
    if (track.artist) args.push('-metadata', `artist=${track.artist}`);
    if (track.album) args.push('-metadata', `album=${track.album}`);
    if (track.year) args.push('-metadata', `date=${track.year}`);
    if (track.genre) args.push('-metadata', `genre=${track.genre}`);
    if (track.trackNumber) args.push('-metadata', `track=${track.trackNumber}`);
    if (track.bpm) args.push('-metadata', `TBPM=${track.bpm}`);
    args.push(outPath);

    await runCommand('ffmpeg', args, 60000);
  } finally {
    if (rawAudioPath) await fs.unlink(rawAudioPath).catch(() => {});
    if (coverTempPath) await fs.unlink(coverTempPath).catch(() => {});
  }
}
