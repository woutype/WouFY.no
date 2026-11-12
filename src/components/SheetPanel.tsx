import React, { useEffect, useRef, useState } from 'react';
import { Animated, LayoutChangeEvent, PanResponder, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { colors, type } from '../theme';
import { PressableScale } from './ui';

interface Props {
  mode: 'queue' | 'lyrics';
  onModeChange: (m: 'queue' | 'lyrics') => void;
  /** Animated.Value (0=sheet, 1=player) driving the shared transition */
  progress: Animated.Value;
  onSettle: (target: 0 | 1) => void;
  topInset: number;
  children: React.ReactNode;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** Каркас вторичных экранов: вкладки-подчёркивания и закрытие по свайпу вниз */
export const SheetPanel: React.FC<Props> = ({ mode, onModeChange, progress, onSettle, topInset, children }) => {
  const base = useRef(0);
  const lastVal = useRef(0);
  const [layouts, setLayouts] = useState<{ [k in 'queue' | 'lyrics']?: { x: number; width: number } }>({});
  const tabAnim = useRef(new Animated.Value(mode === 'queue' ? 0 : 1)).current;

  useEffect(() => {
    Animated.spring(tabAnim, {
      toValue: mode === 'queue' ? 0 : 1,
      useNativeDriver: false,
      damping: 20,
      stiffness: 240,
      mass: 0.8,
    }).start();
  }, [mode, tabAnim]);

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

  // Свайп ВЛЕВО / ВПРАВО по экрану → переключение между Очередь и Текст
  const bodySwipePan = useRef(
    PanResponder.create({
      onMoveShouldSetPanResponder: (_, g) =>
        Math.abs(g.dx) > 22 && Math.abs(g.dx) > Math.abs(g.dy) * 1.7,
      onPanResponderTerminationRequest: () => true,
      onPanResponderRelease: (_, g) => {
        if (g.dx < -40 || g.vx < -0.4) {
          if (mode === 'queue') {
            Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
            onModeChange('lyrics');
          }
        } else if (g.dx > 40 || g.vx > 0.4) {
          if (mode === 'lyrics') {
            Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
            onModeChange('queue');
          }
        }
      },
    })
  ).current;

  const qX = layouts.queue?.x ?? 0;
  const qW = layouts.queue?.width ?? 112;
  const lX = layouts.lyrics?.x ?? 136;
  const lW = layouts.lyrics?.width ?? 76;

  const lineLeft = tabAnim.interpolate({
    inputRange: [0, 1],
    outputRange: [qX, lX],
  });
  const lineWidth = tabAnim.interpolate({
    inputRange: [0, 1],
    outputRange: [qW, lW],
  });

  return (
    <View style={{ flex: 1, paddingTop: topInset }}>
      <View style={styles.header} {...panGesture.panHandlers}>
        <View style={styles.grabber} />
        <View style={styles.tabs}>
          {(['queue', 'lyrics'] as const).map((m) => {
            const on = m === mode;
            return (
              <PressableScale
                key={m}
                onPress={() => onModeChange(m)}
                haptic="selection"
                scaleTo={0.96}
                onLayout={(e: LayoutChangeEvent) => {
                  const { x, width } = e.nativeEvent.layout;
                  setLayouts((prev) => ({ ...prev, [m]: { x, width } }));
                }}
              >
                <View style={styles.tab}>
                  <Text style={[styles.tabText, !on && { color: colors.text3 }]}>
                    {m === 'queue' ? 'Очередь' : 'Текст'}
                  </Text>
                </View>
              </PressableScale>
            );
          })}
          {/* Единое плавно скользящее подчёркивание */}
          <Animated.View style={[styles.slidingUnderline, { left: lineLeft, width: lineWidth }]} />
        </View>
        <PressableScale onPress={() => onSettle(1)} hitSlop={12}>
          <View style={styles.close}>
            <Ionicons name="chevron-up" size={20} color={colors.text} />
          </View>
        </PressableScale>
      </View>
      <View style={{ flex: 1 }} {...bodySwipePan.panHandlers}>
        {children}
      </View>
    </View>
  );
};

const styles = StyleSheet.create({
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 20, paddingTop: 4, paddingBottom: 8 },
  grabber: { position: 'absolute', top: 0, left: '50%', marginLeft: -19, width: 38, height: 5, borderRadius: 3, backgroundColor: 'rgba(255,255,255,0.22)' },
  tabs: { flexDirection: 'row', gap: 24, flex: 1, paddingTop: 10, position: 'relative' },
  tab: { paddingVertical: 6, alignItems: 'center' },
  tabText: { ...type.largeTitle, fontSize: 30, color: colors.text },
  slidingUnderline: {
    position: 'absolute',
    bottom: 2,
    height: 3,
    borderRadius: 2,
    backgroundColor: colors.text,
  },
  close: { width: 40, height: 40, borderRadius: 20, backgroundColor: colors.glassStrong, alignItems: 'center', justifyContent: 'center' },
});
