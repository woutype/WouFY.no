import * as FileSystem from 'expo-file-system/legacy';
import { TrackFile } from '../types';
import { DATA_DIR, LEGACY_DIR } from './library';

export interface LyricLine {
  /** начало строки, сек */
  time: number;
  text: string;
  section: boolean;
}

export type LyricsSource = 'aligned' | 'sylt' | 'lrc-tag' | 'lrc-file' | 'lrclib' | 'manual' | 'estimate' | 'none';

export interface LyricsData {
  lines: LyricLine[];
  /** true — тайминги реальные (SYLT / LRC / LRCLIB / ручная разметка) */
  synced: boolean;
  source: LyricsSource;
  /** «чистый» текст без таймингов — нужен для режима ручной разметки */
  plain: string[];
  /** для source='estimate': длительность трека, под которую рассчитаны тайминги (пересчитываем, когда плеер узнал настоящую) */
  forDuration?: number;
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

/** Число слогов ≈ число гласных групп (кириллица и латиница) — лучший дешёвый прокси длительности строки при пении */
export function syllables(line: string): number {
  const m = line.toLowerCase().match(/[аеёиоуыэюяaeiouy]+/g);
  return Math.max(1, m ? m.length : 1);
}

/** Вес строки при распределении времени: пауза на заголовок секции + число слогов */
export const lineWeight = (line: string, idx: number): number =>
  isSectionLine(line) ? (idx === 0 ? 0.2 : 1.4) : 1.1 + syllables(line) * 0.62;

/** Минимальный зазор между началами соседних строк, сек */
const MIN_GAP = 0.3;

/** Монотонность + зазор: строки идут строго друг за другом от первой до последней и не выходят за пределы трека */
export function normalizeTimes(times: number[], duration: number): number[] {
  const n = times.length;
  if (n === 0) return times;
  const limit = duration > 0 ? duration - 0.4 : Infinity;
  const out = times.map((t) => (isFinite(t) ? Math.max(0.2, t) : 0.2));
  for (let i = 1; i < n; i++) if (out[i] < out[i - 1] + MIN_GAP) out[i] = out[i - 1] + MIN_GAP;
  // если упёрлись в конец трека — сжимаем хвост назад, а не обрезаем строки в одну точку
  if (out[n - 1] > limit) {
    out[n - 1] = limit;
    for (let i = n - 2; i >= 0; i--) if (out[i] > out[i + 1] - MIN_GAP) out[i] = out[i + 1] - MIN_GAP;
    if (out[0] < 0.2) {
      // совсем мало места: равномерно по всему доступному отрезку
      const span = Math.max(0, limit - 0.2);
      for (let i = 0; i < n; i++) out[i] = 0.2 + (span * i) / Math.max(1, n - 1);
    }
  }
  return out;
}

/**
 * Приблизительные тайминги для текста без таймингов (когда нет ни базы, ни SYLT/LRC и нет нативного распознавания голоса).
 * Первая строка получает время после вступления, последняя — до аутро; длительность строк распределяется пропорционально
 * числу слогов + паузы на секции. Весь текст всегда «растянут» от первого слова до конца вокала, а не сжат или обрезан.
 */
export function buildEstimate(plain: string[], duration: number): LyricLine[] {
  const total = duration > 0 ? duration : 200;
  const intro = Math.min(14, Math.max(4, total * 0.05));
  const outro = Math.min(12, Math.max(3, total * 0.04));
  const span = Math.max(8, total - intro - outro);
  const weights = plain.map(lineWeight);
  const sum = weights.reduce((x, y) => x + y, 0) || 1;
  let acc = intro;
  const raw = plain.map((_, i) => {
    const start = acc;
    acc += (weights[i] / sum) * span;
    return start;
  });
  const times = normalizeTimes(raw, duration > 0 ? duration : 0);
  return plain.map((text, i) => ({ time: times[i], text, section: isSectionLine(text) }));
}

export interface TimeAnchor {
  /** индекс строки в plain */
  line: number;
  /** время начала строки, сек */
  t: number;
}

const median = (a: number[]): number => {
  if (a.length === 0) return 0;
  const b = [...a].sort((x, y) => x - y);
  const m = b.length >> 1;
  return b.length % 2 ? b[m] : (b[m - 1] + b[m]) / 2;
};

/**
 * Сборка таймингов по якорям («строка N звучит в момент T»), полученным распознаванием голоса или калибровкой.
 * Гарантии (из-за их отсутствия раньше текст «начинался с середины»):
 *  • якоря проходят проверку: монотонность, робастная линейная модель «время ≈ a + b · вес», физическая осуществимость
 *    (до первого якоря должно хватать времени на все предшествующие строки, после последнего — на все следующие);
 *    ложные совпадения (припев, узнанный не в том месте) отбрасываются;
 *  • строки ДО первого якоря и ПОСЛЕ последнего не «схлопываются» в 0 / в конец: они растягиваются по свободному отрезку;
 *  • итог строго возрастает: первая строка ≥ 0.2 с, последняя ≤ конца трека.
 * Если надёжных якорей меньше трёх — возвращает null (вызывающий использует buildEstimate).
 */
export function fitTimeline(plain: string[], anchorsIn: TimeAnchor[], duration: number): { lines: LyricLine[]; used: number } | null {
  const n = plain.length;
  if (n === 0) return null;
  const total = duration > 0 ? duration : 200;
  const weights = plain.map(lineWeight);
  const cum: number[] = [0];
  weights.forEach((w, i) => cum.push(cum[i] + w));
  const priorRate = Math.max(0.15, (total * 0.88) / cum[n]); // сек на единицу веса при равномерном распределении
  const minRate = 0.14;

  // 1. одна запись на строку, в пределах трека, по возрастанию строк
  const byLine = new Map<number, number[]>();
  for (const a of anchorsIn) {
    if (a.line < 0 || a.line >= n || !isFinite(a.t) || a.t < 0 || a.t > total) continue;
    const arr = byLine.get(a.line) ?? [];
    arr.push(a.t);
    byLine.set(a.line, arr);
  }
  let A: TimeAnchor[] = [...byLine.entries()].sort((x, y) => x[0] - y[0]).map(([line, ts]) => ({ line, t: median(ts) }));

  // 2. наибольшая возрастающая по времени цепочка (выбросы отпадают)
  const chain = (list: TimeAnchor[]): TimeAnchor[] => {
    const k = list.length;
    if (k < 2) return list;
    const len = new Array(k).fill(1);
    const prev = new Array(k).fill(-1);
    for (let a = 0; a < k; a++) {
      for (let b = 0; b < a; b++) {
        if (list[b].t <= list[a].t - 0.2 && len[b] + 1 > len[a]) {
          len[a] = len[b] + 1;
          prev[a] = b;
        }
      }
    }
    let end = 0;
    for (let a = 1; a < k; a++) if (len[a] > len[end]) end = a;
    const out: TimeAnchor[] = [];
    for (let a = end; a >= 0; a = prev[a]) out.push(list[a]);
    return out.reverse();
  };
  A = chain(A);

  // 3. робастная линейная модель t = a + b·cum (Тейл–Сен) и отсев по невязке
  const fit = (list: TimeAnchor[]): { a: number; b: number } => {
    const slopes: number[] = [];
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const dx = cum[list[j].line] - cum[list[i].line];
        if (dx > 0.5) slopes.push((list[j].t - list[i].t) / dx);
      }
    }
    const b0 = slopes.length ? median(slopes) : priorRate;
    const b = isFinite(b0) && b0 > minRate * 0.8 && b0 < 1.6 ? b0 : priorRate;
    const a = median(list.map((x) => x.t - b * cum[x.line]));
    return { a, b };
  };
  const tol = Math.max(6, total * 0.08);
  for (let pass = 0; pass < 3 && A.length >= 3; pass++) {
    const m = fit(A);
    const kept = A.filter((x) => Math.abs(x.t - (m.a + m.b * cum[x.line])) <= tol);
    if (kept.length === A.length) break;
    A = kept;
  }

  // 4. физическая осуществимость: хватает ли времени на строки до первого / после последнего якоря и между соседними
  let changed = true;
  while (changed && A.length >= 3) {
    changed = false;
    const first = A[0];
    if (first.t - 0.4 < cum[first.line] * minRate) {
      A.shift();
      changed = true;
      continue;
    }
    const last = A[A.length - 1];
    if (total - 0.6 - last.t < (cum[n] - cum[last.line]) * minRate * 0.8) {
      A.pop();
      changed = true;
      continue;
    }
    for (let i = 0; i < A.length - 1; i++) {
      if (A[i + 1].t - A[i].t < (cum[A[i + 1].line] - cum[A[i].line]) * minRate) {
        const m = fit(A);
        const ri = Math.abs(A[i].t - (m.a + m.b * cum[A[i].line]));
        const rj = Math.abs(A[i + 1].t - (m.a + m.b * cum[A[i + 1].line]));
        A.splice(ri > rj ? i : i + 1, 1);
        changed = true;
        break;
      }
    }
  }
  if (A.length < 3) return null;

  // 5. сборка
  const model = fit(A);
  const rate = model.b;
  const times = new Array<number>(n).fill(0);
  const first = A[0];
  const last = A[A.length - 1];

  // между якорями — линейно по весам
  for (let k = 0; k < A.length - 1; k++) {
    const l0 = A[k].line;
    const l1 = A[k + 1].line;
    const span = cum[l1] - cum[l0] || 1;
    for (let li = l0; li <= l1; li++) times[li] = A[k].t + ((cum[li] - cum[l0]) / span) * (A[k + 1].t - A[k].t);
  }
  // до первого якоря: свободный отрезок [0.4 … first.t]; если экстраполяция уходит в минус — сжимаем пропорционально (не схлопываем в 0)
  if (first.line > 0) {
    const want = cum[first.line] * rate;
    const room = first.t - 0.4;
    const f = want > room ? Math.max(minRate / rate, room / want) : 1;
    for (let li = 0; li < first.line; li++) times[li] = first.t - (cum[first.line] - cum[li]) * rate * f;
  }
  // после последнего якоря: до конца вокала (не позже total − 1.5)
  if (last.line < n - 1) {
    const need = (cum[n - 1] - cum[last.line] + weights[n - 1]) * rate;
    const room = Math.max(0.5, total - 1.5 - last.t);
    const f = need > room ? room / need : 1;
    for (let li = last.line + 1; li < n; li++) times[li] = last.t + (cum[li] - cum[last.line]) * rate * f;
  }

  const norm = normalizeTimes(times, duration > 0 ? duration : 0);
  return { lines: plain.map((text, i) => ({ time: norm[i], text, section: isSectionLine(text) })), used: A.length };
}

/** Тексты хранятся ВНЕ папки Music: Library/Application Support/WouFY/lyrics_cache */
const CACHE_DIR = `${DATA_DIR}lyrics_cache/`;
const LEGACY_CACHE_DIR = `${LEGACY_DIR}lyrics_cache/`;

async function ensureCacheDir() {
  try {
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

/** Очистка названий трека и исполнителя от мусора для точного поиска */
export function cleanQuery(title: string, artist?: string): { cleanTitle: string; cleanArtist: string } {
  const cleanTitle = (title || '')
    .replace(/\.[a-zA-Z0-9]{2,4}$/, '')
    .replace(/^\d+[\s.\-_)]+(?=\D)/, '')
    .replace(/\s*[\(\[](?:feat|ft|featuring|official|remaster(?:ed)?|video|audio|lyrics?|hd|single|explicit|prod)[^\)\]]*[\)\]]/gi, '')
    .replace(/\s+(?:feat\.?|ft\.?|featuring)\s+.*$/i, '')
    .replace(/\s*-\s*(?:single|remaster(?:ed)?(?:\s+\d{4})?)\s*$/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
  const cleanArtist = (artist || '')
    .replace(/\s*[\(\[](?:feat|ft)[^\)\]]*[\)\]]/gi, '')
    .replace(/\s+(?:feat\.?|ft\.?|featuring)\s+.*$/i, '')
    .replace(/Неизвестный исполнитель/gi, '')
    .replace(/Unknown Artist/gi, '')
    .trim();
  return { cleanTitle, cleanArtist };
}

const normTokens = (s: string): string[] =>
  s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/ё/g, 'е')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter(Boolean);

/** Похожесть строк 0…1: пересечение слов + вхождение одной строки в другую */
function similarity(a: string, b: string): number {
  const ta = normTokens(a);
  const tb = normTokens(b);
  if (ta.length === 0 || tb.length === 0) return 0;
  const sa = new Set(ta);
  const sb = new Set(tb);
  let inter = 0;
  sa.forEach((x) => sb.has(x) && inter++);
  const jaccard = inter / (sa.size + sb.size - inter);
  const ja = ta.join(' ');
  const jb = tb.join(' ');
  const contain = ja.includes(jb) || jb.includes(ja) ? 0.85 : 0;
  return Math.max(jaccard, contain);
}

interface LrcCandidate {
  trackName?: string;
  artistName?: string;
  duration?: number;
  instrumental?: boolean;
  syncedLyrics?: string | null;
  plainLyrics?: string | null;
}

const LRC_HEADERS = { 'User-Agent': 'WouFY.no Music Player (https://github.com/woutype/woufy)' };

async function lrcFetch(url: string, ms: number): Promise<any | null> {
  const ctrl = new AbortController();
  const tId = setTimeout(() => ctrl.abort(), ms);
  try {
    const res = await fetch(url, { headers: LRC_HEADERS, signal: ctrl.signal });
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  } finally {
    clearTimeout(tId);
  }
}

/** Оценка кандидата: длительность (главный признак версии), название, артист. Меньше порога — не берём. */
function scoreCandidate(c: LrcCandidate, title: string, artist: string, duration: number): number {
  if (c.instrumental) return -1;
  const st = similarity(c.trackName ?? '', title);
  if (st < 0.5) return -1;
  let score = st * 2;
  if (artist) {
    const sa = similarity(c.artistName ?? '', artist);
    if (sa < 0.25 && st < 0.95) return -1;
    score += sa * 1.5;
  }
  if (duration > 0 && c.duration) {
    const d = Math.abs(c.duration - duration);
    if (d > 8) return -1; // другая версия/ремикс
    score += d <= 1.5 ? 2 : d <= 3 ? 1.2 : d <= 5 ? 0.4 : 0;
  }
  return score;
}

export interface OnlineLyrics {
  synced?: string;
  plain?: string;
  /** во сколько раз растянуть тайминги (длительность вашего файла / длительность версии в базе) */
  scale?: number;
}

const wordSet = (text: string, max = 260): Set<string> => new Set(normTokens(text).slice(0, max).filter((w) => w.length > 2));

/** Совпадение текста песни: доля общих слов (0…1). Нужна, чтобы найти ту же песню в базе, когда название записано иначе. */
function lyricsOverlap(a: string, b: string): number {
  const sa = wordSet(a);
  const sb = wordSet(b);
  if (sa.size < 8 || sb.size < 8) return 0;
  let inter = 0;
  sa.forEach((w) => sb.has(w) && inter++);
  return inter / Math.min(sa.size, sb.size);
}

/**
 * Поиск текста в базе LRCLIB. Несколько запросов (точный по тегам, поиск «артист название», поиск по полям, только название),
 * кандидаты оцениваются по длительности, названию и артисту; берётся лучший, а не первый попавшийся.
 */
export async function fetchOnlineLyrics(track: TrackFile, duration: number): Promise<OnlineLyrics | null> {
  const { cleanTitle, cleanArtist } = cleanQuery(track.title, track.artist);
  if (!cleanTitle) return null;
  const dur = duration > 0 ? duration : 0;

  const pool: LrcCandidate[] = [];

  // 1. Точный запрос (теги + альбом + длительность)
  let getUrl = `https://lrclib.net/api/get?track_name=${encodeURIComponent(cleanTitle)}`;
  if (cleanArtist) getUrl += `&artist_name=${encodeURIComponent(cleanArtist)}`;
  if (track.album && track.album !== 'Сингл') getUrl += `&album_name=${encodeURIComponent(track.album)}`;
  if (dur > 0) getUrl += `&duration=${Math.round(dur)}`;
  const exact = await lrcFetch(getUrl, 4500);
  if (exact && !Array.isArray(exact) && (exact.syncedLyrics || exact.plainLyrics)) pool.push(exact);

  // 2–4. Поиск (запросы идут параллельно)
  const searches = [
    `https://lrclib.net/api/search?q=${encodeURIComponent(cleanArtist ? `${cleanArtist} ${cleanTitle}` : cleanTitle)}`,
    `https://lrclib.net/api/search?track_name=${encodeURIComponent(cleanTitle)}${cleanArtist ? `&artist_name=${encodeURIComponent(cleanArtist)}` : ''}`,
  ];
  if (cleanArtist) searches.push(`https://lrclib.net/api/search?q=${encodeURIComponent(cleanTitle)}`);
  const results = await Promise.all(searches.map((u) => lrcFetch(u, 6000)));
  for (const r of results) if (Array.isArray(r)) pool.push(...r.slice(0, 25));

  let best: LrcCandidate | null = null;
  let bestScore = -1;
  for (const c of pool) {
    if (!c.syncedLyrics && !c.plainLyrics) continue;
    let sc = scoreCandidate(c, cleanTitle, cleanArtist, dur);
    if (sc < 0) continue;
    if (c.syncedLyrics) sc += 0.6; // синхронизированный предпочтительнее
    if (sc > bestScore) {
      bestScore = sc;
      best = c;
    }
  }
  if (best) {
    const scale = dur > 0 && best.duration && Math.abs(best.duration - dur) > 1.5 ? dur / best.duration : undefined;
    return { synced: best.syncedLyrics || undefined, plain: best.plainLyrics || undefined, scale };
  }

  // Название в базе записано иначе (транслит, другой порядок слов), но это та же песня: сверяем ТЕКСТ из файла с текстом кандидатов
  if (track.lyrics) {
    let bestOv = 0;
    let match: LrcCandidate | null = null;
    for (const c of pool) {
      if (!c.syncedLyrics || c.instrumental) continue;
      if (dur > 0 && c.duration && Math.abs(c.duration - dur) > 30) continue;
      const ov = lyricsOverlap(track.lyrics, c.plainLyrics || c.syncedLyrics.replace(/\[[^\]]*\]/g, ' '));
      if (ov > bestOv) {
        bestOv = ov;
        match = c;
      }
    }
    if (match && bestOv >= 0.6) {
      const scale = dur > 0 && match.duration && Math.abs(match.duration - dur) > 1.5 ? dur / match.duration : undefined;
      return { synced: match.syncedLyrics || undefined, plain: match.plainLyrics || undefined, scale };
    }
  }
  return null;
}

/**
 * Подстройка приблизительных таймингов под фактический момент звучания строки (долгое нажатие на строку).
 * Строки до якоря и сам якорь сдвигаются на разницу, дальше сдвиг плавно затухает до 40% к последней строке
 * (вокал заканчивается раньше конца трека), поэтому ошибка не накапливается.
 */
export function calibrateEstimate(lines: LyricLine[], anchorIndex: number, position: number, duration: number): LyricLine[] {
  const anchor = lines[anchorIndex];
  if (!anchor) return lines;
  const delta = position - anchor.time;
  const last = lines[lines.length - 1].time;
  const span = Math.max(1, last - anchor.time);
  const shifted = lines.map((l, i) => {
    let d = delta;
    if (i > anchorIndex) d = delta * (1 - 0.6 * Math.min(1, (l.time - anchor.time) / span));
    else if (i < anchorIndex && anchor.time > 0.5) {
      // строки до якоря сжимаются/растягиваются пропорционально (а не сдвигаются целиком — иначе упрутся в 0 и «схлопнутся»)
      return { ...l, time: (l.time / anchor.time) * Math.max(0.4, position) };
    }
    return { ...l, time: l.time + d };
  });
  const times = normalizeTimes(
    shifted.map((l) => l.time),
    duration
  );
  return shifted.map((l, i) => ({ ...l, time: times[i] }));
}

/** Совместимость: только синхронизированный LRC */
export async function fetchOnlineLrc(track: TrackFile, duration: number): Promise<string | null> {
  const r = await fetchOnlineLyrics(track, duration);
  return r?.synced ?? null;
}

/** Свои/сохранённые тексты: .lrc рядом с треком (положил пользователь) и локальный кэш приложения (в т.ч. ручная разметка и сдвиг) */
async function loadCuratedLrc(track: TrackFile): Promise<LyricsData | null> {
  const tryRead = async (path: string): Promise<LyricsData | null> => {
    try {
      const info = await FileSystem.getInfoAsync(path);
      if (!info.exists) return null;
      const lines = parseLrc(await FileSystem.readAsStringAsync(path));
      return lines ? { lines, synced: true, source: 'lrc-file', plain: lines.map((l) => l.text) } : null;
    } catch {
      return null;
    }
  };
  const safeId = (track.id || `${track.artist}_${track.title}`).replace(/[^a-zA-Z0-9_\u0400-\u04FF]/g, '_');
  return (
    (await tryRead(cachePathFor(track))) ||
    (await tryRead(`${LEGACY_CACHE_DIR}${safeId}.lrc`)) ||
    (track.lrcUri ? await tryRead(track.lrcUri) : null)
  );
}

/**
 * Порядок источников (в «идеале» совпадает с песней):
 *  1. сохранённый/свой .lrc (ручная разметка, сдвиг, ранее найденное в базе);
 *  2. онлайн-база LRCLIB (оценка кандидатов по длительности, названию, артисту);
 *  3. если в базе нет — текст из самого файла: SYLT (теги с таймингами) → LRC-метки в USLT → обычный текст USLT;
 *  4. обычный текст без таймингов (из файла или из базы) — приблизительные тайминги по слогам.
 */
export async function loadLyrics(track: TrackFile, duration: number, allowOnline = true): Promise<LyricsData> {
  const curated = await loadCuratedLrc(track);
  if (curated) return curated;

  let onlinePlain: string | undefined;
  if (allowOnline) {
    try {
      const online = await fetchOnlineLyrics(track, duration);
      if (online?.synced) {
        let lines = parseLrc(online.synced);
        if (lines && online.scale && online.scale > 0.8 && online.scale < 1.25) {
          const k = online.scale;
          lines = lines.map((l) => ({ ...l, time: l.time * k }));
        }
        if (lines) {
          saveLrc(track, lines).catch(() => {}); // кэш приложения (не папка Music)
          return { lines, synced: true, source: 'lrclib', plain: lines.map((l) => l.text) };
        }
      }
      onlinePlain = online?.plain;
    } catch {
      /* offline */
    }
  }

  // текст из самого файла
  if (track.syncedLyrics && track.syncedLyrics.length >= 2) {
    const lines = track.syncedLyrics.map((l) => ({ time: l.time, text: l.text, section: isSectionLine(l.text) }));
    return { lines, synced: true, source: 'sylt', plain: lines.map((l) => l.text) };
  }
  if (track.lyrics) {
    const lines = parseLrc(track.lyrics);
    if (lines) return { lines, synced: true, source: 'lrc-tag', plain: lines.map((l) => l.text) };
  }

  const plainText = track.lyrics || onlinePlain;
  if (plainText) {
    const plain = plainLinesOf(plainText);
    if (plain.length) return { lines: buildEstimate(plain, duration), synced: false, source: 'estimate', plain, forDuration: duration };
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
