import * as FileSystem from 'expo-file-system/legacy';
import { TrackFile } from '../types';

export interface LyricLine {
  /** начало строки, сек */
  time: number;
  text: string;
  section: boolean;
}

export type LyricsSource = 'sylt' | 'lrc-tag' | 'lrc-file' | 'lrclib' | 'manual' | 'estimate' | 'none';

export interface LyricsData {
  lines: LyricLine[];
  /** true — тайминги реальные (SYLT / LRC / LRCLIB / ручная разметка) */
  synced: boolean;
  source: LyricsSource;
  /** «чистый» текст без таймингов — нужен для режима ручной разметки */
  plain: string[];
}

export const isSectionLine = (t: string) => /^\(.*\)$/.test(t) || /^\[[^\]\d][^\]]*\]$/.test(t);

const TS_RE = /\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\]/g;

/** Разбор LRC: несколько меток в строке, [offset:], игнор служебных тегов и слов <mm:ss.xx> */
export function parseLrc(raw: string): LyricLine[] | null {
  const out: LyricLine[] = [];
  let offset = 0;

  for (const rawLine of raw.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;

    const off = line.match(/^\[offset:\s*([+-]?\d+)\s*\]/i);
    if (off) {
      offset = parseInt(off[1], 10) / 1000;
      continue;
    }

    const times: number[] = [];
    let lastEnd = 0;
    TS_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = TS_RE.exec(line)) !== null) {
      if (m.index !== lastEnd) break; // метки только в начале строки
      const frac = m[3] ? parseFloat(`0.${m[3]}`) : 0;
      times.push(parseInt(m[1], 10) * 60 + parseInt(m[2], 10) + frac);
      lastEnd = m.index + m[0].length;
    }
    if (times.length === 0) continue;

    const text = line
      .slice(lastEnd)
      .replace(/<\d{1,3}:\d{1,2}(?:[.:]\d{1,3})?>/g, '')
      .trim();
    for (const t of times) {
      out.push({ time: Math.max(0, t + offset), text: text || '…', section: isSectionLine(text) });
    }
  }

  if (out.length < 2) return null;
  out.sort((a, b) => a.time - b.time);
  return out;
}

export function plainLinesOf(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((l) => l.replace(TS_RE, '').trim())
    .filter((l) => l.length > 0);
}

/**
 * Запасной вариант для текста без таймингов: распределяем строки по длине трека
 * с учётом вступления и пауз между секциями.
 */
export function buildEstimate(plain: string[], duration: number): LyricLine[] {
  const total = duration > 0 ? duration : 180;
  const weights = plain.map((line, idx) => {
    const sec = isSectionLine(line);
    if (idx === 0 && sec) return 6.5;
    if (sec) return 2.2;
    if (line.length <= 6) return 1.3;
    return Math.min(3.6, Math.max(1.6, line.length * 0.11 + 1.2));
  });
  const sum = weights.reduce((a, b) => a + b, 0) || 1;
  let acc = 0;
  return plain.map((text, i) => {
    const start = acc;
    acc += (weights[i] / sum) * total;
    return { time: start, text, section: isSectionLine(text) };
  });
}

const CACHE_DIR = `${FileSystem.documentDirectory ?? ''}.woufy/lyrics_cache/`;
const LEGACY_CACHE_DIR = `${FileSystem.documentDirectory ?? ''}lyrics_cache/`;

async function ensureCacheDir() {
  try {
    if (!FileSystem.documentDirectory) return;
    const info = await FileSystem.getInfoAsync(CACHE_DIR);
    if (!info.exists) {
      await FileSystem.makeDirectoryAsync(CACHE_DIR, { intermediates: true });
    }
  } catch {
    /* ignore */
  }
}

export function cachePathFor(track: TrackFile): string {
  const safeId = (track.id || `${track.artist}_${track.title}`).replace(/[^a-zA-Z0-9_\u0400-\u04FF]/g, '_');
  return `${CACHE_DIR}${safeId}.lrc`;
}

export function lrcPathFor(track: TrackFile): string {
  return track.uri.replace(/\.[^/.]+$/, '.lrc');
}

/** Очистка названий трека и исполнителя от мусора для точного поиска в LRCLIB */
export function cleanQuery(title: string, artist?: string): { cleanTitle: string; cleanArtist: string } {
  let cleanTitle = (title || '')
    .replace(/\.[a-zA-Z0-9]+$/, '')
    .replace(/^\d+[\s.\-_]+/, '')
    .replace(/\s*[\(\[](?:feat|ft|official|remastered|video|audio|lyrics|hd|single)[^\)\]]*[\)\]]/gi, '')
    .replace(/\s*-\s*single/gi, '')
    .trim();
  let cleanArtist = (artist || '')
    .replace(/\s*[\(\[](?:feat|ft)[^\)\]]*[\)\]]/gi, '')
    .replace(/Неизвестный исполнитель/gi, '')
    .replace(/Unknown Artist/gi, '')
    .trim();
  return { cleanTitle, cleanArtist };
}

/** Загрузка синхронизированного текста (LRC) из базы LRCLIB */
export async function fetchOnlineLrc(track: TrackFile, duration: number): Promise<string | null> {
  const { cleanTitle, cleanArtist } = cleanQuery(track.title, track.artist);
  if (!cleanTitle) return null;

  const headers = { 'User-Agent': 'Woufy Music Player (https://github.com/woutype/woufy)' };

  // 1. Точный запрос (api/get)
  try {
    const ctrl = new AbortController();
    const tId = setTimeout(() => ctrl.abort(), 4000);
    let getUrl = `https://lrclib.net/api/get?track_name=${encodeURIComponent(cleanTitle)}`;
    if (cleanArtist) getUrl += `&artist_name=${encodeURIComponent(cleanArtist)}`;
    if (duration > 0) getUrl += `&duration=${Math.round(duration)}`;
    const res = await fetch(getUrl, { headers, signal: ctrl.signal });
    clearTimeout(tId);
    if (res.ok) {
      const data = await res.json();
      if (data?.syncedLyrics) return data.syncedLyrics;
    }
  } catch {
    /* fallback to search */
  }

  // 2. Поисковый запрос с выбором по длительности трека (api/search)
  try {
    const ctrl = new AbortController();
    const tId = setTimeout(() => ctrl.abort(), 5000);
    const q = cleanArtist ? `${cleanTitle} ${cleanArtist}` : cleanTitle;
    const sUrl = `https://lrclib.net/api/search?q=${encodeURIComponent(q)}`;
    const res = await fetch(sUrl, { headers, signal: ctrl.signal });
    clearTimeout(tId);
    if (res.ok) {
      const list = await res.json();
      if (Array.isArray(list)) {
        const withSynced = list.filter((x: any) => typeof x.syncedLyrics === 'string' && x.syncedLyrics.length > 10);
        if (withSynced.length > 0) {
          if (duration > 0) {
            withSynced.sort((a: any, b: any) => Math.abs((a.duration || 0) - duration) - Math.abs((b.duration || 0) - duration));
          }
          return withSynced[0].syncedLyrics;
        }
      }
    }
  } catch {
    /* network unavailable or timeout */
  }

  return null;
}

export async function loadLyrics(track: TrackFile, duration: number, allowOnline = true): Promise<LyricsData> {
  // 1. SYLT из ID3 (синхронизированный встроенный тег)
  if (track.syncedLyrics && track.syncedLyrics.length >= 2) {
    const lines = track.syncedLyrics.map((l) => ({ time: l.time, text: l.text, section: isSectionLine(l.text) }));
    return { lines, synced: true, source: 'sylt', plain: lines.map((l) => l.text) };
  }

  // 2. .lrc рядом с треком (создаётся и ручной разметкой, и кэшем)
  if (track.lrcUri) {
    try {
      const raw = await FileSystem.readAsStringAsync(track.lrcUri);
      const lines = parseLrc(raw);
      if (lines) return { lines, synced: true, source: 'lrc-file', plain: lines.map((l) => l.text) };
    } catch {
      /* fallback */
    }
  }

  // 3. Локальный кэш приложения (.woufy/lyrics_cache/ или lyrics_cache/)
  try {
    const cp = cachePathFor(track);
    let cInfo = await FileSystem.getInfoAsync(cp);
    let targetPath = cp;
    if (!cInfo.exists) {
      const safeId = (track.id || `${track.artist}_${track.title}`).replace(/[^a-zA-Z0-9_\u0400-\u04FF]/g, '_');
      const legacyPath = `${LEGACY_CACHE_DIR}${safeId}.lrc`;
      const legacyInfo = await FileSystem.getInfoAsync(legacyPath);
      if (legacyInfo.exists) {
        targetPath = legacyPath;
        cInfo = legacyInfo;
      }
    }
    if (cInfo.exists) {
      const raw = await FileSystem.readAsStringAsync(targetPath);
      const lines = parseLrc(raw);
      if (lines) return { lines, synced: true, source: 'lrc-file', plain: lines.map((l) => l.text) };
    }
  } catch {
    /* fallback */
  }

  // 4. USLT с LRC-метками
  if (track.lyrics) {
    const lines = parseLrc(track.lyrics);
    if (lines) return { lines, synced: true, source: 'lrc-tag', plain: lines.map((l) => l.text) };
  }

  // 5. Онлайн-поиск в LRCLIB (как в Dynamic-Lyrics)
  if (allowOnline) {
    try {
      const raw = await fetchOnlineLrc(track, duration);
      if (raw) {
        const lines = parseLrc(raw);
        if (lines) {
          // Кэшируем строго в скрытую папку кэша, не захламляя Music/
          saveLrc(track, lines).catch(() => {});
          return { lines, synced: true, source: 'lrclib', plain: lines.map((l) => l.text) };
        }
      }
    } catch {
      /* offline */
    }
  }

  // 6. Если синхронизированного нет — берём обычный текст из USLT (приблизительно)
  if (track.lyrics) {
    const plain = plainLinesOf(track.lyrics);
    if (plain.length) {
      return { lines: buildEstimate(plain, duration), synced: false, source: 'estimate', plain };
    }
  }

  return { lines: [], synced: false, source: 'none', plain: [] };
}

const fmt = (t: number) => {
  const m = Math.floor(t / 60);
  const s = t - m * 60;
  return `${String(m).padStart(2, '0')}:${s.toFixed(2).padStart(5, '0')}`;
};

/** Сохраняет разметку строго в кэш (.woufy/lyrics_cache/), не трогая папку Music */
export async function saveLrc(track: TrackFile, lines: LyricLine[]): Promise<string> {
  const header = `[ti:${track.title}]\n[ar:${track.artist}]\n[by:Woufy]\n`;
  const body = lines.map((l) => `[${fmt(l.time)}]${l.text}`).join('\n');
  const content = `${header}${body}\n`;

  await ensureCacheDir();
  const cp = cachePathFor(track);
  try {
    await FileSystem.writeAsStringAsync(cp, content);
  } catch (e) {
    console.warn('[lyrics] failed to write to cache:', e);
  }

  return cp;
}

/** Сдвиг всех временных меток на deltaSec (например +0.5 сек или -0.5 сек) */
export function shiftLyricsOffset(lines: LyricLine[], deltaSec: number): LyricLine[] {
  return lines.map((l) => ({
    ...l,
    time: Math.max(0, Number((l.time + deltaSec).toFixed(2))),
  }));
}

/** Индекс активной строки (последняя, чьё время уже наступило) */
export function activeLineIndex(lines: LyricLine[], position: number, lookahead = 0.18): number {
  if (lines.length === 0) return -1;
  const t = position + lookahead;
  let lo = 0;
  let hi = lines.length - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (lines[mid].time <= t) {
      ans = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return ans;
}
