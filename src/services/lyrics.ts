import * as FileSystem from 'expo-file-system/legacy';
import { TrackFile } from '../types';

export interface LyricLine {
  /** начало строки, сек */
  time: number;
  text: string;
  section: boolean;
}

export type LyricsSource = 'sylt' | 'lrc-tag' | 'lrc-file' | 'manual' | 'estimate' | 'none';

export interface LyricsData {
  lines: LyricLine[];
  /** true — тайминги реальные (SYLT / LRC / ручная разметка) */
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
 * с учётом вступления и пауз между секциями. ЭТО ПРИБЛИЗИТЕЛЬНО — точную синхронизацию
 * даёт только LRC/SYLT или ручная разметка.
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

export async function loadLyrics(track: TrackFile, duration: number): Promise<LyricsData> {
  // 1. SYLT из ID3
  if (track.syncedLyrics && track.syncedLyrics.length >= 2) {
    const lines = track.syncedLyrics.map((l) => ({ time: l.time, text: l.text, section: isSectionLine(l.text) }));
    return { lines, synced: true, source: 'sylt', plain: lines.map((l) => l.text) };
  }

  // 2. .lrc рядом с треком (создаётся и ручной разметкой)
  if (track.lrcUri) {
    try {
      const raw = await FileSystem.readAsStringAsync(track.lrcUri);
      const lines = parseLrc(raw);
      if (lines) return { lines, synced: true, source: 'lrc-file', plain: lines.map((l) => l.text) };
      const plain = plainLinesOf(raw);
      if (plain.length) {
        return { lines: buildEstimate(plain, duration), synced: false, source: 'estimate', plain };
      }
    } catch {
      /* падаем дальше */
    }
  }

  // 3. USLT с LRC-метками или обычный текст
  if (track.lyrics) {
    const lines = parseLrc(track.lyrics);
    if (lines) return { lines, synced: true, source: 'lrc-tag', plain: lines.map((l) => l.text) };
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

export function lrcPathFor(track: TrackFile): string {
  return track.uri.replace(/\.[^/.]+$/, '.lrc');
}

/** Сохраняет разметку в <имя трека>.lrc рядом с файлом */
export async function saveLrc(track: TrackFile, lines: LyricLine[]): Promise<string> {
  const path = lrcPathFor(track);
  const header = `[ti:${track.title}]\n[ar:${track.artist}]\n[by:Woufy]\n`;
  const body = lines.map((l) => `[${fmt(l.time)}]${l.text}`).join('\n');
  await FileSystem.writeAsStringAsync(path, `${header}${body}\n`);
  return path;
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
