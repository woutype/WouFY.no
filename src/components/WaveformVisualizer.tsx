import React, { useEffect, useRef } from 'react';
import { Animated, StyleSheet, View } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { sampleBus } from '../services/sampleBus';

export const WAVE_BARS = 28;
const FLOOR = 0.07;
const N = 1024; // окно FFT
const MIN_HZ = 45;
const MAX_HZ = 14000;
const SR = 44100;

/** Радикс-2 FFT на месте */
function fft(re: Float64Array, im: Float64Array) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang);
    const wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1;
      let ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k;
        const b = a + len / 2;
        const tr = re[b] * cr - im[b] * ci;
        const ti = re[b] * ci + im[b] * cr;
        re[b] = re[a] - tr;
        im[b] = im[a] - ti;
        re[a] += tr;
        im[a] += ti;
        const ncr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = ncr;
      }
    }
  }
}

/**
 * Уровни полос спектра (Animated.Value 0…1), обновляются каждый кадр (60 fps).
 * Спектр считается из семплов плеера; сглаживание — по реальному времени кадра (атака быстрая, спад мягкий),
 * поэтому анимация одинаково плавная и на 60, и на 120 Гц и не «ступенчатая» между пакетами семплов.
 * Анализ работает только пока `enabled` — иначе нулевая нагрузка.
 */
export function useWaveLevels(enabled: boolean, isPlaying: boolean): Animated.Value[] {
  const bars = useRef(Array.from({ length: WAVE_BARS }, () => new Animated.Value(FLOOR))).current;
  const target = useRef(new Float32Array(WAVE_BARS).fill(FLOOR)).current;
  const playing = useRef(isPlaying);
  playing.current = isPlaying;
  const lastSample = useRef(0);

  // анализ спектра
  useEffect(() => {
    if (!enabled) return;
    const ring = new Float64Array(N);
    const win = new Float64Array(N);
    for (let i = 0; i < N; i++) win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (N - 1));
    const re = new Float64Array(N);
    const im = new Float64Array(N);
    const edges: number[] = [];
    for (let i = 0; i <= WAVE_BARS; i++) edges.push(MIN_HZ * Math.pow(MAX_HZ / MIN_HZ, i / WAVE_BARS));
    let filled = 0;
    let last = 0;

    const unsub = sampleBus.subscribe((frames) => {
      lastSample.current = Date.now();
      if (!playing.current) return;
      const take = Math.min(frames.length, N);
      ring.copyWithin(0, take);
      for (let i = 0; i < take; i++) ring[N - take + i] = frames[frames.length - take + i];
      filled = Math.min(N, filled + take);
      const now = Date.now();
      if (filled < N || now - last < 10) return;
      last = now;
      for (let i = 0; i < N; i++) {
        re[i] = ring[i] * win[i];
        im[i] = 0;
      }
      fft(re, im);
      for (let b = 0; b < WAVE_BARS; b++) {
        const k0 = Math.max(1, Math.floor((edges[b] * N) / SR));
        const k1 = Math.max(k0 + 1, Math.ceil((edges[b + 1] * N) / SR));
        let peak = 0;
        for (let k = k0; k < k1 && k < N / 2; k++) {
          const mag = Math.sqrt(re[k] * re[k] + im[k] * im[k]) / (N / 4);
          if (mag > peak) peak = mag;
        }
        // наклон +3 дБ/окт: у музыки спектр падает к высоким — без него правая часть почти не двигалась бы
        const tilt = 3 * Math.log2(Math.sqrt(edges[b] * edges[b + 1]) / 200);
        const db = 20 * Math.log10(peak + 1e-6) + tilt;
        target[b] = Math.min(1, Math.max(FLOOR, (db + 62) / 52));
      }
    });
    return unsub;
  }, [enabled, target]);

  // отрисовка: каждый кадр, сглаживание по времени
  useEffect(() => {
    if (!enabled) return;
    let raf = 0;
    let active = true;
    let prevTs = 0;
    const cur = new Float32Array(WAVE_BARS).fill(FLOOR);
    const loop = (ts: number) => {
      if (!active) return;
      raf = requestAnimationFrame(loop);
      const dt = prevTs ? Math.min(0.05, (ts - prevTs) / 1000) : 1 / 60;
      prevTs = ts;
      const atk = 1 - Math.exp(-dt / 0.03);
      const rel = 1 - Math.exp(-dt / 0.14);
      const isPlay = playing.current;
      // если плеер временно не отдаёт семплы (смена трека, загрузка), волна не замирает, а продолжает «дышать»
      const synthetic = isPlay && Date.now() - lastSample.current > 700;
      const tt = ts / 1000;
      for (let b = 0; b < WAVE_BARS; b++) {
        const l = target[Math.max(0, b - 1)];
        const r = target[Math.min(WAVE_BARS - 1, b + 1)];
        let goal = isPlay ? target[b] * 0.62 + (l + r) * 0.19 : FLOOR;
        if (synthetic) {
          const w = 1 - (b / WAVE_BARS) * 0.55; // слева (низкие) выше, справа (высокие) ниже — как у реального спектра
          goal = FLOOR + w * (0.22 + 0.2 * Math.sin(tt * 2.4 + b * 0.55) * Math.sin(tt * 1.3 + b * 0.21)) + 0.12 * w;
        }
        const f = goal > cur[b] ? atk : rel;
        const next = cur[b] + (goal - cur[b]) * f;
        if (Math.abs(next - cur[b]) > 0.0015) {
          cur[b] = next;
          bars[b].setValue(next);
        }
      }
    };
    raf = requestAnimationFrame(loop);
    return () => {
      active = false;
      cancelAnimationFrame(raf);
    };
  }, [enabled, bars, target]);

  // на паузе уровни плавно опускаются
  useEffect(() => {
    if (!isPlaying) for (let i = 0; i < WAVE_BARS; i++) target[i] = FLOOR;
  }, [isPlaying, target]);

  return bars;
}

interface WaveProps {
  bars: Animated.Value[];
  size: number;
  radius: number;
}

/**
 * Оформление волны: обложка лишь слегка затемнена (без размытия), снизу мягкий градиент,
 * тонкие закруглённые полосы растут от нижней линии. Рисуется ВНУТРИ слота обложки — при листании треков едет вместе с ней.
 */
export const WaveOverlay: React.FC<WaveProps> = React.memo(({ bars, size, radius }) => {
  const pad = Math.round(size * 0.07);
  const maxH = size * 0.46;
  const gap = Math.max(2, Math.round(size * 0.008));
  const barW = (size - pad * 2 - gap * (WAVE_BARS - 1)) / WAVE_BARS;
  return (
    <View style={[styles.wrap, { borderRadius: radius }]} pointerEvents="none">
      <View style={[StyleSheet.absoluteFill, { backgroundColor: 'rgba(0,0,0,0.16)' }]} />
      <LinearGradient
        colors={['rgba(0,0,0,0)', 'rgba(0,0,0,0.42)', 'rgba(0,0,0,0.66)']}
        locations={[0, 0.55, 1]}
        style={[styles.bottomShade, { height: size * 0.62 }]}
      />
      <View style={[styles.row, { left: pad, right: pad, bottom: pad, height: maxH }]}>
        {bars.map((v, i) => (
          <Animated.View
            key={i}
            style={{
              width: barW,
              height: maxH,
              marginRight: i === WAVE_BARS - 1 ? 0 : gap,
              borderRadius: barW / 2,
              backgroundColor: 'rgba(255,255,255,0.9)',
              opacity: v.interpolate({ inputRange: [0, 1], outputRange: [0.35, 0.95], extrapolate: 'clamp' }),
              // растём от нижней линии вверх: масштаб вокруг нижней кромки
              transform: [{ translateY: maxH / 2 }, { scaleY: v }, { translateY: -maxH / 2 }],
            }}
          />
        ))}
      </View>
    </View>
  );
});

const styles = StyleSheet.create({
  wrap: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, overflow: 'hidden' },
  bottomShade: { position: 'absolute', left: 0, right: 0, bottom: 0 },
  row: { position: 'absolute', flexDirection: 'row', alignItems: 'flex-end' },
});
