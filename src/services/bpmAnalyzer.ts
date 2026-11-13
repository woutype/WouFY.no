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
  /** энергия низов (<≈160 Гц): бочка/бас — по ним точнее всего определяется положение бита */
  readonly lows: number[] = [];
  totalFrames = 0;
  private acc = 0;
  private accLow = 0;
  private n = 0;
  private lp1 = 0;
  private lp2 = 0;
  private readonly alpha: number;

  constructor(sampleRate = 44100) {
    this.alpha = 1 - Math.exp((-2 * Math.PI * 160) / sampleRate);
  }

  push(frames: number[]) {
    const a = this.alpha;
    for (let i = 0; i < frames.length; i++) {
      const v = frames[i];
      this.lp1 += a * (v - this.lp1);
      this.lp2 += a * (this.lp1 - this.lp2);
      this.acc += v * v;
      this.accLow += this.lp2 * this.lp2;
      this.n++;
      if (this.n === HOP) {
        this.energies.push(this.acc / HOP);
        this.lows.push(this.accLow / HOP);
        this.acc = 0;
        this.accLow = 0;
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


/* ───────────── Сетка битов (BPM + фаза) ───────────── */

/** Onset-сигнал: положительный прирост лог-энергии, без среднего и с нормировкой по размаху */
export function onsetOf(energies: number[]): Float32Array {
  const n = energies.length;
  const out = new Float32Array(n);
  if (n === 0) return out;
  let prev = Math.log(1 + 1000 * energies[0]);
  for (let i = 1; i < n; i++) {
    const cur = Math.log(1 + 1000 * energies[i]);
    out[i] = Math.max(0, cur - prev);
    prev = cur;
  }
  let mean = 0;
  for (let i = 0; i < n; i++) mean += out[i];
  mean /= n;
  let varSum = 0;
  for (let i = 0; i < n; i++) {
    out[i] -= mean;
    varSum += out[i] * out[i];
  }
  const sd = Math.sqrt(varSum / n) || 1;
  for (let i = 0; i < n; i++) out[i] /= sd;
  return out;
}

/** Смесь двух onset-сигналов: низы (вес 0.7) определяют фазу, полный спектр (0.3) — стабилизирует */
export function mixedOnset(energies: number[], lows: number[]): Float32Array {
  const full = onsetOf(energies);
  const low = onsetOf(lows);
  const out = new Float32Array(full.length);
  for (let i = 0; i < out.length; i++) out[i] = 0.7 * low[i] + 0.3 * full[i];
  return out;
}

export interface GridFit {
  bpm: number;
  /** время первого бита в окне (сек от начала окна) */
  offset: number;
  score: number;
}

/**
 * Подгонка «гребёнки» битов: перебор BPM в [lo, hi] и фазы; побеждает комбинация,
 * у которой средний onset на ударах максимален.
 */
export function fitBeatGrid(onset: Float32Array, dt: number, lo: number, hi: number, step: number): GridFit | null {
  const n = onset.length;
  if (n < 200) return null;
  const sm = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const a = onset[Math.max(0, i - 1)];
    const c = onset[Math.min(n - 1, i + 1)];
    sm[i] = 0.25 * a + 0.5 * onset[i] + 0.25 * c;
  }
  let best: GridFit | null = null;
  for (let bpm = lo; bpm <= hi + 1e-9; bpm += step) {
    const period = 60 / bpm / dt; // в «хопах»
    if (period < 8) continue;
    for (let ph = 0; ph < period; ph += 0.5) {
      let s = 0;
      let cnt = 0;
      for (let t = ph; t < n - 1; t += period) {
        const i = Math.floor(t);
        const f = t - i;
        s += sm[i] * (1 - f) + sm[i + 1] * f;
        cnt++;
      }
      if (cnt < 6) continue;
      const score = s / cnt;
      if (!best || score > best.score) best = { bpm, offset: ph * dt, score };
    }
  }
  return best;
}

/** Параболическое уточнение вокруг лучшего BPM уже сделано шагом перебора; здесь — округление результата */
export const round3 = (v: number) => Math.round(v * 1000) / 1000;
