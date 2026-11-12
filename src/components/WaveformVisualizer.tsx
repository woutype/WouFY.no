import React, { useEffect, useRef } from 'react';
import { Animated, StyleSheet, View } from 'react-native';
import type { AudioPlayer } from 'expo-audio';

const BARS = 28;
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
  const bars = useRef(Array.from({ length: BARS }, () => new Animated.Value(0.08))).current;
  const levels = useRef(new Float32Array(BARS).fill(0.08)).current;
  const playing = useRef(isPlaying);
  playing.current = isPlaying;

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
        if (filled < N || now - last < 33) return;
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
          const db = 20 * Math.log10(peak + 1e-6);
          const target = Math.min(1, Math.max(0.06, (db + 62) / 52));
          // быстрая атака, медленное затухание
          levels[b] = target > levels[b] ? levels[b] * 0.35 + target * 0.65 : levels[b] * 0.82 + target * 0.18;
          bars[b].setValue(levels[b]);
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
  }, [player, bars, levels]);

  // при паузе мягко опускаем столбики
  useEffect(() => {
    if (isPlaying) return;
    bars.forEach((v, i) => {
      levels[i] = 0.08;
      Animated.timing(v, { toValue: 0.08, duration: 300, useNativeDriver: true }).start();
    });
  }, [isPlaying, bars, levels]);

  const barH = size * 0.5;
  return (
    <View style={[styles.wrap, { borderRadius: radius }]} pointerEvents="none">
      <View style={[styles.row, { height: barH }]}>
        {bars.map((v, i) => (
          <Animated.View
            key={i}
            style={[styles.bar, { height: barH, transform: [{ scaleY: v }] }]}
          />
        ))}
      </View>
    </View>
  );
};

const styles = StyleSheet.create({
  wrap: {
    ...StyleSheet.absoluteFill,
    backgroundColor: 'rgba(10,10,11,0.62)',
    justifyContent: 'flex-end',
    paddingHorizontal: 22,
    paddingBottom: 26,
    overflow: 'hidden',
  },
  row: { flexDirection: 'row', alignItems: 'flex-end', justifyContent: 'space-between' },
  bar: {
    flex: 1,
    marginHorizontal: 1.5,
    borderRadius: 3,
    backgroundColor: 'rgba(255,255,255,0.92)',
    transformOrigin: 'bottom',
  },
});
