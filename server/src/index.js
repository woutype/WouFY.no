import express from 'express';
import cors from 'cors';
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fetchLrclibLyrics } from './lyrics.js';
import {
  downloadVkTrackToMp3,
  fetchVkLyrics,
  isVkConfigured,
  resolveVkTrack,
  searchVkTracks,
} from './providers/vk.js';
import {
  downloadYtTrackToMp3,
  resolveYtTrack,
  searchYtTracks,
} from './providers/ytdlp.js';
import {
  downloadHybridTrackToMp3,
  fetchItunes3000Cover,
  resolveHybridTrack,
  searchHybridTracks,
} from './providers/hybrid.js';

const PORT = Number(process.env.PORT) || 3000;
const API_KEY = (process.env.API_KEY || '').trim();
const MUSIC_PROVIDER = (process.env.MUSIC_PROVIDER || 'auto').toLowerCase();

function activeProvider() {
  if (MUSIC_PROVIDER === 'vk') return 'vk';
  if (MUSIC_PROVIDER === 'ytdlp') return 'ytdlp';
  if (MUSIC_PROVIDER === 'hybrid') return 'hybrid';
  return isVkConfigured() ? 'vk' : 'hybrid';
}

function safeEqual(a, b) {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

function authMiddleware(req, res, next) {
  if (!API_KEY) return next();

  const headerKey = String(req.headers['x-api-key'] || '').trim();
  const authHeader = String(req.headers['authorization'] || '').trim();
  const bearerKey = authHeader.toLowerCase().startsWith('bearer ')
    ? authHeader.slice(7).trim()
    : '';

  const provided = headerKey || bearerKey;
  if (!provided || !safeEqual(provided, API_KEY)) {
    return res.status(401).json({ error: 'Unauthorized: invalid or missing API key' });
  }
  return next();
}

function sanitizeDownloadFilename(artist, title) {
  const raw = `${artist || 'Unknown'} - ${title || 'Track'}`
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 110);
  return `${raw || 'track'}.mp3`;
}

async function resolveTrackById(id) {
  if (id.startsWith('vk:')) return { kind: 'vk', track: await resolveVkTrack(id) };
  if (id.startsWith('dz:') || id.startsWith('it:')) return { kind: 'hybrid', track: await resolveHybridTrack(id) };
  return { kind: 'ytdlp', track: resolveYtTrack(id) };
}

const app = express();
app.disable('x-powered-by');
app.use(cors());
app.use(express.json());

const healthPayload = () => ({
  ok: true,
  provider: activeProvider(),
  protected: Boolean(API_KEY),
  uptime: Math.round(process.uptime()),
});

/** Health-check и keep-alive для Render и UptimeRobot (поддерживает GET и HEAD на /, /health, /ping) */
app.get(['/', '/health', '/ping'], (_req, res) => {
  res.status(200).json(healthPayload());
});

app.head(['/', '/health', '/ping'], (_req, res) => {
  res.status(200).end();
});

/** Поиск треков */
app.get('/api/search', authMiddleware, async (req, res) => {
  const q = String(req.query.q || '').trim();
  const title = String(req.query.title || '').trim();
  const artist = String(req.query.artist || '').trim();
  const limit = Math.min(30, Math.max(1, Number(req.query.limit) || 25));

  const combined = q || [artist, title].filter(Boolean).join(' ').trim();
  if (combined.length < 2) {
    return res.json({ items: [] });
  }

  const provider = activeProvider();
  try {
    let items;
    if (provider === 'vk') {
      items = await searchVkTracks({ q: combined, title, artist, limit });
    } else if (provider === 'ytdlp') {
      items = await searchYtTracks({ q: combined, title, artist, limit });
    } else {
      items = await searchHybridTracks({ q: combined, title, artist, limit });
    }

    return res.json({ provider, items });
  } catch (err) {
    console.error(`[search:${provider}]`, err?.message || err);
    return res.status(502).json({
      error: err?.message || 'Ошибка поиска на источнике',
    });
  }
});

/** Расширенные метаданные трека (обложка, альбом, текст/LRC) */
app.get('/api/tracks/:id/metadata', authMiddleware, async (req, res) => {
  const id = String(req.params.id || '').trim();
  if (!id) return res.status(400).json({ error: 'Missing track id' });

  try {
    const { kind, track } = await resolveTrackById(id);
    if (!track) {
      return res.status(404).json({ error: 'Track not found' });
    }

    const [lrclib, vkLyrics, uhdCover] = await Promise.all([
      fetchLrclibLyrics({
        artist: track.artist,
        title: track.title,
        album: track.album,
        duration: track.duration,
      }),
      kind === 'vk' && track.lyricsId ? fetchVkLyrics(track.lyricsId) : Promise.resolve(undefined),
      track.coverUrl && track.coverUrl.includes('3000x3000')
        ? Promise.resolve(track.coverUrl)
        : fetchItunes3000Cover(track.artist, track.title),
    ]);

    return res.json({
      title: track.title,
      subtitle: track.subtitle,
      artist: track.artist,
      album: track.album,
      year: track.year,
      genre: track.genre,
      bpm: track.bpm,
      trackNumber: track.trackNumber,
      discNumber: track.discNumber,
      duration: track.duration,
      coverUrl: uhdCover || track.coverUrl,
      lyrics: lrclib?.lyrics || vkLyrics,
      syncedLyrics: lrclib?.syncedLyrics,
      extension: 'mp3',
    });
  } catch (err) {
    console.error('[metadata]', err?.message || err);
    return res.status(500).json({ error: err?.message || 'Metadata error' });
  }
});

/** Скачивание трека в MP3 с вшитыми ID3-тегами и обложкой */
app.get('/api/tracks/:id/download', authMiddleware, async (req, res) => {
  const id = String(req.params.id || '').trim();
  if (!id) return res.status(400).json({ error: 'Missing track id' });

  const tempPath = path.join(
    os.tmpdir(),
    `woufy_track_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.mp3`
  );

  const cleanup = () => {
    fsp.unlink(tempPath).catch(() => {});
  };

  try {
    const { kind, track } = await resolveTrackById(id);
    if (!track) {
      return res.status(404).json({ error: 'Track not found' });
    }

    if (kind === 'vk') {
      await downloadVkTrackToMp3(track, tempPath);
    } else if (kind === 'hybrid') {
      await downloadHybridTrackToMp3(track, tempPath);
    } else {
      await downloadYtTrackToMp3(track, tempPath);
    }

    const stat = await fsp.stat(tempPath);
    if (!stat.size || stat.size < 1024) {
      cleanup();
      return res.status(502).json({ error: 'Downloaded audio file is empty' });
    }

    const filename = sanitizeDownloadFilename(track.artist, track.title);
    res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader('Content-Length', String(stat.size));
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="track.mp3"; filename*=UTF-8''${encodeURIComponent(filename)}`
    );

    const stream = fs.createReadStream(tempPath);
    stream.on('error', (err) => {
      console.error('[download:stream]', err);
      cleanup();
      if (!res.headersSent) res.status(500).end();
    });
    res.on('close', cleanup);
    res.on('finish', cleanup);
    stream.pipe(res);
  } catch (err) {
    cleanup();
    console.error('[download]', err?.message || err);
    if (!res.headersSent) {
      res.status(502).json({ error: err?.message || 'Ошибка при скачивании трека' });
    }
  }
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`[woufy-downloader] listening on :${PORT} (provider=${activeProvider()}, auth=${Boolean(API_KEY)})`);
});
