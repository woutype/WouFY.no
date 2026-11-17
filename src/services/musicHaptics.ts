import { Platform } from 'react-native';
import * as Haptics from 'expo-haptics';
import { sampleBus } from './sampleBus';
import { WoufyFX } from '../../modules/woufy-fx';

/**
 * Тактильный отклик под музыку — по мотивам Music Haptics (Apple Music) и вибро-моторов DualSense.
 *
 * Вместо «дёргаться на каждый звук» трек раскладывается на три слоя, у каждого свой «характер» вибрации:
 *
 *  1. БАС / БОЧКА → глубокий гул (непрерывный Core Haptics-канал 0, низкая резкость) + «толчок» на сильных ударах.
 *     Реагирует только на удары, которые ЗАМЕТНО громче среднего уровня трека (относительно медленного AGC),
 *     поэтому тихие и слабые звуки не вызывают вибрации.
 *  2. СНЕЙР / ХЛОПОК (средние частоты) → короткий чёткий щелчок. Если известна сетка битов, предпочтительны доли 2 и 4.
 *  3. ВЕРХА / ВОКАЛ → тонкая «текстура» (канал 1, высокая резкость) — слабая, только при устойчивом звучании, и редкие тики хай-хэта.
 *
 * Общие правила:
 *  • сила отклика следует за динамикой трека (дроп — сильнее, тихий куплет — почти ничего);
 *  • при известной сетке битов удары бочки «притягиваются» к долям (внедолевые — только если очень сильные);
 *  • глобальный лимитер: при плотной музыке пороги автоматически растут (никакого «жужжания» на каждую ноту);
 *  • пока бьёт толчок, гул на 80 мс приглушается, чтобы удар ощущался отчётливо.
 * На Android / без потоковых аудио-семплов автоматически включается ритмичный режим по сетке битов (BPM + фаза) без спама вибрацией.
 */
const HOP = 512;
const SR = 44100;
const HIST = 172; // ≈2 c истории

interface Grid {
  bpm: number;
  phase: number;
}

class Stat {
  private buf = new Float64Array(HIST);
  private head = 0;
  private count = 0;
  private sum = 0;
  private sumSq = 0;

  push(v: number) {
    if (this.count === HIST) {
      const old = this.buf[this.head];
      this.sum -= old;
      this.sumSq -= old * old;
    } else {
      this.count++;
    }
    this.buf[this.head] = v;
    this.sum += v;
    this.sumSq += v * v;
    this.head = (this.head + 1) % HIST;
  }
  get n() {
    return this.count;
  }
  mean() {
    return this.count ? this.sum / this.count : 0;
  }
  sd(m = this.mean()) {
    if (!this.count) return 0;
    return Math.sqrt(Math.max(0, this.sumSq / this.count - m * m));
  }
}

class MusicHaptics {
  private unsub: (() => void) | null = null;
  private enabled = false;
  private native = false;
  private getPos: (() => number) | null = null;
  private getGrid: (() => Grid | undefined) | null = null;

  // фильтры
  private lowA = 1 - Math.exp((-2 * Math.PI * 150) / SR);
  private midLoA = 1 - Math.exp((-2 * Math.PI * 250) / SR);
  private midHiA = 1 - Math.exp((-2 * Math.PI * 3000) / SR);
  private lp1 = 0;
  private lp2 = 0;
  private mLo = 0;
  private mHi = 0;
  private n = 0;
  private accLow = 0;
  private accMid = 0;
  private accHigh = 0;

  // состояние детекторов
  private prevLow = 0;
  private prevMid = 0;
  private prevHigh = 0;
  private fLow = new Stat();
  private fMid = new Stat();
  private fHigh = new Stat();
  private refLow = 1e-3;
  private refMid = 1e-3;
  private refAll = 1e-3;
  private shortAll = 0;
  private longAll = 1e-3;
  private envLow = 0;
  private envMid = 0;
  private fl1 = 0;
  private fl2 = 0;
  private lastKick = 0;
  private lastSnare = 0;
  private lastHat = 0;
  private lastChan = 0;
  private recent: number[] = [];
  private recentHead = 0;
  private lvl0 = 0;
  private lvl1 = 0;
  /** последние отправленные уровни каналов: одинаковые значения в нативный модуль повторно не шлём */
  private sent0 = -1;
  private sent1 = -1;

  // Запасной ритм-движок для Android (где нет потоковых PCM-семплов из expo-audio)
  private beatTimer: ReturnType<typeof setInterval> | null = null;
  private lastBeatIdx = -1;
  private lastBeatPos = -1;
  private lastBeatAt = 0;
  private gotRealSamples = false;

  configure(opts: { getPosition?: () => number; getGrid?: () => Grid | undefined }) {
    if (opts.getPosition) this.getPos = opts.getPosition;
    if (opts.getGrid) this.getGrid = opts.getGrid;
  }

  setEnabled(on: boolean) {
    if (on === this.enabled) return;
    this.enabled = on;
    if (on) {
      this.gotRealSamples = false;
      try {
        this.native = Boolean(WoufyFX && WoufyFX.hapticsSupported());
        if (this.native) WoufyFX!.hapticsStart();
      } catch {
        this.native = false;
      }
      if (Platform.OS !== 'android') {
        this.unsub = sampleBus.subscribe((f) => {
          this.gotRealSamples = true;
          this.feed(f);
        });
      }
      this.startBeatFallback();
    } else {
      this.stopBeatFallback();
      this.unsub?.();
      this.unsub = null;
      this.reset();
      try {
        if (this.native) {
          WoufyFX!.hapticChannel(0, 0, 0.2);
          WoufyFX!.hapticChannel(1, 0, 0.8);
          WoufyFX!.hapticsStop();
        }
      } catch {
        /* ignore */
      }
    }
  }

  /**
   * Ритмичный тактильный отклик по сетке битов (BPM + фаза) для Android и устройств без PCM-потока.
   * Срабатывает строго на сильных долях (1, 3) и лёгким щелчком на 2, 4 с защитой от частого спама.
   */
  private startBeatFallback() {
    this.stopBeatFallback();
    this.lastBeatIdx = -1;
    this.lastBeatPos = -1;
    this.lastBeatAt = 0;
    const startedAt = Date.now();

    this.beatTimer = setInterval(() => {
      if (!this.enabled) return;
      // На iOS если идут реальные аудио-семплы, этот фолбэк не вмешивается
      if (this.gotRealSamples) return;
      if (Platform.OS !== 'android' && Date.now() - startedAt < 500) return;

      const pos = this.getPos?.();
      if (pos === undefined || !isFinite(pos) || pos <= 0.05) return;
      // Если позиция не движется (пауза / буферизация) — молчим
      if (Math.abs(pos - this.lastBeatPos) < 0.005) return;
      this.lastBeatPos = pos;

      const grid = this.getGrid?.();
      const bpm = grid && grid.bpm >= 55 && grid.bpm <= 200 ? grid.bpm : 120;
      const phase = grid ? grid.phase : 0;
      const period = 60 / bpm;

      const beatIdx = Math.floor((pos - phase) / period + 0.06);
      if (beatIdx === this.lastBeatIdx) return;
      this.lastBeatIdx = beatIdx;

      const now = Date.now();
      // Минимум 230 мс между ударами, чтобы на быстрых треках не было сплошного жужжания
      if (now - this.lastBeatAt < 230) return;
      this.lastBeatAt = now;

      const isDownbeat = Math.abs(beatIdx) % 2 === 0;
      if (isDownbeat) {
        if (this.native) {
          try {
            WoufyFX!.hapticThump(0.85);
          } catch {
            Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy).catch(() => {});
          }
        } else {
          Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy).catch(() => {});
        }
      } else {
        if (this.native) {
          try {
            WoufyFX!.hapticTransient(0.55, 0.78);
          } catch {
            Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => {});
          }
        } else {
          Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
        }
      }
    }, 40);
  }

  private stopBeatFallback() {
    if (this.beatTimer) {
      clearInterval(this.beatTimer);
      this.beatTimer = null;
    }
  }

  private reset() {
    this.lp1 = this.lp2 = this.mLo = this.mHi = 0;
    this.n = 0;
    this.accLow = this.accMid = this.accHigh = 0;
    this.prevLow = this.prevMid = this.prevHigh = 0;
    this.fLow = new Stat();
    this.fMid = new Stat();
    this.fHigh = new Stat();
    this.envLow = this.envMid = 0;
    this.fl1 = this.fl2 = 0;
    this.recent = [];
    this.recentHead = 0;
    this.lvl0 = this.lvl1 = 0;
    this.sent0 = this.sent1 = -1;
    this.lastBeatIdx = -1;
    this.lastBeatPos = -1;
  }

  private feed(frames: ArrayLike<number>) {
    for (let i = 0; i < frames.length; i++) {
      const v = frames[i];
      this.lp1 += this.lowA * (v - this.lp1);
      this.lp2 += this.lowA * (this.lp1 - this.lp2);
      this.mLo += this.midLoA * (v - this.mLo);
      this.mHi += this.midHiA * (v - this.mHi);
      const mid = this.mHi - this.mLo;
      const high = v - this.mHi;
      this.accLow += this.lp2 * this.lp2;
      this.accMid += mid * mid;
      this.accHigh += high * high;
      if (++this.n === HOP) {
        this.block(Math.sqrt(this.accLow / HOP), Math.sqrt(this.accMid / HOP), Math.sqrt(this.accHigh / HOP));
        this.accLow = this.accMid = this.accHigh = 0;
        this.n = 0;
      }
    }
  }

  private beatInfo(): { onBeat: boolean; backbeat: boolean; period: number } | null {
    const g = this.getGrid?.();
    const pos = this.getPos?.();
    if (!g || pos === undefined || !isFinite(pos) || g.bpm < 50 || g.bpm > 220) return null;
    const period = 60 / g.bpm;
    const ph = (pos - g.phase) / period;
    const nearest = Math.round(ph);
    const dist = Math.abs(ph - nearest) * period;
    return { onBeat: dist < 0.1, backbeat: Math.abs(nearest) % 2 === 1, period };
  }

  private block(low: number, mid: number, high: number) {
    const now = Date.now();
    const all = low + mid + high;

    // медленные «потолки» уровня (AGC): всё сравнивается с громкостью самого трека
    this.refLow = Math.max(this.refLow * 0.9993, low, 1e-3);
    this.refMid = Math.max(this.refMid * 0.9993, mid, 1e-3);
    this.refAll = Math.max(this.refAll * 0.9993, all, 1e-3);
    this.shortAll += (all - this.shortAll) * 0.02;
    this.longAll += (all - this.longAll) * 0.0015;
    // динамика трека: >1 — громче обычного (дроп/припев), <1 — тише (куплет/бридж)
    const dyn = Math.max(0.35, Math.min(1.5, this.shortAll / Math.max(this.longAll, 1e-4)));
    const relLow = low / this.refLow;
    const relMid = mid / this.refMid;
    const quiet = all / this.refAll < 0.06; // почти тишина — вибрации нет

    // потоки (положительный прирост лог-энергии)
    const lg = (x: number) => Math.log(1 + 400 * x);
    const lLow = lg(low);
    const lMid = lg(mid);
    const lHigh = lg(high);
    const fLow = Math.max(0, lLow - this.prevLow);
    const fMid = Math.max(0, lMid - this.prevMid);
    const fHigh = Math.max(0, lHigh - this.prevHigh);
    this.prevLow = lLow;
    this.prevMid = lMid;
    this.prevHigh = lHigh;
    this.fLow.push(fLow);
    this.fMid.push(fMid);
    this.fHigh.push(fHigh);

    // лимитер плотности: если за последнюю секунду было много событий — пороги растут
    while (this.recentHead < this.recent.length && now - this.recent[this.recentHead] >= 1000) {
      this.recentHead++;
    }
    if (this.recentHead > 0 && this.recentHead >= this.recent.length) {
      this.recent.length = 0;
      this.recentHead = 0;
    } else if (this.recentHead > 32) {
      this.recent.splice(0, this.recentHead);
      this.recentHead = 0;
    }
    const recentCount = this.recent.length - this.recentHead;
    const density = 1 + Math.max(0, recentCount - 5) * 0.18;

    if (this.fLow.n > 25 && !quiet) {
      const bi = this.beatInfo();
      const mL = this.fLow.mean();
      const sL = this.fLow.sd(mL);

      // ── 1. БОЧКА: локальный максимум прироста + заметно выше среднего + достаточно громкая относительно трека ──
      const thrK = (mL + 1.7 * sL + 0.03) * density;
      const isPeak = this.fl1 > thrK && this.fl1 >= this.fl2 && this.fl1 > fLow;
      const minGap = bi ? Math.max(170, bi.period * 1000 * 0.55) : 210;
      if (isPeak && relLow > 0.34 && now - this.lastKick > minGap) {
        const strength = (this.fl1 - mL) / (sL + 1e-6);
        const strong = strength > 3.6;
        const allowed = !bi || bi.onBeat || strong; // при известной сетке внедолевые — только очень сильные
        if (allowed) {
          this.lastKick = now;
          this.recent.push(now);
          this.kick(strength, relLow, dyn);
        }
      }

      // ── 2. СНЕЙР / ХЛОПОК: средние частоты, предпочтительно доли 2 и 4 ──
      const mM = this.fMid.mean();
      const sM = this.fMid.sd(mM);
      const need = (mM + 2.0 * sM + 0.04) * density * (bi && !bi.backbeat ? 1.35 : 1);
      if (fMid > need && relMid > 0.38 && now - this.lastSnare > 300 && now - this.lastKick > 70) {
        this.lastSnare = now;
        this.recent.push(now);
        this.snare(Math.min(1, 0.45 + relMid * 0.4) * Math.min(1.15, 0.7 + dyn * 0.3));
      }

      // ── 3. ХАЙ-ХЭТ: редкие тонкие тики, только когда вокруг не слишком плотно ──
      const mH = this.fHigh.mean();
      const sH = this.fHigh.sd(mH);
      if (recentCount < 4 && fHigh > mH + 2.6 * sH + 0.05 && now - this.lastHat > 190 && now - this.lastKick > 60 && now - this.lastSnare > 90) {
        this.lastHat = now;
        this.hat();
      }
    }
    this.fl2 = this.fl1;
    this.fl1 = fLow;

    // ── непрерывные «моторы»: бас (канал 0) и текстура верхов/вокала (канал 1) ──
    this.envLow += (relLow - this.envLow) * (relLow > this.envLow ? 0.5 : 0.1);
    this.envMid += (relMid - this.envMid) * (relMid > this.envMid ? 0.25 : 0.05);
    if (this.native && now - this.lastChan > 24) {
      this.lastChan = now;
      const duck = now - this.lastKick < 80 ? 0.45 : 1; // под толчком гул тише — удар читается чище
      let l0 = quiet ? 0 : Math.pow(Math.max(0, this.envLow - 0.3) / 0.7, 1.35) * 0.62 * Math.min(1.2, dyn) * duck;
      let l1 = quiet ? 0 : Math.max(0, this.envMid - 0.42) * 0.38 * Math.min(1.1, dyn);
      this.lvl0 += (l0 - this.lvl0) * 0.55;
      this.lvl1 += (l1 - this.lvl1) * 0.35;
      try {
        if (Math.abs(this.lvl0 - this.sent0) >= 0.02 || (this.lvl0 < 0.03) !== (this.sent0 < 0.03)) {
          this.sent0 = this.lvl0;
          WoufyFX!.hapticChannel(0, this.lvl0, 0.08 + 0.22 * (1 - Math.min(1, this.envLow)));
        }
        if (Math.abs(this.lvl1 - this.sent1) >= 0.02 || (this.lvl1 < 0.03) !== (this.sent1 < 0.03)) {
          this.sent1 = this.lvl1;
          WoufyFX!.hapticChannel(1, this.lvl1, 0.75);
        }
      } catch {
        /* ignore */
      }
    }
  }

  private kick(strength: number, rel: number, dyn: number) {
    const power = Math.max(0, Math.min(1, (0.45 + rel * 0.55) * Math.min(1.2, 0.65 + dyn * 0.35)));
    if (this.native) {
      try {
        if (strength > 3.6 && rel > 0.6) WoufyFX!.hapticThump(Math.min(1, 0.6 + power * 0.4)); // мощный толчок + вибрация
        else if (strength > 2.6) WoufyFX!.hapticTransient(0.55 + power * 0.4, 0.28);
        else WoufyFX!.hapticTransient(0.4 + power * 0.4, 0.42);
      } catch {
        /* ignore */
      }
      return;
    }
    const now = Date.now();
    if (strength > 4.2 && rel > 0.7) Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning).catch(() => {});
    else if (strength > 3) Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy).catch(() => {});
    else Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => {});
    void now;
  }

  private snare(power: number) {
    if (this.native) {
      try {
        WoufyFX!.hapticTransient(0.45 + power * 0.4, 0.78);
      } catch {
        /* ignore */
      }
    } else {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Rigid).catch(() => {});
    }
  }

  private hat() {
    if (this.native) {
      try {
        WoufyFX!.hapticTransient(0.28, 0.96);
      } catch {
        /* ignore */
      }
    }
  }
}

export const musicHaptics = new MusicHaptics();
