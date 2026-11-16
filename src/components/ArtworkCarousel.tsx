import React, { useEffect, useMemo, useRef } from 'react';
import { Animated, PanResponder, StyleSheet, View } from 'react-native';
import * as Haptics from 'expo-haptics';
import { TrackFile } from '../types';
import { CoverArt } from './ui';
import { WaveOverlay, useWaveLevels } from './WaveformVisualizer';
import { springs } from '../theme';

interface Props {
  queue: TrackFile[];
  index: number;
  size: number;
  isPlaying: boolean;
  showWaveform: boolean;
  onNext: () => void;
  onPrevious: () => void;
  onDragDownGrant?: () => void;
  onDragDownMove?: (dy: number) => void;
  onDragDownRelease?: (dy: number, vy: number) => void;
}

const GAP = 20;
const COVER_RADIUS = 28;
const mod = (a: number, n: number) => ((a % n) + n) % n;

/**
 * Обложка-карусель с идеальной синхронизацией:
 * - Палец ведёт обложку 1:1 по горизонтали: свайп влево → следующий трек, вправо → предыдущий.
 * - Свайп вниз → плавно открывает очередь.
 * - В покое текущая обложка ВСЕГДА на 100% видима (opacity: 1), а соседние скрыты.
 * - Отсутствие динамических нод Animated внутри render исключает сбои нативного драйвера iOS.
 */
export const ArtworkCarousel: React.FC<Props> = ({
  queue,
  index,
  size,
  isPlaying,
  showWaveform,
  onNext,
  onPrevious,
  onDragDownGrant,
  onDragDownMove,
  onDragDownRelease,
}) => {
  const n = queue.length;
  const STEP = size + GAP;
  const bars = useWaveLevels(showWaveform, isPlaying);

  const panX = useRef(new Animated.Value(0)).current;
  const nRef = useRef(n);
  nRef.current = n;
  const cbs = useRef({ onNext, onPrevious, onDragDownGrant, onDragDownMove, onDragDownRelease });
  cbs.current = { onNext, onPrevious, onDragDownGrant, onDragDownMove, onDragDownRelease };
  const dragMode = useRef<'none' | 'horizontal' | 'vertical'>('none');
  const isAnimating = useRef(false);

  useEffect(() => {
    panX.setValue(0);
    isAnimating.current = false;
  }, [index, panX]);

  // Обложка «дышит»: на паузе чуть меньше
  const playScale = useRef(new Animated.Value(isPlaying ? 1 : 0.9)).current;
  useEffect(() => {
    Animated.spring(playScale, { toValue: isPlaying ? 1 : 0.9, useNativeDriver: true, ...springs.sheet }).start();
  }, [isPlaying, playScale]);

  // Стабильные интерполяции для 3 слотов (вычисляются 1 раз)
  const centerOpacity = useMemo(
    () =>
      panX.interpolate({
        inputRange: [-STEP, -STEP * 0.55, 0, STEP * 0.55, STEP],
        outputRange: [0, 0.5, 1, 0.5, 0],
        extrapolate: 'clamp',
      }),
    [panX, STEP]
  );

  const centerScale = useMemo(
    () =>
      panX.interpolate({
        inputRange: [-STEP, 0, STEP],
        outputRange: [0.88, 1, 0.88],
        extrapolate: 'clamp',
      }),
    [panX, STEP]
  );

  const leftTranslateX = useMemo(
    () =>
      panX.interpolate({
        inputRange: [-STEP, 0, STEP],
        outputRange: [-2 * STEP, -STEP, 0],
      }),
    [panX, STEP]
  );

  const leftOpacity = useMemo(
    () =>
      panX.interpolate({
        inputRange: [0, STEP * 0.45, STEP],
        outputRange: [0, 0.5, 1],
        extrapolate: 'clamp',
      }),
    [panX, STEP]
  );

  const leftScale = useMemo(
    () =>
      panX.interpolate({
        inputRange: [0, STEP],
        outputRange: [0.88, 1],
        extrapolate: 'clamp',
      }),
    [panX, STEP]
  );

  const rightTranslateX = useMemo(
    () =>
      panX.interpolate({
        inputRange: [-STEP, 0, STEP],
        outputRange: [0, STEP, 2 * STEP],
      }),
    [panX, STEP]
  );

  const rightOpacity = useMemo(
    () =>
      panX.interpolate({
        inputRange: [-STEP, -STEP * 0.45, 0],
        outputRange: [1, 0.5, 0],
        extrapolate: 'clamp',
      }),
    [panX, STEP]
  );

  const rightScale = useMemo(
    () =>
      panX.interpolate({
        inputRange: [-STEP, 0],
        outputRange: [1, 0.88],
        extrapolate: 'clamp',
      }),
    [panX, STEP]
  );

  const responder = useRef(
    PanResponder.create({
      onMoveShouldSetPanResponder: (_, g) => {
        const isH = Math.abs(g.dx) > 8 && Math.abs(g.dx) > Math.abs(g.dy) * 1.2;
        const isV = g.dy > 8 && g.dy > Math.abs(g.dx) * 1.2;
        return isH || isV;
      },
      onPanResponderTerminationRequest: () => false,
      onPanResponderGrant: () => {
        dragMode.current = 'none';
        isAnimating.current = false;
        panX.stopAnimation();
      },
      onPanResponderMove: (_, g) => {
        if (dragMode.current === 'none') {
          if (Math.abs(g.dx) > Math.abs(g.dy) && Math.abs(g.dx) > 6) {
            dragMode.current = 'horizontal';
          } else if (g.dy > 6 && g.dy > Math.abs(g.dx)) {
            dragMode.current = 'vertical';
            cbs.current.onDragDownGrant?.();
          }
        }
        if (dragMode.current === 'horizontal') {
          const resist = nRef.current <= 1 ? 0.25 : 1;
          panX.setValue(g.dx * resist);
        } else if (dragMode.current === 'vertical') {
          cbs.current.onDragDownMove?.(g.dy);
        }
      },
      onPanResponderRelease: (_, g) => {
        if (dragMode.current === 'vertical') {
          cbs.current.onDragDownRelease?.(g.dy, g.vy);
        } else if (dragMode.current === 'horizontal') {
          const commit = Math.abs(g.dx) > size * 0.2 || Math.abs(g.vx) > 0.45;
          if (commit && nRef.current > 1) {
            const isNext = Math.abs(g.dx) > 15 ? g.dx < 0 : g.vx < 0;
            Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
            isAnimating.current = true;
            Animated.spring(panX, {
              toValue: isNext ? -STEP : STEP,
              useNativeDriver: true,
              damping: 22,
              stiffness: 280,
              mass: 0.9,
            }).start(({ finished }) => {
              if (finished) {
                if (isNext) cbs.current.onNext();
                else cbs.current.onPrevious();
              }
              panX.setValue(0);
              isAnimating.current = false;
            });
          } else {
            Animated.spring(panX, {
              toValue: 0,
              useNativeDriver: true,
              damping: 22,
              stiffness: 260,
              mass: 1,
            }).start();
          }
        }
        dragMode.current = 'none';
      },
      onPanResponderTerminate: (_, g) => {
        if (dragMode.current === 'vertical') {
          cbs.current.onDragDownRelease?.(g.dy, g.vy);
        } else {
          Animated.spring(panX, {
            toValue: 0,
            useNativeDriver: true,
            damping: 22,
            stiffness: 260,
            mass: 1,
          }).start();
        }
        dragMode.current = 'none';
      },
    })
  ).current;

  if (n === 0) return <View style={{ width: size, height: size }} />;

  const currentTrack = queue[index >= 0 && index < n ? index : 0];
  const prevTrack = n > 1 ? queue[mod(index - 1, n)] : undefined;
  const nextTrack = n > 1 ? queue[mod(index + 1, n)] : undefined;

  return (
    <Animated.View style={{ width: size, height: size, transform: [{ scale: playScale }] }} {...responder.panHandlers}>
      {/* Предыдущая обложка (слева) */}
      {prevTrack && (
        <Animated.View
          pointerEvents="none"
          style={[
            styles.item,
            {
              width: size,
              height: size,
              opacity: leftOpacity,
              transform: [{ translateX: leftTranslateX }, { scale: leftScale }],
            },
          ]}
        >
          <CoverArt uri={prevTrack.artworkUri} size={size} radius={COVER_RADIUS} />
        </Animated.View>
      )}

      {/* Следующая обложка (справа) */}
      {nextTrack && (
        <Animated.View
          pointerEvents="none"
          style={[
            styles.item,
            {
              width: size,
              height: size,
              opacity: rightOpacity,
              transform: [{ translateX: rightTranslateX }, { scale: rightScale }],
            },
          ]}
        >
          <CoverArt uri={nextTrack.artworkUri} size={size} radius={COVER_RADIUS} />
        </Animated.View>
      )}

      {/* Центральная активная обложка */}
      <Animated.View
        style={[
          styles.item,
          {
            width: size,
            height: size,
            opacity: centerOpacity,
            transform: [{ translateX: panX }, { scale: centerScale }],
          },
        ]}
      >
        <CoverArt uri={currentTrack?.artworkUri} size={size} radius={COVER_RADIUS} />
        {showWaveform && <WaveOverlay bars={bars} size={size} radius={COVER_RADIUS} />}
      </Animated.View>
    </Animated.View>
  );
};

const styles = StyleSheet.create({
  item: {
    position: 'absolute',
    left: 0,
    top: 0,
    borderRadius: COVER_RADIUS,
    backgroundColor: '#161618',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 18 },
    shadowOpacity: 0.4,
    shadowRadius: 26,
  },
});
