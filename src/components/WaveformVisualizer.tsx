import React, { useEffect, useRef } from 'react';
import { Animated, StyleSheet, View } from 'react-native';
import { BlurView } from 'expo-blur';
import type { AudioPlayer } from 'expo-audio';

const BARS = 36;
const FLOOR = 0.06;
const FRAME_MS = 33; // ~30 кадров/с — достаточно плавно и вдвое легче для JS
const N = 1024; // размер окна FFT
const MIN_HZ = 50;
const MAX_HZ = 12000;

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

interface Props {
  player: AudioPlayer | null;
  isPlaying: boolean;
  size: number;
  radius: number;
}

/** Настоящий спектр (FFT) поверх обложки. Семплирование включается только пока визуализатор на экране. */
export const WaveformVisualizer: React.FC<Props> = ({ player, isPlaying, size, radius }) => {
  const bars = useRef(Array.from({ length: BARS }, () => new Animated.Value(FLOOR))).current;
  const targetLevels = useRef(new Float32Array(BARS).fill(FLOOR)).current;
  const currentLevels = useRef(new Float32Array(BARS).fill(FLOOR)).current;
  const playing = useRef(isPlaying);
  playing.current = isPlaying;

  // Рендер-луп: быстрая атака на ударах, плавный спад; соседние полосы слегка сглаживаются между собой
  useEffect(() => {
    let rafId: number;
    let active = true;
    let lastFrame = 0;
    const tmp = new Float32Array(BARS);

    const loop = (ts: number) => {
      if (!active) return;
      rafId = requestAnimationFrame(loop);
      if (ts - lastFrame < FRAME_MS) return;
      lastFrame = ts;
      const isPlay = playing.current;
      for (let b = 0; b < BARS; b++) {
        const l = targetLevels[Math.max(0, b - 1)];
        const r = targetLevels[Math.min(BARS - 1, b + 1)];
        tmp[b] = isPlay ? targetLevels[b] * 0.6 + (l + r) * 0.2 : FLOOR;
      }
      for (let b = 0; b < BARS; b++) {
        const cur = currentLevels[b];
        const target = tmp[b];
        const factor = target > cur ? 0.5 : 0.16;
        const next = cur + (target - cur) * factor;
        if (Math.abs(next - cur) > 0.002) {
          currentLevels[b] = next;
          bars[b].setValue(next);
        }
      }
    };

    rafId = requestAnimationFrame(loop);
    return () => {
      active = false;
      cancelAnimationFrame(rafId);
    };
  }, [bars, currentLevels, targetLevels]);

  useEffect(() => {
    if (!player) return;
    let sub: { remove: () => void } | null = null;
    const ring = new Float64Array(N);
    const win = new Float64Array(N);
    for (let i = 0; i < N; i++) win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (N - 1)); // окно Хэннинга
    const re = new Float64Array(N);
    const im = new Float64Array(N);
    let filled = 0;
    let last = 0;
    const sr = 44100;
    const edges: number[] = [];
    for (let i = 0; i <= BARS; i++) edges.push(MIN_HZ * Math.pow(MAX_HZ / MIN_HZ, i / BARS));

    try {
      if (!player.isAudioSamplingSupported) return;
      player.setAudioSamplingEnabled(true);
      sub = player.addListener('audioSampleUpdate', (s) => {
        const frames = s.channels?.[0]?.frames;
        if (!frames || frames.length === 0 || !playing.current) return;
        // сдвигаем кольцо и дописываем новые фреймы
        const take = Math.min(frames.length, N);
        ring.copyWithin(0, take);
        for (let i = 0; i < take; i++) ring[N - take + i] = frames[frames.length - take + i];
        filled = Math.min(N, filled + take);
        const now = Date.now();
        if (filled < N || now - last < 16) return;
        last = now;

        for (let i = 0; i < N; i++) {
          re[i] = ring[i] * win[i];
          im[i] = 0;
        }
        fft(re, im);

        for (let b = 0; b < BARS; b++) {
          const k0 = Math.max(1, Math.floor((edges[b] * N) / sr));
          const k1 = Math.max(k0 + 1, Math.ceil((edges[b + 1] * N) / sr));
          let peak = 0;
          for (let k = k0; k < k1 && k < N / 2; k++) {
            const mag = Math.sqrt(re[k] * re[k] + im[k] * im[k]) / (N / 4);
            if (mag > peak) peak = mag;
          }
          // наклон +3 дБ/окт: у музыки спектр падает к высоким — без него правая часть почти не двигалась бы
          const tilt = 3 * Math.log2(Math.sqrt(edges[b] * edges[b + 1]) / 200);
          const db = 20 * Math.log10(peak + 1e-6) + tilt;
          const target = Math.min(1, Math.max(FLOOR, (db + 60) / 50));
          targetLevels[b] = target;
        }
      });
    } catch {
      /* семплирование недоступно на этой платформе */
    }
    return () => {
      sub?.remove();
      try {
        player.setAudioSamplingEnabled(false);
      } catch {
        /* ignore */
      }
    };
  }, [player, targetLevels]);

  // при паузе сбрасываем целевые уровни
  useEffect(() => {
    if (isPlaying) return;
    for (let i = 0; i < BARS; i++) targetLevels[i] = FLOOR;
  }, [isPlaying, targetLevels]);

  const barH = size * 0.5;
  return (
    <View style={[styles.wrap, { borderRadius: radius }]} pointerEvents="none">
      {/* матовая подложка: лёгкое размытие обложки + тёмная полупрозрачная заливка, без бликов */}
      <BlurView intensity={28} tint="dark" style={StyleSheet.absoluteFill} />
      <View style={[StyleSheet.absoluteFill, { backgroundColor: 'rgba(10,10,11,0.5)' }]} />
      <View style={[styles.row, { height: barH }]}>
        {bars.map((v, i) => (
          <Animated.View
            key={i}
            style={[
              styles.bar,
              {
                height: barH,
                // полоса растёт от центра вверх и вниз; громче — ярче
                opacity: v.interpolate({ inputRange: [0, 1], outputRange: [0.35, 1], extrapolate: 'clamp' }),
                transform: [{ scaleY: v }],
              },
            ]}
          />
        ))}
      </View>
    </View>
  );
};

const styles = StyleSheet.create({
  wrap: {
    ...StyleSheet.absoluteFill,
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: 20,
    overflow: 'hidden',
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    width: '100%',
  },
  bar: {
    flex: 1,
    marginHorizontal: 1,
    borderRadius: 999,
    backgroundColor: '#FFFFFF',
  },
});
