import { spawn } from 'node:child_process';

/** Краткосрочный кэш результатов поиска yt-dlp (TTL 30 мин) */
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

function runCommand(bin, args, timeoutMs = 45000) {
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

function cleanChannelName(name) {
  return String(name || '')
    .replace(/\s*-\s*Topic$/i, '')
    .replace(/\s*VEVO$/i, '')
    .replace(/\s*Official$/i, '')
    .trim();
}

function parseArtistAndTitle(rawTitle, channel) {
  const cleanTitle = String(rawTitle || '')
    .replace(/\s*[\(\[]\s*(?:official\s+)?(?:music\s+)?(?:video|audio|lyric\s*video|visualizer|hd|4k|hq)\s*[\)\]]/gi, '')
    .trim();

  const sepMatch = cleanTitle.match(/^(.+?)\s+[–—-]\s+(.+)$/);
  if (sepMatch) {
    return {
      artist: sepMatch[1].trim(),
      title: sepMatch[2].trim(),
    };
  }

  return {
    artist: cleanChannelName(channel) || 'Неизвестный исполнитель',
    title: cleanTitle || 'Без названия',
  };
}

function pickThumbnail(entry) {
  const thumbs = Array.isArray(entry.thumbnails) ? entry.thumbnails : [];
  let bestUrl;
  let bestWidth = 0;
  let smallUrl;
  let smallWidth = Infinity;

  for (const t of thumbs) {
    if (!t?.url) continue;
    const w = Number(t.width) || 0;
    if (w >= bestWidth) {
      bestWidth = w;
      bestUrl = t.url;
    }
    if (w > 0 && w < smallWidth) {
      smallWidth = w;
      smallUrl = t.url;
    }
  }

  const fallback = entry.thumbnail || (entry.id ? `https://i.ytimg.com/vi/${entry.id}/hqdefault.jpg` : undefined);
  return {
    coverUrl: bestUrl || fallback,
    thumbnailUrl: smallUrl || fallback,
  };
}

export async function searchYtTracks({ q, artist, title, limit = 15 }) {
  const query = (q || [artist, title].filter(Boolean).join(' ')).trim();
  if (!query) return [];

  const count = Math.min(20, Math.max(1, limit));
  const stdout = await runCommand(
    'yt-dlp',
    [
      '--dump-json',
      '--flat-playlist',
      '--no-warnings',
      '--skip-download',
      `ytsearch${count}:${query} audio`,
    ],
    25000
  );

  const lines = stdout
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);

  const results = [];
  for (const line of lines) {
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (!entry?.id) continue;

    // Отсекаем слишком длинные миксы/подкасты (> 15 мин)
    const duration = Number(entry.duration);
    if (Number.isFinite(duration) && duration > 900) continue;

    const parsed = parseArtistAndTitle(entry.title, entry.channel || entry.uploader);
    const { coverUrl, thumbnailUrl } = pickThumbnail(entry);
    const id = `yt:${entry.id}`;

    const item = {
      id,
      videoId: entry.id,
      title: parsed.title,
      artist: parsed.artist,
      album: entry.album ? String(entry.album).trim() : undefined,
      duration: Number.isFinite(duration) && duration > 0 ? Math.round(duration) : undefined,
      coverUrl,
      thumbnailUrl,
      extension: 'mp3',
    };

    cacheSet(id, item);
    results.push({
      id: item.id,
      title: item.title,
      artist: item.artist,
      album: item.album,
      duration: item.duration,
      coverUrl: item.coverUrl,
      thumbnailUrl: item.thumbnailUrl,
      extension: 'mp3',
    });
  }

  return results;
}

export function resolveYtTrack(id) {
  const cached = cacheGet(id);
  if (cached) return cached;
  const videoId = id.replace(/^yt:/, '');
  if (!/^[a-zA-Z0-9_-]{6,20}$/.test(videoId)) return null;
  return {
    id: `yt:${videoId}`,
    videoId,
    title: videoId,
    artist: 'Unknown Artist',
    coverUrl: `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
    thumbnailUrl: `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
    extension: 'mp3',
  };
}

/**
 * Скачивает трек через yt-dlp + ffmpeg в MP3 с вшитой обложкой и ID3-тегами.
 */
export async function downloadYtTrackToMp3(track, outPath) {
  const videoId = track?.videoId || String(track?.id || '').replace(/^yt:/, '');
  if (!/^[a-zA-Z0-9_-]{6,20}$/.test(videoId)) {
    throw new Error('Некорректный ID трека');
  }

  const url = `https://www.youtube.com/watch?v=${videoId}`;
  const args = [
    '-f',
    'bestaudio/best',
    '-x',
    '--audio-format',
    'mp3',
    '--audio-quality',
    '0',
    '--embed-thumbnail',
    '--add-metadata',
    '--no-playlist',
    '--no-warnings',
    '-o',
    outPath,
    url,
  ];

  await runCommand('yt-dlp', args, 90000);
}
