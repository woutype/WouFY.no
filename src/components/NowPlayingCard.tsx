import React, { useEffect, useRef, useState } from 'react';
import { Animated, Easing, PanResponder, Pressable, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { AudioEngine, EngineState } from '../services/audioEngine';
import { Metrics } from '../layout';
import { colors, radius, type } from '../theme';
import { AmbientBackground, CoverArt, Glass, IconButton, PressableScale } from './ui';
import { ArtworkCarousel } from './ArtworkCarousel';
import { PlayerControls } from './PlayerControls';
import { usePosition } from '../hooks/useAudioController';

interface Props {
  engine: AudioEngine;
  state: EngineState;
  m: Metrics;
  /** 0 — свёрнут в мини-плеер, 1 — полноэкранный плеер */
  progress: Animated.Value;
  expanded: boolean;
  /** завершить жест: куда «долетает» карточка */
  onSettle: (target: 0 | 1) => void;
  onOpenSheet: (mode: 'queue' | 'lyrics') => void;
  onOpenSettings: () => void;
  onArtistPress: (artist: string) => void;
  onEditBpm: () => void;
  bpm?: number;
  bpmSource?: 'manual' | 'tag' | 'auto';
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

const MiniProgress: React.FC<{ engine: AudioEngine; duration: number }> = ({ engine, duration }) => {
  const pos = usePosition(engine, 250);
  const ratio = duration > 0 ? clamp(pos / duration, 0, 1) : 0;
  return (
    <View style={styles.miniProgressTrack}>
      <View style={[styles.miniProgressFill, { width: `${ratio * 100}%` }]} />
    </View>
  );
};

/** Вращающаяся обложка как виниловая пластинка */
const SpinningArtwork: React.FC<{ uri?: string; size: number; isPlaying: boolean }> = ({ uri, size, isPlaying }) => {
  const rot = useRef(new Animated.Value(0)).current;
  const currentAngle = useRef(0);

  useEffect(() => {
    const id = rot.addListener(({ value }) => {
      currentAngle.current = value;
    });
    return () => rot.removeListener(id);
  }, [rot]);

  useEffect(() => {
    let anim: Animated.CompositeAnimation | null = null;
    let active = true;

    if (isPlaying) {
      const step = () => {
        if (!active) return;
        const start = currentAngle.current % 1;
        rot.setValue(start);
        currentAngle.current = start;
        const remaining = 1 - start;
        anim = Animated.timing(rot, {
          toValue: 1,
          duration: Math.max(100, remaining * 8000),
          easing: Easing.linear,
          useNativeDriver: true,
        });
        anim.start(({ finished }) => {
          if (finished && active) {
            currentAngle.current = 0;
            rot.setValue(0);
            step();
          }
        });
      };
      step();
    } else {
      rot.stopAnimation((val) => {
        currentAngle.current = val;
      });
    }

    return () => {
      active = false;
      rot.stopAnimation();
    };
  }, [isPlaying, rot]);

  const spin = rot.interpolate({ inputRange: [0, 1], outputRange: ['0deg', '360deg'] });

  return (
    <Animated.View style={{ width: size, height: size, borderRadius: size / 2, overflow: 'hidden', transform: [{ rotate: spin }] }}>
      <CoverArt uri={uri} size={size} radius={size / 2} />
    </Animated.View>
  );
};


/**
 * Одна карточка — два состояния. Прогресс `progress` (0…1) управляет всем:
 * верх карточки едет за пальцем, капсула мини-плеера растворяется в полный экран,
 * миниатюра обложки вырастает в большую обложку (shared-element morph).
 */
export const NowPlayingCard: React.FC<Props> = ({
  engine,
  state,
  m,
  progress: e,
  expanded,
  onSettle,
  onOpenSheet,
  onOpenSettings,
  onArtistPress,
  onEditBpm,
  bpm,
  bpmSource,
}) => {
  const track = state.queue[state.index];
  const [showWave, setShowWave] = useState(false);
  const range = m.collapsedTop;

  // актуальное значение прогресса (нужно, чтобы подхватить жест посреди анимации)
  const lastE = useRef(1);
  const base = useRef(1);
  useEffect(() => {
    const id = e.addListener(({ value }) => {
      lastE.current = value;
    });
    return () => e.removeListener(id);
  }, [e]);

  const makePan = (condition: (dx: number, dy: number) => boolean) =>
    PanResponder.create({
      onMoveShouldSetPanResponder: (_, g) => condition(g.dx, g.dy),
      onPanResponderTerminationRequest: () => false,
      onPanResponderGrant: () => {
        e.stopAnimation();
        base.current = lastE.current;
      },
      onPanResponderMove: (_, g) => e.setValue(clamp(base.current - g.dy / range, 0, 1)),
      onPanResponderRelease: (_, g) => {
        const now = clamp(base.current - g.dy / range, 0, 1);
        const projected = now + -g.vy * 0.3;
        const target: 0 | 1 = projected > 0.5 ? 1 : 0;
        if (target !== (expanded ? 1 : 0)) Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
        onSettle(target);
      },
      onPanResponderTerminate: () => onSettle(lastE.current > 0.5 ? 1 : 0),
    });

  // мини-плеер: тянем ВВЕРХ; верхняя панель полного плеера: тянем ВНИЗ
  const miniPan = useRef(makePan((dx, dy) => dy < -6 && Math.abs(dy) > Math.abs(dx))).current;
  const topPan = useRef(makePan((dx, dy) => dy > 6 && Math.abs(dy) > Math.abs(dx))).current;

  /* ───────── интерполяции ───────── */
  const cardY = e.interpolate({ inputRange: [0, 1], outputRange: [m.collapsedTop, 0] });
  const bgOpacity = e.interpolate({ inputRange: [0, 0.3], outputRange: [0, 1], extrapolate: 'clamp' });
  const miniOpacity = e.interpolate({ inputRange: [0, 0.22], outputRange: [1, 0], extrapolate: 'clamp' });
  const fullOpacity = e.interpolate({ inputRange: [0.55, 1], outputRange: [0, 1], extrapolate: 'clamp' });
  const heroOpacity = e.interpolate({ inputRange: [0, 0.94, 1], outputRange: [1, 1, 0], extrapolate: 'clamp' });
  const carouselOpacity = e.interpolate({ inputRange: [0, 0.94, 1], outputRange: [0, 0, 1], extrapolate: 'clamp' });

  const miniCx = m.miniMargin + 8 + m.thumb / 2;
  const miniCy = 8 + m.miniH / 2;
  const heroX = e.interpolate({ inputRange: [0, 1], outputRange: [miniCx - m.W / 2, 0] });
  const heroY = e.interpolate({ inputRange: [0, 1], outputRange: [miniCy - (m.coverTop + m.cover / 2), 0] });
  const heroScale = e.interpolate({ inputRange: [0, 1], outputRange: [m.thumb / m.cover, 1] });

  return (
    <Animated.View
      pointerEvents="box-none"
      style={[styles.card, { width: m.W, height: m.H, transform: [{ translateY: cardY }] }]}
    >
      {/* Фон полного плеера: размытая обложка */}
      <Animated.View style={[StyleSheet.absoluteFill, styles.bgFull, { opacity: bgOpacity }]} pointerEvents="none">
        <AmbientBackground uri={track?.artworkUri} />
        <View style={styles.topHairline} />
      </Animated.View>

      {/* Полный плеер */}
      <Animated.View
        style={[StyleSheet.absoluteFill, { opacity: fullOpacity, paddingTop: m.top }]}
        pointerEvents={expanded ? 'box-none' : 'none'}
      >
        <View style={[styles.topBar, { height: m.topbarH }]} {...topPan.panHandlers}>
          <IconButton
            name="pulse"
            size={20}
            glass
            box={40}
            active={showWave}
            onPress={() => setShowWave((v) => !v)}
          />
          <View style={styles.grabber} />
          <IconButton name="options" size={20} glass box={40} onPress={onOpenSettings} />
        </View>
        {/* Отступ под обложкой */}
        <View style={{ height: m.cover + 8 }} pointerEvents="none" />
        <PlayerControls
          engine={engine}
          state={state}
          bpm={bpm}
          bpmSource={bpmSource}
          onArtistPress={onArtistPress}
          onEditBpm={onEditBpm}
          onOpenQueue={() => onOpenSheet('queue')}
          onOpenLyrics={() => onOpenSheet('lyrics')}
        />
        <View style={{ height: m.bottom }} />
      </Animated.View>

      {/* Обложка-карусель (видна, когда плеер раскрыт) */}
      <Animated.View
        style={[styles.abs, { top: m.coverTop, left: (m.W - m.cover) / 2, opacity: carouselOpacity }]}
        pointerEvents={expanded ? 'auto' : 'none'}
      >
        <ArtworkCarousel
          queue={state.queue}
          index={state.index}
          size={m.cover}
          isPlaying={state.isPlaying}
          showWaveform={showWave}
          player={state.player}
          onNext={() => engine.next()}
          onPrevious={() => engine.previous()}
          onDragDownGrant={() => {
            e.stopAnimation();
            base.current = lastE.current;
          }}
          onDragDownMove={(dy) => {
            e.setValue(clamp(base.current - dy / range, 0, 1));
          }}
          onDragDownRelease={(dy, vy) => {
            const now = clamp(base.current - dy / range, 0, 1);
            const projected = now + -vy * 0.3;
            const target: 0 | 1 = projected > 0.5 ? 1 : 0;
            if (target !== (expanded ? 1 : 0)) Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
            onSettle(target);
          }}
        />
      </Animated.View>

      {/* Мини-плеер */}
      <Animated.View
        style={[
          styles.abs,
          { top: 8, left: m.miniMargin, right: m.miniMargin, height: m.miniH, opacity: miniOpacity },
        ]}
        pointerEvents={expanded ? 'none' : 'auto'}
        {...miniPan.panHandlers}
      >
        <Glass radius={m.miniH / 2} intensity={60} style={{ flex: 1 }}>
          <Pressable style={styles.miniContent} onPress={() => onSettle(1)}>
            {/* Вращающаяся обложка как vinyl */}
            <View style={{ marginLeft: 4, marginRight: 2 }}>
              <SpinningArtwork uri={track?.artworkUri} size={m.thumb - 2} isPlaying={state.isPlaying} />
            </View>
            <View style={{ flex: 1, marginLeft: 6 }}>
              <Text style={styles.miniTitle} numberOfLines={1}>
                {track?.title ?? 'Нет треков'}
              </Text>
              <Text style={styles.miniArtist} numberOfLines={1}>
                {track?.artist ?? ''}
              </Text>
            </View>
            <PressableScale onPress={() => engine.previous()} haptic="light" hitSlop={10}>
              <View style={styles.miniBtn}>
                <Ionicons name="play-skip-back" size={20} color={colors.text} />
              </View>
            </PressableScale>
            <PressableScale onPress={() => engine.togglePlay()} haptic="light" hitSlop={10}>
              <View style={styles.miniBtn}>
                <Ionicons name={state.isPlaying ? 'pause' : 'play'} size={24} color={colors.text} style={{ marginLeft: state.isPlaying ? 0 : 2 }} />
              </View>
            </PressableScale>
            <PressableScale onPress={() => engine.next()} haptic="light" hitSlop={10}>
              <View style={styles.miniBtn}>
                <Ionicons name="play-skip-forward" size={20} color={colors.text} />
              </View>
            </PressableScale>
          </Pressable>
          <MiniProgress engine={engine} duration={state.duration} />
        </Glass>
      </Animated.View>

      {/* Миниатюра → большая обложка (shared element) */}
      <Animated.View
        pointerEvents="none"
        style={[
          styles.abs,
          {
            top: m.coverTop,
            left: (m.W - m.cover) / 2,
            width: m.cover,
            height: m.cover,
            opacity: heroOpacity,
            transform: [{ translateX: heroX }, { translateY: heroY }, { scale: heroScale }],
          },
        ]}
      >
        <CoverArt uri={track?.artworkUri} size={m.cover} radius={28} />
      </Animated.View>
    </Animated.View>
  );
};


const styles = StyleSheet.create({
  card: { position: 'absolute', top: 0, left: 0, zIndex: 100 },
  abs: { position: 'absolute' },
  bgFull: {
    borderTopLeftRadius: 38,
    borderTopRightRadius: 38,
    overflow: 'hidden',
    backgroundColor: colors.bg,
  },
  topHairline: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    height: StyleSheet.hairlineWidth * 2,
    backgroundColor: 'rgba(255,255,255,0.18)',
  },
  topBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 20,
  },
  grabber: { width: 38, height: 5, borderRadius: 3, backgroundColor: 'rgba(255,255,255,0.3)' },
  miniContent: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 8,
    gap: 4,
  },
  miniTitle: { ...type.headline, fontSize: 15, color: colors.text },
  miniArtist: { ...type.caption, color: colors.text2, marginTop: 1 },
  miniBtn: { width: 40, height: 40, alignItems: 'center', justifyContent: 'center' },
  miniProgressTrack: {
    position: 'absolute',
    left: 22,
    right: 22,
    bottom: 5,
    height: 2,
    borderRadius: 1,
    backgroundColor: 'rgba(255,255,255,0.12)',
    overflow: 'hidden',
  },
  miniProgressFill: { height: 2, backgroundColor: 'rgba(255,255,255,0.75)', borderRadius: 1 },
});

void radius;
