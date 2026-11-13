/**
 * Математика DJ-склейки. Чистые функции без зависимостей от плеера.
 *
 * Модель (по ТЗ):
 *  • за X секунд до конца трека A стартует трек B с громкостью 0;
 *  • громкость A плавно падает 100%→0, B растёт 0→100% — одновременно;
 *  • темп: общий «BPM микса» плавно идёт от BPM трека A к целевому T
 *    (BPM трека B, при необходимости ×½ или ×2 — берём вариант, ближайший к A);
 *    A разгоняется/замедляется до T, B стартует с темпом A и сходится к своему родному.
 */
export interface MixPlan {
  /** Подгон темпа возможен (известны оба BPM) */
  tempo: boolean;
  /** целевой BPM микса (T) */
  targetBpm: number;
  bpmA: number;
  /** множитель, на который пришлось умножить BPM трека B (0.5 / 1 / 2) */
  factorB: number;
  /** сколько секунд (в «медиа-времени» трека A) до конца начинается склейка */
  triggerRemaining: number;
}

export function planMix(
  bpmA: number | undefined,
  bpmB: number | undefined,
  duration: number,
  tempoEnabled: boolean
): MixPlan {
  const dur = Math.max(1, duration);
  const base: MixPlan = {
    tempo: false,
    targetBpm: bpmA ?? 120,
    bpmA: bpmA ?? 120,
    factorB: 1,
    triggerRemaining: dur,
  };
  if (!tempoEnabled) return base;

  const a = bpmA && bpmA >= 30 ? bpmA : 120;
  const b = bpmB && bpmB >= 30 ? bpmB : (bpmA ? Math.round(bpmA * 1.08) : 128);

  let best = 1;
  let bestErr = Infinity;
  for (const k of [0.5, 1, 2]) {
    const err = Math.abs(Math.log((b * k) / a));
    if (err < bestErr) {
      bestErr = err;
      best = k;
    }
  }
  const target = b * best;
  const avgRateA = (1 + target / a) / 2;
  return {
    tempo: true,
    targetBpm: target,
    bpmA: a,
    factorB: best,
    triggerRemaining: Math.max(1, dur * avgRateA),
  };
}

const smooth = (p: number) => p * p * (3 - 2 * p);
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

export function ratesAt(plan: MixPlan, p: number): { rateA: number; rateB: number } {
  if (!plan.tempo) return { rateA: 1, rateB: 1 };
  const q = clamp(p, 0, 1);
  const mixBpm = plan.bpmA + (plan.targetBpm - plan.bpmA) * q;
  return {
    rateA: clamp(mixBpm / plan.bpmA, 0.5, 2),
    rateB: clamp(mixBpm / plan.targetBpm, 0.5, 2),
  };
}

export function volumesAt(p: number, smoothFade: boolean): { volA: number; volB: number } {
  const q = clamp(p, 0, 1);
  if (!smoothFade) {
    // Линейный кроссфейд на всю длительность
    return { volA: 1 - q, volB: q };
  }
  // Плавная S-кривая (smoothstep) на всю длительность: мягкий старт, ровно 50% на середине и мягкий финиш
  const s = q * q * (3 - 2 * q);
  return { volA: 1 - s, volB: s };
}

