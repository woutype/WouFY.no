import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Animated, PanResponder, StyleSheet, View } from 'react-native';
import * as Haptics from 'expo-haptics';
import type { AudioPlayer } from 'expo-audio';
import { TrackFile } from '../types';
import { CoverArt } from './ui';
import { WaveformVisualizer } from './WaveformVisualizer';
import { springs } from '../theme';

interface Props {
  queue: TrackFile[];
  index: number;
  size: number;
  isPlaying: boolean;
  showWaveform: boolean;
  player: AudioPlayer | null;
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
 * Обложка-карусель. Палец ведёт обложку 1:1: свайп влево → следующий трек,
 * вправо → предыдущий. Свайп вниз → плавно открывает очередь.
 */
export const ArtworkCarousel: React.FC<Props> = ({
  queue,
  index,
  size,
  isPlaying,
  showWaveform,
  player,
  onNext,
  onPrevious,
  onDragDownGrant,
  onDragDownMove,
  onDragDownRelease,
}) => {
  const n = queue.length;
  const STEP = size + GAP;

  // «виртуальный слот» текущей обложки; растёт при next и убывает при prev — позиции не сбрасываются
  const [prevIndex, setPrevIndex] = useState(index);
  const [slot, setSlot] = useState(0);
  if (index !== prevIndex) {
    let d = index - prevIndex;
    if (n > 2) {
      if (d > n / 2) d -= n;
      else if (d < -n / 2) d += n;
    }
    setPrevIndex(index);
    setSlot(slot + (Math.abs(d) === 1 ? d : 0));
  }

  const pos = useRef(new Animated.Value(0)).current;
  const slotRef = useRef(0);
  slotRef.current = slot;
  const nRef = useRef(n);
  nRef.current = n;
  const base = useRef(0);
  const cbs = useRef({ onNext, onPrevious, onDragDownGrant, onDragDownMove, onDragDownRelease });
  cbs.current = { onNext, onPrevious, onDragDownGrant, onDragDownMove, onDragDownRelease };
  const dragMode = useRef<'none' | 'horizontal' | 'vertical'>('none');

  useEffect(() => {
    Animated.spring(pos, {
      toValue: slot,
      useNativeDriver: true,
      damping: 22,
      stiffness: 230,
      mass: 1,
    }).start();
  }, [slot, pos]);

  // обложка «дышит»: на паузе чуть меньше
  const playScale = useRef(new Animated.Value(isPlaying ? 1 : 0.9)).current;
  useEffect(() => {
    Animated.spring(playScale, { toValue: isPlaying ? 1 : 0.9, useNativeDriver: true, ...springs.sheet }).start();
  }, [isPlaying, playScale]);

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
        pos.stopAnimation((v) => {
          base.current = v;
        });
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
          pos.setValue(base.current - (g.dx * resist) / STEP);
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
            Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
            if (g.dx < 0) cbs.current.onNext();
            else cbs.current.onPrevious();
          } else {
            Animated.spring(pos, { toValue: slotRef.current, useNativeDriver: true, damping: 20, stiffness: 260, mass: 1 }).start();
          }
        }
        dragMode.current = 'none';
      },
      onPanResponderTerminate: (_, g) => {
        if (dragMode.current === 'vertical') {
          cbs.current.onDragDownRelease?.(g.dy, g.vy);
        } else {
          Animated.spring(pos, { toValue: slotRef.current, useNativeDriver: true, damping: 20, stiffness: 260, mass: 1 }).start();
        }
        dragMode.current = 'none';
      },
    })
  ).current;

  const slots = useMemo(() => (n === 0 ? [] : n === 1 ? [slot] : [slot - 1, slot, slot + 1]), [n, slot]);

  return (
    <Animated.View style={{ width: size, height: size, transform: [{ scale: playScale }] }} {...responder.panHandlers}>
      <Animated.View
        style={[StyleSheet.absoluteFill, { transform: [{ translateX: Animated.multiply(pos, -STEP) }] }]}
      >
        {slots.map((s) => {
          const track = queue[mod(index + (s - slot), n)];
          const dist = Animated.subtract(pos, s);
          return (
            <Animated.View
              key={s}
              style={[
                styles.item,
                {
                  width: size,
                  height: size,
                  opacity: dist.interpolate({ inputRange: [-1, 0, 1], outputRange: [0.35, 1, 0.35], extrapolate: 'clamp' }),
                  transform: [
                    { translateX: s * STEP },
                    { scale: dist.interpolate({ inputRange: [-1, 0, 1], outputRange: [0.86, 1, 0.86], extrapolate: 'clamp' }) },
                  ],
                },
              ]}
            >
              <CoverArt uri={track?.artworkUri} size={size} radius={COVER_RADIUS} />
            </Animated.View>
          );
        })}
      </Animated.View>

      {showWaveform && (
        <WaveformVisualizer player={player} isPlaying={isPlaying} size={size} radius={COVER_RADIUS} />
      )}
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
