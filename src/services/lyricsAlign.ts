import { WoufyFX } from '../../modules/woufy-fx';
import { LyricLine, TimeAnchor, fitTimeline, isSectionLine } from './lyrics';

/**
 * Подгон текста без таймингов по ГОЛОСУ в самом файле.
 *
 * 1. Нативно (Speech.framework, на устройстве где возможно) распознаём вокал → слова с временем начала.
 * 2. Слова распознавания и слова известного текста сопоставляются выравниванием Нидлмана–Вунша с «нечётким» сравнением
 *    (опечатки распознавания, окончания), поэтому даже при 30–40% верно узнанных слов получаем много надёжных якорей.
 * 3. Время начала строки = время первого узнанного слова строки минус длительность слов перед ним.
 * 4. Якоря чистятся (наибольшая монотонная цепочка — выбросы отпадают), остальные строки интерполируются между
 *    соседними якорями пропорционально числу слогов.
 *
 * Если узнано слишком мало слов — возвращается null, и остаётся приблизительная оценка.
 */

const normWord = (w: string) =>
  w
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/ё/g, 'е')
    .replace(/[^\p{L}\p{N}]/gu, '');

function lev(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (!m) return n;
  if (!n) return m;
  let prev = new Array(n + 1);
  let cur = new Array(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;
  for (let i = 1; i <= m; i++) {
    cur[0] = i;
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    [prev, cur] = [cur, prev];
  }
  return prev[n];
}

const pairScore = (a: string, b: string): number => {
  if (a === b) return a.length <= 2 ? 1 : 2.2;
  if (a.length >= 4 && b.length >= 4) {
    const d = lev(a, b) / Math.max(a.length, b.length);
    if (d <= 0.25) return 1.4;
    if (d <= 0.38) return 0.6;
  }
  return -1.1;
};

export function speechAlignAvailable(): boolean {
  try {
    return Boolean(WoufyFX && typeof WoufyFX.recognizeSpeech === 'function');
  } catch {
    return false;
  }
}

function pickLocales(plain: string[]): string[] {
  const text = plain.join(' ');
  const cyr = (text.match(/[а-яё]/gi) || []).length;
  const lat = (text.match(/[a-z]/gi) || []).length;
  const total = cyr + lat || 1;
  const r = cyr / total;
  if (r > 0.85) return ['ru-RU'];
  if (r < 0.15) return ['en-US'];
  return r >= 0.5 ? ['ru-RU', 'en-US'] : ['en-US', 'ru-RU'];
}

/** Выравнивание и сборка таймингов. Возвращает null, если надёжных якорей слишком мало. */
export function alignWords(
  plain: string[],
  recognized: { text: string; start: number; dur: number }[],
  duration: number
): { lines: LyricLine[]; anchors: number; coverage: number } | null {
  const L: { w: string; line: number; pos: number }[] = [];
  plain.forEach((line, li) => {
    if (isSectionLine(line)) return;
    let pos = 0;
    for (const raw of line.split(/\s+/)) {
      const w = normWord(raw);
      if (!w) continue;
      L.push({ w, line: li, pos: pos++ });
    }
  });
  const R: { w: string; t: number }[] = [];
  for (const r of recognized) {
    for (const part of r.text.split(/\s+/)) {
      const w = normWord(part);
      if (w) R.push({ w, t: r.start });
    }
  }
  const n = L.length;
  const m = R.length;
  if (n < 8 || m < 8) return null;

  // Нидлман–Вунш со свободными концами
  const GAP = 0.55;
  const W = m + 1;
  const H = new Float32Array((n + 1) * W);
  const T = new Uint8Array((n + 1) * W); // 0 диагональ, 1 вверх (пропуск слова текста), 2 влево (пропуск узнанного слова)
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      const diag = H[(i - 1) * W + (j - 1)] + pairScore(L[i - 1].w, R[j - 1].w);
      const up = H[(i - 1) * W + j] - GAP;
      const left = H[i * W + (j - 1)] - GAP;
      let best = diag;
      let dir = 0;
      if (up > best) {
        best = up;
        dir = 1;
      }
      if (left > best) {
        best = left;
        dir = 2;
      }
      H[i * W + j] = best;
      T[i * W + j] = dir;
    }
  }
  // конец: лучшая клетка в последней строке/столбце
  let bi = n;
  let bj = m;
  let bs = -1e9;
  for (let j = 0; j <= m; j++) if (H[n * W + j] > bs) (bs = H[n * W + j]), (bi = n), (bj = j);
  for (let i = 0; i <= n; i++) if (H[i * W + m] > bs) (bs = H[i * W + m]), (bi = i), (bj = m);

  const pairs: { i: number; j: number }[] = [];
  let i = bi;
  let j = bj;
  while (i > 0 && j > 0) {
    const dir = T[i * W + j];
    if (dir === 0) {
      if (pairScore(L[i - 1].w, R[j - 1].w) > 0.5) pairs.push({ i: i - 1, j: j - 1 });
      i--;
      j--;
    } else if (dir === 1) i--;
    else j--;
  }
  pairs.reverse();

  // оценка начала строки по каждому совпавшему слову (слово №pos в строке начинается примерно через 0.4 с · pos после начала строки)
  const anchorsRaw: TimeAnchor[] = [];
  for (const p of pairs) {
    const lw = L[p.i];
    anchorsRaw.push({ line: lw.line, t: Math.max(0, R[p.j].t - lw.pos * 0.4) });
  }
  if (anchorsRaw.length < 4) return null;

  // Якоря проверяются и «сшиваются» в тайминги в fitTimeline: ложные совпадения отсеиваются, строки до первого
  // и после последнего якоря растягиваются по свободному отрезку (раньше они схлопывались в 0 → текст «начинался с середины»)
  const fitted = fitTimeline(plain, anchorsRaw, duration);
  if (!fitted) return null;
  const lineCount = plain.filter((l) => !isSectionLine(l)).length || 1;
  const coverage = fitted.used / lineCount;
  if (fitted.used < 4 || coverage < 0.1) return null;
  return { lines: fitted.lines, anchors: fitted.used, coverage };
}

export async function alignBySpeech(uri: string, plain: string[], duration: number): Promise<LyricLine[] | null> {
  if (!speechAlignAvailable() || plain.length < 4) return null;
  let best: { lines: LyricLine[]; anchors: number; coverage: number } | null = null;
  for (const locale of pickLocales(plain)) {
    try {
      const words = await WoufyFX!.recognizeSpeech(uri, locale);
      const res = alignWords(plain, words, duration);
      if (res && (!best || res.coverage > best.coverage)) best = res;
      if (best && best.coverage >= 0.25) break; // достаточно якорей — второй язык не нужен
    } catch {
      /* язык недоступен / нет разрешения — пробуем следующий */
    }
  }
  return best ? best.lines : null;
}
