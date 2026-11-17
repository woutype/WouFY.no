import React, { useRef, useState } from 'react';
import {
  Animated,
  LayoutChangeEvent,
  PanResponder,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
} from 'react-native';
import { BlurView } from 'expo-blur';
import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { Glass, PressableScale } from './ui';
import { colors, type } from '../theme';

interface Props {
  onOpenQueue: () => void;
  onOpenLyrics: () => void;
  onShareTrack?: () => void;
}

const H = 56;
const THUMB_W = 72;
const THUMB_H = 44;
const CIRC_SIZE = 76;
const PAD = 6;
const SHARE_THRESHOLD = -120;

export const SheetSwitcher: React.FC<Props> = ({ onOpenQueue, onOpenLyrics, onShareTrack }) => {
  const { width: screenWidth, height: screenHeight } = useWindowDimensions();
  const [width, setWidth] = useState(300);
  const maxTravel = useRef(100);
  const x = useRef(new Animated.Value(0)).current;
  const y = useRef(new Animated.Value(0)).current;
  const base = useRef(0);
  const detent = useRef(false);
  const shareDetent = useRef(false);
  const lastHapticStep = useRef(0);
  const [shareActive, setShareActive] = useState(false);
  const [shareReady, setShareReady] = useState(false);

  const cbs = useRef({ onOpenQueue, onOpenLyrics, onShareTrack });
  cbs.current = { onOpenQueue, onOpenLyrics, onShareTrack };

  const max = Math.max(40, (width - THUMB_W) / 2 - PAD);
  maxTravel.current = max;

  const springBack = () => {
    setShareActive(false);
    setShareReady(false);
    shareDetent.current = false;
    lastHapticStep.current = 0;
    Animated.parallel([
      Animated.spring(x, { toValue: 0, useNativeDriver: false, damping: 18, stiffness: 240, mass: 0.9 }),
      Animated.spring(y, { toValue: 0, useNativeDriver: false, damping: 18, stiffness: 240, mass: 0.9 }),
    ]).start();
  };

  const responder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => true,
      onPanResponderTerminationRequest: () => false,
      onPanResponderGrant: () => {
        detent.current = false;
        shareDetent.current = false;
        lastHapticStep.current = 0;
        x.stopAnimation((v) => {
          base.current = v;
        });
        y.stopAnimation();
        Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
      },
      onPanResponderMove: (_, g) => {
        // Вертикальное движение вверх (жест Поделиться)
        if (g.dy < -10 && Math.abs(g.dy) > Math.abs(g.dx) * 0.7) {
          if (!shareActive) setShareActive(true);
          const clampedY = Math.max(-180, Math.min(0, g.dy));
          y.setValue(clampedY);
          x.setValue(g.dx * 0.18); // демпфирование по горизонтали — держит строго по центру

          // Тактильные отклики при движении вверх
          const step = Math.floor(Math.abs(clampedY) / 32);
          if (step !== lastHapticStep.current) {
            lastHapticStep.current = step;
            Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
          }

          const isOver = clampedY <= SHARE_THRESHOLD;
          setShareReady(isOver);
          if (isOver && !shareDetent.current) {
            shareDetent.current = true;
            Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
          } else if (!isOver && shareDetent.current) {
            shareDetent.current = false;
          }
          return;
        }

        // Горизонтальное движение (Текст / Очередь)
        if (shareActive && g.dy >= -8) {
          setShareActive(false);
          setShareReady(false);
        }
        y.setValue(0);
        const m = maxTravel.current;
        const v = Math.max(-m, Math.min(m, base.current + g.dx));
        x.setValue(v);
        const passed = Math.abs(v) >= m * 0.82;
        if (passed && !detent.current) {
          detent.current = true;
          Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
        } else if (!passed && detent.current) {
          detent.current = false;
        }
      },
      onPanResponderRelease: (_, g) => {
        // Сработал жест Share
        if (g.dy <= SHARE_THRESHOLD) {
          Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
          cbs.current.onShareTrack?.();
          springBack();
          return;
        }

        // Горизонтальный свайп
        const m = maxTravel.current;
        const v = Math.max(-m, Math.min(m, base.current + g.dx));
        const fling = Math.abs(g.vx) > 0.6 && Math.abs(v) > m * 0.35;
        const dir = v > 0 ? 1 : -1;
        if (Math.abs(v) >= m * 0.82 || fling) {
          Animated.timing(x, { toValue: dir * m, duration: 90, useNativeDriver: false }).start(() => {
            if (dir > 0) cbs.current.onOpenQueue();
            else cbs.current.onOpenLyrics();
            setTimeout(springBack, 120);
          });
        } else {
          springBack();
        }
      },
      onPanResponderTerminate: springBack,
    })
  ).current;

  const onLayout = (e: LayoutChangeEvent) => setWidth(e.nativeEvent.layout.width);

  const leftOpacity = x.interpolate({ inputRange: [-max, 0], outputRange: [1, 0.55], extrapolate: 'clamp' });
  const rightOpacity = x.interpolate({ inputRange: [0, max], outputRange: [0.55, 1], extrapolate: 'clamp' });
  const hintOpacity = x.interpolate({ inputRange: [-30, 0, 30], outputRange: [0, 1, 0], extrapolate: 'clamp' });

  // Размытие фона при движении вверх
  const backdropOpacity = y.interpolate({
    inputRange: [-110, -15],
    outputRange: [1, 0],
    extrapolate: 'clamp',
  });

  // Исчезновение нижней плашки-трека при вытягивании ползунка вверх
  const trackBarOpacity = y.interpolate({
    inputRange: [-50, 0],
    outputRange: [0, 1],
    extrapolate: 'clamp',
  });

  // Морфинг капсулы в большой светящийся круг
  const thumbWidth = y.interpolate({
    inputRange: [SHARE_THRESHOLD, 0],
    outputRange: [CIRC_SIZE, THUMB_W],
    extrapolate: 'clamp',
  });
  const thumbHeight = y.interpolate({
    inputRange: [SHARE_THRESHOLD, 0],
    outputRange: [CIRC_SIZE, THUMB_H],
    extrapolate: 'clamp',
  });
  const thumbRadius = y.interpolate({
    inputRange: [SHARE_THRESHOLD, 0],
    outputRange: [CIRC_SIZE / 2, THUMB_H / 2],
    extrapolate: 'clamp',
  });

  const chevronsOpacity = y.interpolate({
    inputRange: [-35, 0],
    outputRange: [0, 1],
    extrapolate: 'clamp',
  });
  const shareIconOpacity = y.interpolate({
    inputRange: [-80, -20],
    outputRange: [1, 0],
    extrapolate: 'clamp',
  });
  const tooltipOpacity = y.interpolate({
    inputRange: [-45, -15],
    outputRange: [1, 0],
    extrapolate: 'clamp',
  });

  return (
    <View style={{ position: 'relative', width: '100%', alignItems: 'center' }}>
      {/* 1. Полноэкранное размытие фона при вытягивании ползунка вверх: с запасом по ширине и высоте, без швов и срезов */}
      <Animated.View
        pointerEvents="none"
        style={[
          styles.backdropOverlay,
          {
            width: screenWidth * 2,
            height: screenHeight * 3,
            top: -screenHeight * 1.5,
            left: -screenWidth * 0.5,
            opacity: backdropOpacity,
          },
        ]}
      >
        <BlurView intensity={65} tint="dark" style={StyleSheet.absoluteFill} />
        <View style={[StyleSheet.absoluteFill, { backgroundColor: 'rgba(0, 0, 0, 0.65)' }]} />
      </Animated.View>

      {/* 2. Всплывающая подсказка над ползунком при движении вверх */}
      <Animated.View
        pointerEvents="none"
        style={[
          styles.tooltipWrap,
          {
            opacity: tooltipOpacity,
            transform: [{ translateY: y }],
          },
        ]}
      >
        <Glass radius={999} style={[styles.tooltipGlass, shareReady && styles.tooltipGlassReady]}>
          <View style={styles.tooltipInner}>
            <Ionicons
              name={shareReady ? 'checkmark-circle' : 'arrow-up-circle-outline'}
              size={15}
              color={shareReady ? colors.text : colors.text2}
            />
            <Text style={[styles.tooltipText, shareReady && styles.tooltipTextReady]}>
              {shareReady ? 'Отпустите, чтобы поделиться' : 'Тяните к центру экрана'}
            </Text>
          </View>
        </Glass>
      </Animated.View>

      {/* 3. Плашка переключателя Текст / Очередь (растворяется при движении вверх) */}
      <Animated.View style={{ width: '100%', opacity: trackBarOpacity }} onLayout={onLayout}>
        <Glass radius={H / 2} style={{ height: H }}>
          <View style={styles.fill}>
            {/* Слева — текст песни */}
            <PressableScale onPress={onOpenLyrics} style={styles.slot} scaleTo={0.92}>
              <Animated.View style={{ opacity: leftOpacity, alignItems: 'center' }}>
                <Ionicons name="text" size={20} color={colors.text} />
              </Animated.View>
            </PressableScale>

            {/* Справа — очередь */}
            <PressableScale onPress={onOpenQueue} style={styles.slot} scaleTo={0.92}>
              <Animated.View style={{ opacity: rightOpacity, alignItems: 'center' }}>
                <Ionicons name="list" size={22} color={colors.text} />
              </Animated.View>
            </PressableScale>
          </View>
        </Glass>
      </Animated.View>

      {/* 4. Ползунок — вынесен НАД плашкой, поэтому свободно и плавно трансформируется без обрезки */}
      <View
        pointerEvents="box-none"
        style={{
          position: 'absolute',
          top: (H - THUMB_H) / 2,
          left: 0,
          right: 0,
          alignItems: 'center',
          zIndex: 100,
        }}
      >
        <Animated.View
          style={[
            styles.thumb,
            {
              width: thumbWidth,
              height: thumbHeight,
              borderRadius: thumbRadius,
              transform: [{ translateX: x }, { translateY: y }],
              backgroundColor: shareReady ? '#FFFFFF' : 'rgba(255, 255, 255, 0.16)',
              borderColor: shareReady ? '#FFFFFF' : 'rgba(255, 255, 255, 0.28)',
              shadowColor: shareReady ? '#FFFFFF' : '#000',
              shadowOpacity: shareReady ? 0.45 : 0.25,
              shadowRadius: shareReady ? 18 : 6,
              elevation: 8,
            },
          ]}
          {...responder.panHandlers}
        >
          {/* Обычный режим: стрелочки переключателя */}
          <Animated.View style={[styles.hint, { opacity: Animated.multiply(hintOpacity, chevronsOpacity) }]}>
            <Ionicons name="chevron-back" size={14} color="rgba(255,255,255,0.7)" />
            <View style={styles.grip} />
            <Ionicons name="chevron-forward" size={14} color="rgba(255,255,255,0.7)" />
          </Animated.View>

          {/* Режим поделиться: крупная иконка Share */}
          <Animated.View
            style={[
              styles.shareIconWrap,
              {
                opacity: shareIconOpacity,
                transform: [
                  {
                    scale: y.interpolate({
                      inputRange: [SHARE_THRESHOLD, -30],
                      outputRange: [1.2, 0.7],
                      extrapolate: 'clamp',
                    }),
                  },
                ],
              },
            ]}
          >
            <Ionicons
              name="share-outline"
              size={28}
              color={shareReady ? colors.onAccent : colors.text}
            />
          </Animated.View>
        </Animated.View>
      </View>
    </View>
  );
};

const styles = StyleSheet.create({
  backdropOverlay: {
    position: 'absolute',
    zIndex: 40,
  },
  fill: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: PAD,
  },
  slot: {
    width: THUMB_W,
    height: THUMB_H,
    alignItems: 'center',
    justifyContent: 'center',
  },
  thumb: {
    borderWidth: 1.5,
    alignItems: 'center',
    justifyContent: 'center',
    shadowOffset: { width: 0, height: 4 },
  },
  hint: { flexDirection: 'row', alignItems: 'center', gap: 2 },
  grip: { width: 14, height: 4, borderRadius: 2, backgroundColor: 'rgba(255,255,255,0.85)' },
  shareIconWrap: {
    position: 'absolute',
    alignItems: 'center',
    justifyContent: 'center',
  },
  tooltipWrap: {
    position: 'absolute',
    top: -54,
    alignItems: 'center',
    zIndex: 120,
  },
  tooltipGlass: {
    paddingHorizontal: 16,
    paddingVertical: 7,
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.12)',
  },
  tooltipGlassReady: {
    borderColor: 'rgba(255, 255, 255, 0.45)',
    backgroundColor: 'rgba(255, 255, 255, 0.12)',
  },
  tooltipInner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 7,
  },
  tooltipText: {
    ...type.caption,
    fontSize: 12,
    color: colors.text2,
    fontWeight: '600',
  },
  tooltipTextReady: {
    color: colors.text,
    fontWeight: '700',
  },
});
