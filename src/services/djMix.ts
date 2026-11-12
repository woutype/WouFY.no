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
  const base: MixPlan = {
    tempo: false,
    targetBpm: bpmA ?? 0,
    bpmA: bpmA ?? 0,
    factorB: 1,
    triggerRemaining: duration,
  };
  if (!tempoEnabled || !bpmA || !bpmB || bpmA < 30 || bpmB < 30) return base;

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
  // A проходит последние X «медиа-секунд» со средней скоростью (1 + T/A)/2:
  // подбираем момент старта так, чтобы A закончился ровно в конце склейки.
  const avgRateA = (1 + target / bpmA) / 2;
  return {
    tempo: true,
    targetBpm: target,
    bpmA,
    factorB: best,
    triggerRemaining: duration * avgRateA,
  };
}

const smooth = (p: number) => p * p * (3 - 2 * p);
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

export function ratesAt(plan: MixPlan, p: number): { rateA: number; rateB: number } {
  if (!plan.tempo) return { rateA: 1, rateB: 1 };
  const mixBpm = plan.bpmA + (plan.targetBpm - plan.bpmA) * smooth(clamp(p, 0, 1));
  return {
    rateA: clamp(mixBpm / plan.bpmA, 0.5, 2),
    rateB: clamp(mixBpm / plan.targetBpm, 0.5, 2),
  };
}

export function volumesAt(p: number, smoothFade: boolean): { volA: number; volB: number } {
  const q = clamp(p, 0, 1);
  if (!smoothFade) return { volA: q < 0.5 ? 1 : 0, volB: q < 0.5 ? 0 : 1 };
  // равномерная по мощности кривая — суммарная громкость не «проваливается» в середине
  return { volA: Math.cos((q * Math.PI) / 2), volB: Math.sin((q * Math.PI) / 2) };
}
