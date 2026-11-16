import React, { useEffect, useRef, useState } from 'react';
import {
  Animated,
  Dimensions,
  LayoutChangeEvent,
  NativeScrollEvent,
  NativeSyntheticEvent,
  PanResponder,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { colors, type } from '../theme';
import { PressableScale } from './ui';

export type SheetMode = 'queue' | 'lyrics' | 'stats';

interface Props {
  mode: SheetMode;
  onModeChange: (m: SheetMode) => void;
  /** Animated.Value (0=sheet, 1=player) driving the shared transition */
  progress: Animated.Value;
  onSettle: (target: 0 | 1) => void;
  topInset: number;
  width?: number;
  scrollEnabled?: boolean;
  children: [React.ReactNode, React.ReactNode, React.ReactNode] | React.ReactNode[];
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** Каркас вторичных экранов: горизонтальный пейджер между Очередью, Текстом и Топом */
export const SheetPanel: React.FC<Props> = ({
  mode,
  onModeChange,
  progress,
  onSettle,
  topInset,
  width,
  scrollEnabled = true,
  children,
}) => {
  const screenWidth = width && width > 0 ? width : Dimensions.get('window').width;
  const base = useRef(0);
  const lastVal = useRef(0);
  const [layouts, setLayouts] = useState<{ [k in SheetMode]?: { x: number; width: number } }>({});
  const scrollRef = useRef<ScrollView>(null);
  const initialOffset = mode === 'queue' ? 0 : mode === 'lyrics' ? screenWidth : screenWidth * 2;
  const scrollX = useRef(new Animated.Value(initialOffset)).current;
  const isProgrammatic = useRef(false);

  // Синхронизация скролла при внешнем изменении mode (нажатие на таб или кнопка из плеера)
  useEffect(() => {
    const targetX = mode === 'queue' ? 0 : mode === 'lyrics' ? screenWidth : screenWidth * 2;
    isProgrammatic.current = true;
    (scrollRef.current as any)?.scrollTo({ x: targetX, animated: true });
    const timer = setTimeout(() => {
      isProgrammatic.current = false;
    }, 350);
    return () => clearTimeout(timer);
  }, [mode, screenWidth]);

  useEffect(() => {
    const id = progress.addListener(({ value }) => {
      lastVal.current = value;
    });
    return () => progress.removeListener(id);
  }, [progress]);

  // Свайп ВНИЗ по шапке → закрытие (переход в большой плеер)
  const panGesture = useRef(
    PanResponder.create({
      onMoveShouldSetPanResponder: (_, g) => g.dy > 6 && Math.abs(g.dy) > Math.abs(g.dx) * 1.2,
      onPanResponderTerminationRequest: () => false,
      onPanResponderGrant: () => {
        progress.stopAnimation();
        base.current = lastVal.current;
      },
      onPanResponderMove: (_, g) => {
        if (g.dy > 0) {
          const range = 220;
          const newVal = clamp(base.current + g.dy / range, 0, 1);
          progress.setValue(newVal);
        }
      },
      onPanResponderRelease: (_, g) => {
        const now = lastVal.current;
        const projected = now + g.vy * 0.25;
        const target: 0 | 1 = projected > 0.45 ? 1 : 0;
        if (target === 1) Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
        onSettle(target);
      },
      onPanResponderTerminate: () => onSettle(lastVal.current > 0.45 ? 1 : 0),
    })
  ).current;

  const handleTabPress = (targetMode: SheetMode) => {
    if (targetMode === mode) return;
    onModeChange(targetMode);
  };

  const onMomentumScrollEnd = (e: NativeSyntheticEvent<NativeScrollEvent>) => {
    const page = Math.round(e.nativeEvent.contentOffset.x / screenWidth);
    const newMode: SheetMode = page === 0 ? 'queue' : page === 1 ? 'lyrics' : 'stats';
    if (newMode !== mode) {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
      onModeChange(newMode);
    }
  };

  const qX = layouts.queue?.x ?? 0;
  const qW = layouts.queue?.width ?? 96;
  const lX = layouts.lyrics?.x ?? 116;
  const lW = layouts.lyrics?.width ?? 72;
  const sX = layouts.stats?.x ?? 200;
  const sW = layouts.stats?.width ?? 68;

  // Подчёркивание плавно следует за пальцем в реальном времени при свайпе
  const lineLeft = scrollX.interpolate({
    inputRange: [0, screenWidth, screenWidth * 2],
    outputRange: [qX, lX, sX],
    extrapolate: 'clamp',
  });
  const lineWidth = scrollX.interpolate({
    inputRange: [0, screenWidth, screenWidth * 2],
    outputRange: [qW, lW, sW],
    extrapolate: 'clamp',
  });

  const childrenArray = React.Children.toArray(children);
  const queueChild = childrenArray[0];
  const lyricsChild = childrenArray[1];
  const statsChild = childrenArray[2];

  const TAB_LABELS: Record<SheetMode, string> = {
    queue: 'Очередь',
    lyrics: 'Текст',
    stats: 'Топ 10',
  };

  return (
    <View style={{ flex: 1, paddingTop: topInset }}>
      <View style={styles.header} {...panGesture.panHandlers}>
        <View style={styles.grabber} />
        <View style={styles.tabs}>
          {(['queue', 'lyrics', 'stats'] as const).map((m) => {
            const on = m === mode;
            return (
              <PressableScale
                key={m}
                onPress={() => handleTabPress(m)}
                haptic="selection"
                scaleTo={0.96}
                onLayout={(e: LayoutChangeEvent) => {
                  const { x, width: w } = e.nativeEvent.layout;
                  setLayouts((prev) => ({ ...prev, [m]: { x, width: w } }));
                }}
              >
                <View style={styles.tab}>
                  <Text style={[styles.tabText, !on && { color: colors.text3 }]}>
                    {TAB_LABELS[m]}
                  </Text>
                </View>
              </PressableScale>
            );
          })}
          {/* Единое плавно скользящее подчёркивание за свайпом */}
          <Animated.View style={[styles.slidingUnderline, { left: lineLeft, width: lineWidth }]} />
        </View>
        <PressableScale onPress={() => onSettle(1)} hitSlop={12}>
          <View style={styles.close}>
            <Ionicons name="chevron-up" size={20} color={colors.text} />
          </View>
        </PressableScale>
      </View>

      {/* Горизонтальный пейджер между вкладками Очередь, Текст и Топ 10 */}
      <Animated.ScrollView
        ref={scrollRef as any}
        horizontal
        pagingEnabled
        showsHorizontalScrollIndicator={false}
        bounces={false}
        directionalLockEnabled
        scrollEnabled={scrollEnabled}
        scrollEventThrottle={16}
        onScroll={Animated.event(
          [{ nativeEvent: { contentOffset: { x: scrollX } } }],
          { useNativeDriver: false }
        )}
        onMomentumScrollEnd={onMomentumScrollEnd}
        contentOffset={{ x: initialOffset, y: 0 }}
        style={{ flex: 1 }}
      >
        <View style={{ width: screenWidth, flex: 1 }}>
          {queueChild}
        </View>
        <View style={{ width: screenWidth, flex: 1 }}>
          {lyricsChild}
        </View>
        <View style={{ width: screenWidth, flex: 1 }}>
          {statsChild}
        </View>
      </Animated.ScrollView>
    </View>
  );
};

const styles = StyleSheet.create({
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 20, paddingTop: 4, paddingBottom: 8 },
  grabber: { position: 'absolute', top: 0, left: '50%', marginLeft: -19, width: 38, height: 5, borderRadius: 3, backgroundColor: 'rgba(255,255,255,0.22)' },
  tabs: { flexDirection: 'row', gap: 18, flex: 1, paddingTop: 10, position: 'relative' },
  tab: { paddingVertical: 6, alignItems: 'center' },
  tabText: { ...type.largeTitle, fontSize: 26, color: colors.text },
  slidingUnderline: {
    position: 'absolute',
    bottom: 2,
    height: 3,
    borderRadius: 2,
    backgroundColor: colors.text,
  },
  close: { width: 40, height: 40, borderRadius: 20, backgroundColor: colors.glassStrong, alignItems: 'center', justifyContent: 'center' },
});
