import React, { useEffect, useRef, useState } from 'react';
import { Animated, Easing, PanResponder, Pressable, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { AudioEngine, EngineState } from '../services/audioEngine';
import { TrackFile } from '../types';
import { Metrics } from '../layout';
import { colors, radius, type } from '../theme';
import { CoverArt, Glass, IconButton, PressableScale } from './ui';
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
  onOpenSheet: (mode: 'queue' | 'lyrics' | 'stats') => void;
  onOpenSettings: () => void;
  onArtistPress: (artist: string) => void;
  onEditBpm: () => void;
  onEditTags?: () => void;
  onShareTrack?: () => void;
  bpm?: number;
  bpmSource?: 'manual' | 'tag' | 'auto';
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

const fmtSec = (sec: number) => {
  if (!sec || isNaN(sec) || sec < 0) return '0:00';
  const mins = Math.floor(sec / 60);
  const secs = Math.floor(sec % 60);
  return `${mins}:${secs < 10 ? '0' : ''}${secs}`;
};

// Блок по центру мини-плеера: название, время, исполнитель и таймлайн ПОД текстом
const MiniTrackCenter: React.FC<{
  track?: TrackFile;
  engine: AudioEngine;
  duration: number;
  active: boolean;
}> = ({ track, engine, duration, active }) => {
  const pos = usePosition(engine, 500, active);
  const ratio = duration > 0 ? clamp(pos / duration, 0, 1) : 0;
  return (
    <View style={styles.miniCenterCol}>
      <View style={styles.miniTextRow}>
        <Text style={styles.miniTitle} numberOfLines={1}>
          {track?.title ?? 'Нет треков'}
        </Text>
        <Text style={styles.miniTime}>
          {fmtSec(pos)} / {fmtSec(duration)}
        </Text>
      </View>
      <Text style={styles.miniArtist} numberOfLines={1}>
        {track?.artist ?? ''}
      </Text>
      <View style={styles.miniTimelineTrack}>
        <View style={[styles.miniTimelineFill, { width: `${ratio * 100}%` }]} />
      </View>
    </View>
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
  onEditTags,
  onShareTrack,
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

  // Непрерывное вращение обложки в мини-плеере (как винил)
  const rotAnim = useRef(new Animated.Value(0)).current;
  const currentAngle = useRef(0);

  useEffect(() => {
    const id = rotAnim.addListener(({ value }) => {
      currentAngle.current = value;
    });
    return () => rotAnim.removeListener(id);
  }, [rotAnim]);

  useEffect(() => {
    let anim: Animated.CompositeAnimation | null = null;
    let active = true;

    // вращение винила видно только в мини-плеере; в раскрытом плеере оно раньше крутилось невидимо и каждый кадр перерисовывало слой
    if (state.isPlaying && !expanded) {
      const step = () => {
        if (!active) return;
        const start = currentAngle.current % 1;
        rotAnim.setValue(start);
        currentAngle.current = start;
        const remaining = 1 - start;
        anim = Animated.timing(rotAnim, {
          toValue: 1,
          duration: Math.max(100, remaining * 8000),
          easing: Easing.linear,
          useNativeDriver: true,
        });
        anim.start(({ finished }) => {
          if (finished && active) {
            currentAngle.current = 0;
            rotAnim.setValue(0);
            step();
          }
        });
      };
      step();
    } else {
      rotAnim.stopAnimation((val) => {
        currentAngle.current = val;
      });
    }

    return () => {
      active = false;
      rotAnim.stopAnimation();
    };
  }, [state.isPlaying, expanded, rotAnim]);

  // Свайп треков в мини-плеере (как в Spotify)
  const miniSwipeX = useRef(new Animated.Value(0)).current;
  const miniOpacityFade = useRef(new Animated.Value(1)).current;
  const queueRef = useRef(state.queue);
  queueRef.current = state.queue;
  const engineRef = useRef(engine);
  engineRef.current = engine;
  const expandedRef = useRef(expanded);
  expandedRef.current = expanded;
  const miniDragMode = useRef<'none' | 'vertical' | 'horizontal'>('none');

  useEffect(() => {
    if (expanded) {
      miniSwipeX.setValue(0);
      miniOpacityFade.setValue(1);
    }
  }, [expanded, miniSwipeX, miniOpacityFade]);

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

  // мини-плеер: свайп вверх раскрывает плеер, свайп влево/вправо переключает трек как в Spotify
  const miniPan = useRef(
    PanResponder.create({
      onMoveShouldSetPanResponder: (_, g) => {
        if (expandedRef.current) return false;
        const isV = g.dy < -6 && Math.abs(g.dy) > Math.abs(g.dx) * 1.1;
        const isH = Math.abs(g.dx) > 6 && Math.abs(g.dx) > Math.abs(g.dy) * 1.1;
        return isV || isH;
      },
      onPanResponderTerminationRequest: () => false,
      onPanResponderGrant: () => {
        miniDragMode.current = 'none';
        e.stopAnimation();
        miniSwipeX.stopAnimation();
        miniOpacityFade.stopAnimation();
        base.current = lastE.current;
      },
      onPanResponderMove: (_, g) => {
        if (miniDragMode.current === 'none') {
          if (Math.abs(g.dx) > Math.abs(g.dy) && Math.abs(g.dx) > 6) {
            miniDragMode.current = 'horizontal';
          } else if (g.dy < -6 && Math.abs(g.dy) > Math.abs(g.dx)) {
            miniDragMode.current = 'vertical';
          }
        }

        if (miniDragMode.current === 'vertical') {
          e.setValue(clamp(base.current - g.dy / range, 0, 1));
        } else if (miniDragMode.current === 'horizontal') {
          const n = queueRef.current.length;
          const resist = n <= 1 ? 0.25 : 0.85;
          const dx = g.dx * resist;
          miniSwipeX.setValue(dx);
          const fade = clamp(1 - (Math.abs(dx) / 160) * 0.45, 0.45, 1);
          miniOpacityFade.setValue(fade);
        }
      },
      onPanResponderRelease: (_, g) => {
        const mode = miniDragMode.current;
        miniDragMode.current = 'none';

        if (mode === 'vertical') {
          const now = clamp(base.current - g.dy / range, 0, 1);
          const projected = now + -g.vy * 0.3;
          const target: 0 | 1 = projected > 0.5 ? 1 : 0;
          if (target !== (expandedRef.current ? 1 : 0)) Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
          onSettle(target);
          return;
        }

        if (mode === 'horizontal') {
          const n = queueRef.current.length;
          const commit = Math.abs(g.dx) > 36 || Math.abs(g.vx) > 0.42;

          if (commit && n > 1) {
            const isNext = Math.abs(g.dx) > 15 ? g.dx < 0 : g.vx < 0;
            Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);

            const exitDist = isNext ? Math.min(g.dx - 35, -85) : Math.max(g.dx + 35, 85);
            const enterDist = isNext ? 80 : -80;

            Animated.parallel([
              Animated.timing(miniSwipeX, {
                toValue: exitDist,
                duration: 95,
                easing: Easing.out(Easing.quad),
                useNativeDriver: true,
              }),
              Animated.timing(miniOpacityFade, {
                toValue: 0,
                duration: 85,
                useNativeDriver: true,
              }),
            ]).start(() => {
              if (isNext) {
                engineRef.current.next();
              } else {
                engineRef.current.previous(true);
              }

              miniSwipeX.setValue(enterDist);

              Animated.parallel([
                Animated.spring(miniSwipeX, {
                  toValue: 0,
                  useNativeDriver: true,
                  damping: 20,
                  stiffness: 270,
                  mass: 0.85,
                }),
                Animated.timing(miniOpacityFade, {
                  toValue: 1,
                  duration: 160,
                  useNativeDriver: true,
                }),
              ]).start();
            });
          } else {
            Animated.parallel([
              Animated.spring(miniSwipeX, {
                toValue: 0,
                useNativeDriver: true,
                damping: 22,
                stiffness: 280,
                mass: 1,
              }),
              Animated.timing(miniOpacityFade, {
                toValue: 1,
                duration: 140,
                useNativeDriver: true,
              }),
            ]).start();
          }
          return;
        }

        Animated.parallel([
          Animated.spring(miniSwipeX, { toValue: 0, useNativeDriver: true, damping: 22, stiffness: 280 }),
          Animated.timing(miniOpacityFade, { toValue: 1, duration: 140, useNativeDriver: true }),
        ]).start();
      },
      onPanResponderTerminate: () => {
        if (miniDragMode.current === 'vertical') {
          onSettle(lastE.current > 0.5 ? 1 : 0);
        } else {
          Animated.parallel([
            Animated.spring(miniSwipeX, { toValue: 0, useNativeDriver: true, damping: 22, stiffness: 280 }),
            Animated.timing(miniOpacityFade, { toValue: 1, duration: 140, useNativeDriver: true }),
          ]).start();
        }
        miniDragMode.current = 'none';
      },
    })
  ).current;

  // верхняя панель полного плеера: тянем ВНИЗ
  const topPan = useRef(makePan((dx, dy) => dy > 6 && Math.abs(dy) > Math.abs(dx))).current;

  /* ───────── интерполяции ───────── */
  const cardY = e.interpolate({ inputRange: [0, 1], outputRange: [m.collapsedTop, 0] });
  const bgOpacity = e.interpolate({ inputRange: [0, 0.3], outputRange: [0, 1], extrapolate: 'clamp' });
  const miniOpacity = e.interpolate({ inputRange: [0, 0.22], outputRange: [1, 0], extrapolate: 'clamp' });
  const fullOpacity = e.interpolate({ inputRange: [0.55, 1], outputRange: [0, 1], extrapolate: 'clamp' });
  const heroOpacity = e.interpolate({ inputRange: [0, 0.94, 1], outputRange: [1, 1, 0], extrapolate: 'clamp' });
  const carouselOpacity = e.interpolate({ inputRange: [0, 0.94, 1], outputRange: [0, 0, 1], extrapolate: 'clamp' });

  // Вращается в мини-плеере, выпрямляется при раскрытии
  const spinFactor = e.interpolate({ inputRange: [0, 0.35, 1], outputRange: [1, 0, 0], extrapolate: 'clamp' });
  const spinAngle = Animated.multiply(rotAnim, spinFactor).interpolate({
    inputRange: [0, 1],
    outputRange: ['0deg', '360deg'],
  });

  // Круглая форма в мини-плеере (m.cover / 2) плавно превращается в 28px скругление в большом
  const heroRadius = e.interpolate({
    inputRange: [0, 1],
    outputRange: [m.cover / 2, 28],
  });

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
      {/* Фон полного плеера: размытая обложка лежит один раз в корне приложения; здесь только подложка, которая плавно появляется */}
      <Animated.View style={[StyleSheet.absoluteFill, styles.bgFull, { opacity: bgOpacity }]} pointerEvents="none" />

      {/* Полный плеер */}
      <Animated.View
        style={[StyleSheet.absoluteFill, { opacity: fullOpacity, paddingTop: m.top }]}
        pointerEvents={expanded ? 'box-none' : 'none'}
      >
        <View style={[styles.topBar, { height: m.topbarH }]} {...topPan.panHandlers}>
          <IconButton
            name="pulse"
            size={18}
            glass
            box={36}
            active={showWave}
            onPress={() => setShowWave((v) => !v)}
          />
          <View style={styles.grabber} />
          <IconButton name="options" size={18} glass box={36} onPress={onOpenSettings} />
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
          onEditTags={onEditTags}
          onShareTrack={onShareTrack}
          onOpenQueue={() => onOpenSheet('queue')}
          onOpenLyrics={() => onOpenSheet('lyrics')}
          active={expanded}
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
          showWaveform={showWave && expanded}
          onNext={() => engine.next()}
          onPrevious={() => engine.previous(true)}
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
            <Animated.View
              style={[
                styles.miniTrackRow,
                {
                  transform: [{ translateX: miniSwipeX }],
                  opacity: miniOpacityFade,
                },
              ]}
            >
              {/* Слот под виниловую обложку (сама обложка перетекает через shared element) */}
              <View style={{ width: m.thumb, height: m.thumb, marginLeft: 2, marginRight: 8 }} />

              {/* Текст + таймлайн ПОД текстом (между обложкой и кнопками) */}
              <MiniTrackCenter track={track} engine={engine} duration={state.duration} active={!expanded} />
            </Animated.View>

            {/* Блок из трёх кнопок справа */}
            <View style={styles.miniBtnGroup}>
              <PressableScale onPress={() => engine.previous(true)} haptic="light" hitSlop={8}>
                <View style={styles.miniBtn}>
                  <Ionicons name="play-skip-back" size={19} color={colors.text} />
                </View>
              </PressableScale>
              <PressableScale onPress={() => engine.togglePlay()} haptic="light" hitSlop={8}>
                <View style={styles.miniBtn}>
                  <Ionicons name={state.isPlaying ? 'pause' : 'play'} size={23} color={colors.text} style={{ marginLeft: state.isPlaying ? 0 : 2 }} />
                </View>
              </PressableScale>
              <PressableScale onPress={() => engine.next()} haptic="light" hitSlop={8}>
                <View style={styles.miniBtn}>
                  <Ionicons name="play-skip-forward" size={19} color={colors.text} />
                </View>
              </PressableScale>
            </View>
          </Pressable>
        </Glass>
      </Animated.View>

      {/* Единственная обложка (shared element): в мини-плеере круглая и крутится, плавно растёт и превращается в квадратную */}
      <Animated.View
        pointerEvents="none"
        style={[
          StyleSheet.absoluteFill,
          {
            transform: [{ translateX: miniSwipeX }],
            opacity: miniOpacityFade,
          },
        ]}
      >
        <Animated.View
          pointerEvents="none"
          style={[
            styles.abs,
            {
              top: m.coverTop,
              left: (m.W - m.cover) / 2,
              width: m.cover,
              height: m.cover,
              borderRadius: heroRadius,
              overflow: 'hidden',
              opacity: heroOpacity,
              transform: [
                { translateX: heroX },
                { translateY: heroY },
                { scale: heroScale },
                { rotate: spinAngle },
              ],
            },
          ]}
        >
          <CoverArt uri={track?.artworkUri} size={m.cover} radius={0} />
        </Animated.View>
      </Animated.View>
    </Animated.View>
  );
};


const styles = StyleSheet.create({
  card: { position: 'absolute', top: 0, left: 0, zIndex: 100 },
  abs: { position: 'absolute' },
  bgFull: {
    overflow: 'hidden',
    backgroundColor: 'rgba(8,8,8,0.0)',
  },
  topBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 20,
  },
  grabber: { width: 32, height: 4, borderRadius: 2, backgroundColor: 'rgba(255,255,255,0.18)' },
  miniContent: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 8,
  },
  miniTrackRow: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
  },
  miniCenterCol: {
    flex: 1,
    justifyContent: 'center',
    paddingRight: 6,
  },
  miniTextRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 4,
  },
  miniTitle: { ...type.headline, fontSize: 13, color: colors.text, flex: 1 },
  miniTime: { ...type.caption, fontSize: 10, color: colors.text3, fontVariant: ['tabular-nums'] },
  miniArtist: { ...type.caption, fontSize: 11, color: colors.text2, marginTop: 1 },
  miniTimelineTrack: {
    height: 3,
    borderRadius: 2,
    backgroundColor: 'rgba(255,255,255,0.12)',
    overflow: 'hidden',
    marginTop: 4,
    width: '100%',
  },
  miniTimelineFill: {
    height: 3,
    backgroundColor: 'rgba(255,255,255,0.85)',
    borderRadius: 2,
  },
  miniBtnGroup: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  miniBtn: { width: 34, height: 38, alignItems: 'center', justifyContent: 'center' },
});

void radius;
