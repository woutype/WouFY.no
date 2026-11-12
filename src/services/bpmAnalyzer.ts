/**
 * Оценка темпа по PCM-семплам.
 * 1) EnvelopeBuilder копит энергию блоков по 512 фреймов (≈11.6 мс);
 * 2) estimateBpm строит onset-сигнал (рост энергии) и ищет период автокорреляцией
 *    по «гребёнке» из первых 4 гармоник; мягкий приор к 100–150 BPM снижает ошибки в октаву.
 *    Октавные ошибки для склейки не критичны: planMix сам подбирает ×½/×2.
 */
export const HOP = 512;

export class EnvelopeBuilder {
  readonly energies: number[] = [];
  totalFrames = 0;
  private acc = 0;
  private n = 0;

  push(frames: number[]) {
    for (let i = 0; i < frames.length; i++) {
      const v = frames[i];
      this.acc += v * v;
      this.n++;
      if (this.n === HOP) {
        this.energies.push(this.acc / HOP);
        this.acc = 0;
        this.n = 0;
      }
    }
    this.totalFrames += frames.length;
  }
}

export interface BpmEstimate {
  bpm: number;
  confidence: number; // 0..1+
}

export function estimateBpm(energies: number[], sampleRate: number): BpmEstimate | null {
  const dt = HOP / sampleRate;
  const n = energies.length;
  if (n < Math.ceil(8 / dt)) return null; // нужно минимум ~8 секунд

  // onset-сигнал: положительный прирост лог-энергии
  const onset = new Float32Array(n);
  let prev = Math.log(1 + 1000 * energies[0]);
  for (let i = 1; i < n; i++) {
    const cur = Math.log(1 + 1000 * energies[i]);
    onset[i] = Math.max(0, cur - prev);
    prev = cur;
  }
  // убираем среднее
  let mean = 0;
  for (let i = 0; i < n; i++) mean += onset[i];
  mean /= n;
  for (let i = 0; i < n; i++) onset[i] -= mean;

  // автокорреляция для нужных лагов
  const maxLag = Math.ceil(60 / 55 / dt) * 4 + 2;
  const ac = new Float32Array(maxLag + 1);
  for (let lag = 1; lag <= maxLag; lag++) {
    let s = 0;
    for (let i = lag; i < n; i++) s += onset[i] * onset[i - lag];
    ac[lag] = s / (n - lag);
  }
  const acAt = (lag: number) => {
    const l0 = Math.floor(lag);
    const f = lag - l0;
    if (l0 < 1 || l0 + 1 > maxLag) return 0;
    return ac[l0] * (1 - f) + ac[l0 + 1] * f;
  };

  let bestBpm = 0;
  let bestScore = -Infinity;
  let scoreSum = 0;
  let scoreCount = 0;
  for (let bpm = 60; bpm <= 200; bpm += 0.5) {
    const lag = 60 / bpm / dt;
    let s = 0;
    for (let k = 1; k <= 4; k++) s += acAt(lag * k) / k ** 0.5;
    // приор: гауссиан по логарифму вокруг 125 BPM
    const prior = Math.exp(-0.5 * (Math.log(bpm / 125) / 0.45) ** 2);
    const score = s * (0.6 + 0.4 * prior);
    scoreSum += Math.max(0, score);
    scoreCount++;
    if (score > bestScore) {
      bestScore = score;
      bestBpm = bpm;
    }
  }
  if (bestScore <= 0 || bestBpm === 0) return null;

  // уточнение пика параболой
  const step = 0.5;
  const scoreAt = (b: number) => {
    const lag = 60 / b / dt;
    let s = 0;
    for (let k = 1; k <= 4; k++) s += acAt(lag * k) / k ** 0.5;
    return s * (0.6 + 0.4 * Math.exp(-0.5 * (Math.log(b / 125) / 0.45) ** 2));
  };
  const y0 = scoreAt(bestBpm - step);
  const y1 = bestScore;
  const y2 = scoreAt(bestBpm + step);
  const denom = y0 - 2 * y1 + y2;
  const refined = denom !== 0 ? bestBpm + (step * (y0 - y2)) / (2 * denom) : bestBpm;

  const avg = scoreSum / Math.max(1, scoreCount);
  return { bpm: Math.round(refined * 10) / 10, confidence: avg > 0 ? bestScore / avg : 0 };
}
