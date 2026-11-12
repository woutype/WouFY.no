import React, { useRef } from 'react';
import { Animated, PanResponder, StyleSheet, Text, View } from 'react-native';
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

  // Track current progress value
  const progressSub = useRef<{ remove: () => void } | null>(null);
  if (!progressSub.current) {
    const id = progress.addListener(({ value }) => { lastVal.current = value; });
    progressSub.current = { remove: () => progress.removeListener(id) };
  }

  // Swipe DOWN on header → smoothly closes sheet (goes to player, progress → 1)
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
          // Swipe down: progress goes from 0 → 1 (open player = close sheet)
          const range = 220; // pixels for full transition
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

  return (
    <View style={{ flex: 1, paddingTop: topInset }}>
      <View style={styles.header} {...panGesture.panHandlers}>
        <View style={styles.grabber} />
        <View style={styles.tabs}>
          {(['queue', 'lyrics'] as const).map((m) => {
            const on = m === mode;
            return (
              <PressableScale key={m} onPress={() => onModeChange(m)} haptic="selection" scaleTo={0.96}>
                <View style={styles.tab}>
                  <Text style={[styles.tabText, !on && { color: colors.text3 }]}>{m === 'queue' ? 'Очередь' : 'Текст'}</Text>
                  <View style={[styles.underline, { opacity: on ? 1 : 0 }]} />
                </View>
              </PressableScale>
            );
          })}
        </View>
        <PressableScale onPress={() => onSettle(1)} hitSlop={12}>
          <View style={styles.close}>
            <Ionicons name="chevron-up" size={20} color={colors.text} />
          </View>
        </PressableScale>
      </View>
      <View style={{ flex: 1 }}>{children}</View>
    </View>
  );
};

const styles = StyleSheet.create({
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 20, paddingTop: 4, paddingBottom: 8 },
  grabber: { position: 'absolute', top: 0, left: '50%', marginLeft: -19, width: 38, height: 5, borderRadius: 3, backgroundColor: 'rgba(255,255,255,0.22)' },
  tabs: { flexDirection: 'row', gap: 24, flex: 1, paddingTop: 10 },
  tab: { paddingVertical: 6 },
  tabText: { ...type.largeTitle, fontSize: 30, color: colors.text },
  underline: { marginTop: 4, height: 3, width: 28, borderRadius: 2, backgroundColor: colors.text },
  close: { width: 40, height: 40, borderRadius: 20, backgroundColor: colors.glassStrong, alignItems: 'center', justifyContent: 'center' },
});
