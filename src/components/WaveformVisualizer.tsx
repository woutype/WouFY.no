import React, { useEffect, useRef } from 'react';
import { View, StyleSheet, Animated } from 'react-native';
import { useAudioSampleListener } from 'expo-audio';
import type { AudioPlayer } from 'expo-audio';

interface WaveformVisualizerProps {
  player: AudioPlayer | null;
  isPlaying: boolean;
  barCount?: number;
}

export const WaveformVisualizer: React.FC<WaveformVisualizerProps> = ({
  player,
  isPlaying,
  barCount = 28,
}) => {
  // Create an animated value for each bar
  const animatedValues = useRef(
    Array.from({ length: barCount }, () => new Animated.Value(0.15))
  ).current;

  // Smoothing buffers
  const currentLevels = useRef<number[]>(new Array(barCount).fill(0.15)).current;
  const lastSampleTime = useRef(Date.now());

  // Real-time audio PCM sample listener from expo-audio
  if (player) {
    try {
      useAudioSampleListener(player, (sample) => {
        if (!isPlaying || !sample?.channels?.[0]?.frames) return;

        const frames = sample.channels[0].frames;
        if (frames.length === 0) return;

        lastSampleTime.current = Date.now();

        // 1. Compute Bass Energy (Left side)
        // Bass is low-frequency high-amplitude pressure
        let bassSum = 0;
        const bassCount = Math.min(frames.length, 128);
        for (let i = 0; i < bassCount; i++) {
          bassSum += Math.abs(frames[i]);
        }
        const bassLevel = Math.min(1.0, (bassSum / bassCount) * 2.8);

        // 2. Compute Treble Energy (Right side)
        // High frequencies oscillate rapidly -> large sample-to-sample delta
        let trebleDelta = 0;
        for (let i = 1; i < frames.length; i += 2) {
          trebleDelta += Math.abs(frames[i] - frames[i - 1]);
        }
        const trebleLevel = Math.min(1.0, (trebleDelta / (frames.length * 0.5)) * 3.5);

        // 3. Compute Midrange Energy (Center)
        let midSum = 0;
        for (let i = Math.floor(frames.length * 0.25); i < Math.floor(frames.length * 0.75); i += 2) {
          midSum += Math.abs(frames[i]);
        }
        const midLevel = Math.min(1.0, (midSum / (frames.length * 0.25)) * 2.4);

        // Map energy across bars: Left = Bass, Center = Mid, Right = Treble
        for (let i = 0; i < barCount; i++) {
          const ratio = i / barCount;
          let target = 0.15;

          if (ratio < 0.35) {
            // Bass domain (kick, 808, sub)
            const subRatio = ratio / 0.35;
            target = bassLevel * (1.1 - subRatio * 0.3);
          } else if (ratio < 0.7) {
            // Midrange domain (vocals, snares)
            target = midLevel * 0.95;
          } else {
            // Treble domain (hi-hats, cymbals, air)
            const subRatio = (ratio - 0.7) / 0.3;
            target = trebleLevel * (0.8 + subRatio * 0.4);
          }

          // Add slight jitter variance per bar so it feels organic like Dynamic Island
          const variance = 0.85 + 0.3 * Math.sin(i * 1.5 + Date.now() * 0.01);
          target = Math.max(0.12, Math.min(0.98, target * variance));

          // Smooth interpolation
          currentLevels[i] = currentLevels[i] * 0.4 + target * 0.6;
          animatedValues[i].setValue(currentLevels[i]);
        }
      });
    } catch (e) {
      // Audio sampling listener fallback
    }
  }

  // Fallback gentle wave animation when paused or when samples are idle
  useEffect(() => {
    if (!isPlaying) {
      animatedValues.forEach((val, idx) => {
        const restingHeight = 0.15 + 0.18 * Math.sin((idx / barCount) * Math.PI);
        Animated.timing(val, {
          toValue: restingHeight,
          duration: 350,
          useNativeDriver: false,
        }).start();
      });
    }
  }, [isPlaying, barCount, animatedValues]);

  return (
    <View style={styles.container} pointerEvents="none">
      <View style={styles.barsContainer}>
        {animatedValues.map((animVal, i) => {
          const isBass = i < barCount * 0.35;
          const isMid = i >= barCount * 0.35 && i < barCount * 0.7;

          const barColor = isBass ? '#c084fc' : isMid ? '#d8b4fe' : '#e9d5ff';

          return (
            <Animated.View
              key={i}
              style={[
                styles.bar,
                {
                  backgroundColor: barColor,
                  height: animVal.interpolate({
                    inputRange: [0, 1],
                    outputRange: ['0%', '100%'],
                  }),
                  opacity: animVal.interpolate({
                    inputRange: [0.1, 0.9],
                    outputRange: [0.6, 1],
                  }),
                },
              ]}
            />
          );
        })}
      </View>
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    ...StyleSheet.absoluteFill,
    backgroundColor: 'rgba(13, 8, 20, 0.65)',
    borderRadius: 24,
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: 20,
    zIndex: 10,
  },
  barsContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    width: '100%',
    height: 120,
  },
  bar: {
    flex: 1,
    marginHorizontal: 1.5,
    borderRadius: 4,
    shadowColor: '#a855f7',
    shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 0.8,
    shadowRadius: 6,
  },
});
