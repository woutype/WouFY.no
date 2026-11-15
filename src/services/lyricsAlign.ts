import { WoufyFX } from '../../modules/woufy-fx';
import { LyricLine, isSectionLine, syllables } from './lyrics';

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

interface Anchor {
  line: number;
  t: number;
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

  // оценка начала строки по каждому совпавшему слову
  const perLine = new Map<number, number[]>();
  for (const p of pairs) {
    const lw = L[p.i];
    const est = R[p.j].t - lw.pos * 0.4;
    const arr = perLine.get(lw.line) ?? [];
    arr.push(est);
    perLine.set(lw.line, arr);
  }
  let anchors: Anchor[] = [];
  [...perLine.entries()]
    .sort((a, b) => a[0] - b[0])
    .forEach(([line, arr]) => {
      arr.sort((a, b) => a - b);
      anchors.push({ line, t: arr[Math.floor(arr.length / 2)] });
    });
  if (anchors.length < 4) return null;

  // наибольшая неубывающая цепочка по времени (отсев выбросов)
  const k = anchors.length;
  const len = new Array(k).fill(1);
  const prev = new Array(k).fill(-1);
  for (let a = 0; a < k; a++) {
    for (let b = 0; b < a; b++) {
      if (anchors[b].t <= anchors[a].t - 0.2 && len[b] + 1 > len[a]) {
        len[a] = len[b] + 1;
        prev[a] = b;
      }
    }
  }
  let end = 0;
  for (let a = 1; a < k; a++) if (len[a] > len[end]) end = a;
  const chain: Anchor[] = [];
  for (let a = end; a >= 0; a = prev[a]) chain.push(anchors[a]);
  chain.reverse();
  anchors = chain;

  const lineCount = plain.filter((l) => !isSectionLine(l)).length || 1;
  const coverage = anchors.length / lineCount;
  if (anchors.length < 4 || coverage < 0.1) return null;

  // веса строк (слоги) для интерполяции
  const weights = plain.map((line, idx) => (isSectionLine(line) ? (idx === 0 ? 0.2 : 1.4) : 1.1 + syllables(line) * 0.62));
  const cum: number[] = [0];
  weights.forEach((w, idx) => cum.push(cum[idx] + w));

  const times = new Array<number>(plain.length).fill(0);
  const A = anchors;
  // между якорями
  for (let a = 0; a < A.length - 1; a++) {
    const l0 = A[a].line;
    const l1 = A[a + 1].line;
    const span = cum[l1] - cum[l0] || 1;
    for (let li = l0; li <= l1; li++) {
      times[li] = A[a].t + ((cum[li] - cum[l0]) / span) * (A[a + 1].t - A[a].t);
    }
  }
  // средняя скорость «секунд на единицу веса» по якорному участку
  const rate = (A[A.length - 1].t - A[0].t) / Math.max(1, cum[A[A.length - 1].line] - cum[A[0].line]);
  const safeRate = isFinite(rate) && rate > 0.05 && rate < 2 ? rate : 0.45;
  for (let li = A[0].line - 1; li >= 0; li--) times[li] = Math.max(0, A[0].t - (cum[A[0].line] - cum[li]) * safeRate);
  const lastA = A[A.length - 1];
  for (let li = lastA.line + 1; li < plain.length; li++) {
    times[li] = Math.min(duration > 0 ? duration - 0.5 : 1e9, lastA.t + (cum[li] - cum[lastA.line]) * safeRate);
  }
  // монотонность
  for (let li = 1; li < times.length; li++) if (times[li] < times[li - 1]) times[li] = times[li - 1] + 0.05;

  return {
    lines: plain.map((text, idx) => ({ time: Math.max(0, times[idx]), text, section: isSectionLine(text) })),
    anchors: anchors.length,
    coverage,
  };
}

export async function alignBySpeech(uri: string, plain: string[], duration: number): Promise<LyricLine[] | null> {
  if (!speechAlignAvailable() || plain.length < 4) return null;
  let best: { lines: LyricLine[]; anchors: number; coverage: number } | null = null;
  for (const locale of pickLocales(plain)) {
    try {
      const words = await WoufyFX!.recognizeSpeech(uri, locale);
      const res = alignWords(plain, words, duration);
      if (res && (!best || res.coverage > best.coverage)) best = res;
      if (best && best.coverage >= 0.35) break; // достаточно якорей — второй язык не нужен
    } catch {
      /* язык недоступен / нет разрешения — пробуем следующий */
    }
  }
  return best ? best.lines : null;
}
