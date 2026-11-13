/**
 * Математика DJ-склейки. Чистые функции без зависимостей от плеера.
 *
 * Модель:
 *  • за X секунд до конца трека A стартует трек B с громкостью 0;
 *  • громкость A падает 100%→0, B растёт 0→100% — одновременно, за всё время склейки;
 *  • темп: общий «BPM микса» линейно идёт от BPM трека A (например 100) к BPM трека B (115).
 *    A ускоряется до 115, а B стартует с темпом A (100) и сходится к своему родному 115.
 *    В каждый момент оба играют в одном темпе — удары совпадают;
 *  • биты A и B накладываются друг на друга: трек B стартует с собственного бита (по сетке битов),
 *    в момент, когда у A тоже бит (по возможности — начало такта), а во время склейки фазу
 *    постоянно подстраивает «петля захвата» (PLL) в движке.
 */

export interface BeatGrid {
  /** темп сетки, уд/мин */
  bpm: number;
  /** время любого бита в секундах от начала файла (по модулю периода) */
  phase: number;
}

export interface TrackTempo {
  bpm?: number;
  grid?: BeatGrid;
}

export interface MixPlan {
  /** Подгон темпа возможен (известны оба BPM) */
  tempo: boolean;
  /** BPM трека A */
  bpmA: number;
  /** целевой BPM микса (родной BPM трека B, при необходимости ×½ / ×2 — ближайший к A) */
  targetBpm: number;
  /** множитель, на который пришлось умножить BPM трека B (0.5 / 1 / 2) */
  factorB: number;
  /** средняя скорость A за время склейки (нужна, чтобы A закончился ровно в конце перехода) */
  avgRateA: number;
  /** известны сетки обоих треков → можно накладывать бит на бит */
  beatSync: boolean;
  periodA: number;
  phaseA: number;
  periodB: number;
  phaseB: number;
  /** позиция в треке B (сек), с которой он стартует — на своём бите */
  bStartPos: number;
}

const MAX_TEMPO_SHIFT = 1.35; // дальше «подгонять» бессмысленно: питч уезжает слишком сильно

export function planMix(a: TrackTempo, b: TrackTempo, tempoEnabled: boolean): MixPlan {
  const base: MixPlan = {
    tempo: false,
    bpmA: a.bpm ?? 120,
    targetBpm: b.bpm ?? 120,
    factorB: 1,
    avgRateA: 1,
    beatSync: false,
    periodA: 0.5,
    phaseA: 0,
    periodB: 0.5,
    phaseB: 0,
    bStartPos: 0,
  };
  if (!tempoEnabled) return base;

  const bpmA = a.grid?.bpm ?? a.bpm;
  const bpmB = b.grid?.bpm ?? b.bpm;
  if (!bpmA || !bpmB || bpmA < 40 || bpmB < 40) return base;

  let best = 1;
  let bestErr = Infinity;
  for (const k of [0.5, 1, 2]) {
    const err = Math.abs(Math.log((bpmB * k) / bpmA));
    if (err < bestErr) {
      bestErr = err;
      best = k;
    }
  }
  const target = bpmB * best;
  const ratio = target / bpmA;
  if (ratio > MAX_TEMPO_SHIFT || ratio < 1 / MAX_TEMPO_SHIFT) return base;

  const plan: MixPlan = {
    ...base,
    tempo: true,
    bpmA,
    targetBpm: target,
    factorB: best,
    avgRateA: (1 + ratio) / 2,
  };

  if (a.grid && b.grid) {
    plan.beatSync = true;
    plan.periodA = 60 / a.grid.bpm;
    plan.phaseA = mod(a.grid.phase, plan.periodA);
    plan.periodB = 60 / target;
    plan.phaseB = mod(b.grid.phase, plan.periodB);
    plan.bStartPos = plan.phaseB;
  }
  return plan;
}

const mod = (v: number, n: number) => ((v % n) + n) % n;
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** Скорости воспроизведения A и B в момент прогресса q (0…1) */
export function ratesAt(plan: MixPlan, q: number): { rateA: number; rateB: number } {
  if (!plan.tempo) return { rateA: 1, rateB: 1 };
  const p = clamp(q, 0, 1);
  const mixBpm = plan.bpmA + (plan.targetBpm - plan.bpmA) * p;
  return {
    rateA: clamp(mixBpm / plan.bpmA, 0.5, 2),
    rateB: clamp(mixBpm / plan.targetBpm, 0.5, 2),
  };
}

/**
 * Громкости A и B. Всегда A: 1→0 и B: 0→1 на всю длительность склейки.
 * smooth=true — мягкая S-кривая + equal-power (без провала громкости посередине),
 * smooth=false — линейный фейдер.
 */
export function volumesAt(p: number, smooth: boolean): { volA: number; volB: number } {
  const q = clamp(p, 0, 1);
  if (!smooth) return { volA: 1 - q, volB: q };
  const s = q * q * (3 - 2 * q);
  return { volA: Math.cos((s * Math.PI) / 2), volB: Math.sin((s * Math.PI) / 2) };
}

/** Дробная часть «номера бита» в момент t: 0 — ровно на бите, 0.5 — посередине между битами */
export function beatPhase(t: number, phase: number, period: number): number {
  return mod((t - phase) / period, 1);
}

/** Ошибка фазы, приведённая к (−0.5, 0.5] */
export function wrapHalf(x: number): number {
  return x - Math.round(x);
}
