import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

/** Кэш метаданных найденных треков (TTL 30 мин) */
const trackCache = new Map();
/** Кэш уже подобранного лучшего аудио-источника (track.id -> Promise<string>) */
const resolvedSourceCache = new Map();
/** Кэш скачанных байтов обложек (coverUrl -> Promise<Buffer | null>) */
const coverBufferCache = new Map();

const CACHE_TTL_MS = 30 * 60 * 1000;

function cacheSet(map, key, value, maxSize = 600) {
  map.set(key, { value, expiresAt: Date.now() + CACHE_TTL_MS });
  if (map.size > maxSize) {
    const firstKey = map.keys().next().value;
    if (firstKey) map.delete(firstKey);
  }
}

function cacheGet(map, key) {
  const entry = map.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    map.delete(key);
    return null;
  }
  return entry.value;
}

function runCommand(bin, args, timeoutMs = 50000) {
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

function normStr(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

function primaryArtistNorm(artist) {
  const first = String(artist || '').split(/[,;&/]|feat\.?|ft\.?/i)[0] || artist;
  return normStr(first);
}

/* ───────── 1. Параллельный поиск iTunes (3000x3000) + Deezer (1000x1000) ───────── */

function mapItunesTrack(raw) {
  if (!raw?.trackId || !raw?.trackName) return null;
  const id = `it:${raw.trackId}`;
  const rawArt = typeof raw.artworkUrl100 === 'string' ? raw.artworkUrl100 : undefined;
  // Оба URL строятся из ОДНОГО И ТОГО ЖЕ хэша обложки релиза — подмена обложки невозможна
  const coverUrl = rawArt ? rawArt.replace(/\d+x\d+bb\.(jpg|png)$/i, '3000x3000bb.jpg') : undefined;
  const thumbnailUrl = rawArt ? rawArt.replace(/\d+x\d+bb\.(jpg|png)$/i, '300x300bb.jpg') : undefined;
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
    thumbnailUrl: thumbnailUrl || coverUrl,
    explicit: raw.trackExplicitness === 'explicit',
    extension: 'mp3',
  };
}

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
  const timer = setTimeout(() => controller.abort(), 4500);
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
      if (item) items.push(item);
    }
    return items;
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}

async function searchItunes(query, limit) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 4500);
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
      if (item) items.push(item);
    }
    return items;
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Проверяет, являются ли два трека (из Deezer и iTunes) СТРОГО одной и той же записью,
 * чтобы безопасно дать треку Deezer 3000x3000 обложку ещё на этапе поиска (и показывать её же в списке).
 */
function isStrictSameRelease(dz, it) {
  if (!dz || !it || !it.coverUrl) return false;
  if (normStr(dz.title) !== normStr(it.title)) return false;
  const a1 = primaryArtistNorm(dz.artist);
  const a2 = primaryArtistNorm(it.artist);
  if (!a1 || !a2 || (a1 !== a2 && !normStr(dz.artist).includes(a2) && !normStr(it.artist).includes(a1))) {
    return false;
  }
  if (dz.duration && it.duration && Math.abs(dz.duration - it.duration) > 3) {
    return false;
  }
  return true;
}

export async function searchHybridTracks({ q, title, artist, limit = 25 }) {
  const cleanTitle = (title || '').trim();
  const cleanArtist = (artist || '').trim();
  const plainQuery = (q || [cleanArtist, cleanTitle].filter(Boolean).join(' ')).trim();
  if (!plainQuery) return [];

  const dzQuery = cleanArtist && cleanTitle ? `artist:"${cleanArtist}" track:"${cleanTitle}"` : plainQuery;

  // Запрашиваем Deezer и iTunes ПАРАЛЛЕЛЬНО (~200 мс)
  const [dzInitial, itItems] = await Promise.all([
    searchDeezer(dzQuery, limit),
    searchItunes(plainQuery, limit),
  ]);

  const dzItems =
    dzInitial.length === 0 && dzQuery !== plainQuery
      ? await searchDeezer(plainQuery, limit)
      : dzInitial;

  const merged = [];
  const seenKeys = new Set();

  // Обогащаем треки Deezer проверенной 3000x3000 обложкой из iTunes ТОЛЬКО при строгом совпадении
  // (и сразу ставим её же в thumbnailUrl, чтобы в поиске и после скачивания была 100% одна и та же обложка!)
  for (const dz of dzItems) {
    const matchedIt = itItems.find((it) => isStrictSameRelease(dz, it));
    if (matchedIt) {
      dz.coverUrl = matchedIt.coverUrl;
      dz.thumbnailUrl = matchedIt.thumbnailUrl;
      dz.year = dz.year ?? matchedIt.year;
      dz.genre = dz.genre || matchedIt.genre;
    }
    cacheSet(trackCache, dz.id, dz);
    const key = `${primaryArtistNorm(dz.artist)}__${normStr(dz.title)}__${Math.round((dz.duration || 0) / 4)}`;
    seenKeys.add(key);
    merged.push(dz);
  }

  // Добавляем результаты из iTunes, которых не было в Deezer
  for (const it of itItems) {
    cacheSet(trackCache, it.id, it);
    const key = `${primaryArtistNorm(it.artist)}__${normStr(it.title)}__${Math.round((it.duration || 0) / 4)}`;
    if (seenKeys.has(key)) continue;
    seenKeys.add(key);
    merged.push(it);
  }

  const finalResults = merged.slice(0, limit);

  // В фоне (не задерживая ответ поиска!) прогреваем аудио-источники и обложки для топ-3 результатов
  prewarmTopTracks(finalResults.slice(0, 3));

  return finalResults;
}

export async function resolveHybridTrack(id) {
  const cached = cacheGet(trackCache, id);
  if (cached) return cached;

  if (id.startsWith('dz:')) {
    const dzId = id.slice(3);
    if (!/^\d+$/.test(dzId)) return null;
    try {
      const res = await fetch(`https://api.deezer.com/track/${dzId}`, { headers: { Accept: 'application/json' } });
      if (res.ok) {
        const mapped = mapDeezerTrack(await res.json());
        if (mapped) {
          cacheSet(trackCache, mapped.id, mapped);
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
          cacheSet(trackCache, mapped.id, mapped);
          return mapped;
        }
      }
    } catch {
      /* ignore */
    }
  }
  return null;
}

/* ───────── 2. Интеллектуальный подбор 100% оригинального студийного аудио ───────── */

const DISQUALIFY_WORDS = [
  'sped up',
  'speed up',
  'pitched',
  'pitch',
  'nightcore',
  'daycore',
  'slowed',
  'reverb',
  '8d',
  'bass boosted',
  'chipmunk',
  'karaoke',
  'instrumental',
  'acapella',
  'a cappella',
  'ringtone',
  'cover',
  'live at',
  'live version',
  'mashup',
  'bootleg',
  'preview',
  'snippet',
  'teaser',
];

const PENALTY_WORDS = ['remix', 'edit', 'vip', 'extended', 'club mix', 'radio edit', 'flip', 'rework'];

/**
 * Оценивает кандидата из SoundCloud / YouTube против эталонного трека из Deezer/iTunes.
 * Жёстко отсекает ускоренные/поднятые на октаву (pitched/nightcore/sped up) перезаливы
 * как по ключевым словам, так и по несовпадению длительности со студийным оригиналом!
 */
function scoreCandidate(cand, track) {
  if (!cand || !cand.url) return -Infinity;

  const targetTitleNorm = normStr(track.title);
  const targetArtistNorm = primaryArtistNorm(track.artist);
  const fullTargetNorm = `${ normStr(track.artist) } ${targetTitleNorm}`;

  const candTitleNorm = normStr(cand.title);
  const candUploaderNorm = normStr(cand.uploader);
  const candCombined = `${candUploaderNorm} ${candTitleNorm}`;

  // 1. Жёсткая фильтрация: если в названии кандидата есть nightcore/sped up/pitched/slowed/cover,
  // а пользователь искал оригинал — мгновенно дисквалифицируем!
  for (const word of DISQUALIFY_WORDS) {
    if (candCombined.includes(word) && !fullTargetNorm.includes(word)) {
      return -Infinity;
    }
  }

  // 2. Проверка длительности (главный барьер против треков, поднятых на тон/октаву для обхода АП!)
  const targetDur = Number(track.duration);
  const candDur = Number(cand.duration);

  if (Number.isFinite(candDur) && candDur > 0) {
    // Отсекаем 30-секундные превью SoundCloud Go+
    if (candDur < 45 && (!targetDur || targetDur >= 55)) {
      return -Infinity;
    }
    if (Number.isFinite(targetDur) && targetDur > 0) {
      const diff = Math.abs(candDur - targetDur);
      // Трек, поднятый по питчу/скорости, короче оригинала на 20-45 секунд — сразу отбрасываем!
      if (diff > 14) {
        return -Infinity;
      }
    }
  }

  let score = 0;

  // Бонус за точное совпадение длительности со студийным мастером
  if (Number.isFinite(targetDur) && targetDur > 0 && Number.isFinite(candDur) && candDur > 0) {
    const diff = Math.abs(candDur - targetDur);
    if (diff <= 1) score += 80;
    else if (diff <= 2) score += 65;
    else if (diff <= 4) score += 45;
    else if (diff <= 7) score += 20;
    else score -= diff * 2;
  }

  // Штраф за нежелательный ремикс, если пользователь не искал ремикс
  for (const word of PENALTY_WORDS) {
    if (candTitleNorm.includes(word) && !fullTargetNorm.includes(word)) {
      score -= 70;
    }
  }

  // Бонус за официальные каналы дистрибьюторов YouTube Music ("- Topic" / "Official Audio")
  if (/\btopic\b/i.test(cand.uploader || '') || /\bprovided to youtube by\b/i.test(cand.description || '')) {
    score += 55;
  } else if (/\bofficial\b|\bvevo\b/i.test(cand.uploader || '') || /\bofficial audio\b/i.test(cand.title || '')) {
    score += 30;
  }

  // Совпадение артиста
  if (targetArtistNorm && (candTitleNorm.includes(targetArtistNorm) || candUploaderNorm.includes(targetArtistNorm))) {
    score += 35;
  } else {
    score -= 25;
  }

  // Совпадение названия трека
  if (targetTitleNorm && candTitleNorm.includes(targetTitleNorm)) {
    score += 35;
  } else {
    score -= 20;
  }

  // При равном балле слегка предпочитаем SoundCloud (отдаёт готовый MP3 без перекодирования на 0.1 vCPU)
  if (cand.source === 'sc') {
    score += 8;
  }

  return score;
}

async function fetchCandidatesFromYtDlp(searchSpec, source, extraArgs = []) {
  try {
    const stdout = await runCommand(
      'yt-dlp',
      [
        '--dump-json',
        '--flat-playlist',
        '--no-warnings',
        '--skip-download',
        '--no-check-certificates',
        ...extraArgs,
        searchSpec,
      ],
      14000
    );

    const out = [];
    for (const line of stdout.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const entry = JSON.parse(trimmed);
        const url =
          entry.webpage_url ||
          entry.url ||
          (source === 'yt' && entry.id ? `https://www.youtube.com/watch?v=${entry.id}` : null);
        if (!url) continue;
        out.push({
          source,
          url,
          title: entry.title || '',
          uploader: entry.channel || entry.uploader || '',
          duration: Number(entry.duration) || 0,
          description: entry.description || '',
        });
      } catch {
        /* ignore malformed line */
      }
    }
    return out;
  } catch {
    return [];
  }
}

/**
 * Находит лучший оригинальный аудио-источник для трека, сверяя длительность и названия
 * среди кандидатов SoundCloud и YouTube Music. Результат кэшируется.
 */
export function resolveBestAudioSource(track) {
  const cachedPromise = cacheGet(resolvedSourceCache, track.id);
  if (cachedPromise) return cachedPromise;

  const promise = (async () => {
    const query = `${track.artist} - ${track.title}`.trim();

    // Параллельно опрашиваем топ-5 SoundCloud и топ-5 YouTube (занимает ~1.2–2 сек с распакованным yt-dlp)
    const [scCandidates, ytCandidates] = await Promise.all([
      fetchCandidatesFromYtDlp(`scsearch5:${query}`, 'sc'),
      fetchCandidatesFromYtDlp(`ytsearch5:${query} official audio`, 'yt', [
        '--extractor-args',
        'youtube:player_client=tv_embedded,android_vr,ios',
      ]),
    ]);

    const allCandidates = [...scCandidates, ...ytCandidates];
    let best = null;
    let bestScore = -Infinity;

    for (const cand of allCandidates) {
      const s = scoreCandidate(cand, track);
      if (s > bestScore) {
        bestScore = s;
        best = cand;
      }
    }

    if (best && bestScore > -50) {
      console.log(
        `[hybrid:resolver] "${query}" (target=${track.duration}s) -> [${best.source}] "${best.title}" by "${best.uploader}" (dur=${best.duration}s, score=${bestScore})`
      );
      return best;
    }

    // Если кандидаты не распарсились, фоллбек на прямой поиск
    return {
      source: 'sc',
      url: `scsearch1:${query}`,
      title: track.title,
      uploader: track.artist,
      duration: track.duration || 0,
    };
  })();

  cacheSet(resolvedSourceCache, track.id, promise);
  return promise;
}

/** Скачивание и кэширование байтов обложки в памяти (чтобы не качать повторно) */
export function fetchCoverBuffer(coverUrl) {
  if (!coverUrl) return Promise.resolve(null);
  const cached = cacheGet(coverBufferCache, coverUrl);
  if (cached) return cached;

  const promise = (async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 6000);
    try {
      const res = await fetch(coverUrl, { signal: controller.signal });
      if (!res.ok) return null;
      const buf = Buffer.from(await res.arrayBuffer());
      return buf.length > 512 ? buf : null;
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  })();

  cacheSet(coverBufferCache, coverUrl, promise, 120);
  return promise;
}

/** Фоновый прогрев топ-3 результатов поиска (пока пользователь выбирает трек глазами) */
function prewarmTopTracks(tracks) {
  for (const t of tracks) {
    resolveBestAudioSource(t).catch(() => {});
    if (t.coverUrl) fetchCoverBuffer(t.coverUrl).catch(() => {});
  }
}

/* ───────── 3. Быстрое скачивание аудио + мгновенное вшивание обложки и ID3v2.3 ───────── */

async function downloadAudioFromCandidate(bestCandidate, query, tempBasePath) {
  const template = `${tempBasePath}.%(ext)s`;
  const dir = path.dirname(tempBasePath);
  const prefix = `${path.basename(tempBasePath)}.`;

  const commonFlags = [
    // Предпочитаем готовый MP3 поток (на SoundCloud он есть нативно -> 0 сек перекодирования в ffmpeg!)
    '-f',
    'bestaudio[acodec=mp3]/bestaudio[ext=mp3]/bestaudio/best',
    '--concurrent-fragments',
    '4',
    '--no-playlist',
    '--no-warnings',
    '--no-check-certificates',
    '--no-cache-dir',
    '--max-filesize',
    '40M',
    '-o',
    template,
  ];

  const attempts = [
    bestCandidate.source === 'yt'
      ? {
          label: 'resolved-yt',
          args: [
            ...commonFlags,
            '--extractor-args',
            'youtube:player_client=tv_embedded,android_vr,ios',
            bestCandidate.url,
          ],
        }
      : {
          label: 'resolved-sc',
          args: [...commonFlags, bestCandidate.url],
        },
    // Резервный источник, если первый URL вдруг недоступен
    bestCandidate.source === 'yt'
      ? {
          label: 'fallback-sc',
          args: [...commonFlags, `scsearch1:${query}`],
        }
      : {
          label: 'fallback-yt',
          args: [
            ...commonFlags,
            '--extractor-args',
            'youtube:player_client=tv_embedded,android_vr,ios',
            `ytsearch1:${query} official audio`,
          ],
        },
  ];

  let lastErr = new Error('Не удалось скачать аудиопоток');
  for (const attempt of attempts) {
    try {
      await runCommand('yt-dlp', attempt.args, 45000);
      const files = await fs.readdir(dir);
      const found = files.find((f) => f.startsWith(prefix) && !f.endsWith('.part'));
      if (found) {
        return path.join(dir, found);
      }
    } catch (err) {
      lastErr = err;
      console.warn(`[hybrid:${attempt.label}] error:`, err?.message || err);
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
    // Параллельно получаем лучший оригинальный аудиофайл и ТОЧНО ТУ ЖЕ обложку, что была в поиске
    const [audioFile, coverBuf] = await Promise.all([
      resolveBestAudioSource(track).then((cand) => downloadAudioFromCandidate(cand, query, tempBase)),
      fetchCoverBuffer(track.coverUrl),
    ]);

    rawAudioPath = audioFile;
    if (coverBuf) {
      coverTempPath = `${tempBase}_cover.jpg`;
      await fs.writeFile(coverTempPath, coverBuf);
    }

    const isAlreadyMp3 = /\.mp3$/i.test(rawAudioPath);
    const args = ['-y', '-loglevel', 'error', '-i', rawAudioPath];

    if (coverTempPath) {
      args.push('-i', coverTempPath, '-map', '0:a:0', '-map', '1:v:0', '-c:v', 'copy', '-id3v2_version', '3');
      args.push('-metadata:s:v', 'title=Album cover', '-metadata:s:v', 'comment=Cover (front)');
    } else {
      args.push('-map', '0:a:0', '-id3v2_version', '3');
    }

    if (isAlreadyMp3) {
      // МГНОВЕННОЕ копирование аудиопотока без перекодирования (~0.05 сек на 0.1 vCPU Render!)
      args.push('-c:a', 'copy');
    } else {
      // Сверхбыстрый режим LAME (-compression_level 0 работает в 7 раз быстрее на 0.1 vCPU!)
      args.push('-c:a', 'libmp3lame', '-q:a', '2', '-compression_level', '0');
    }

    if (track.title) args.push('-metadata', `title=${track.title}`);
    if (track.artist) args.push('-metadata', `artist=${track.artist}`);
    if (track.album) args.push('-metadata', `album=${track.album}`);
    if (track.year) args.push('-metadata', `date=${track.year}`);
    if (track.genre) args.push('-metadata', `genre=${track.genre}`);
    if (track.trackNumber) args.push('-metadata', `track=${track.trackNumber}`);
    if (track.bpm) args.push('-metadata', `TBPM=${track.bpm}`);
    args.push(outPath);

    await runCommand('ffmpeg', args, 45000);
  } finally {
    if (rawAudioPath) await fs.unlink(rawAudioPath).catch(() => {});
    if (coverTempPath) await fs.unlink(coverTempPath).catch(() => {});
  }
}
