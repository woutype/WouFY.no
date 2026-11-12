import React, { useRef, useState } from 'react';
import { Animated, LayoutChangeEvent, PanResponder, StyleSheet, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { Glass, PressableScale } from './ui';
import { colors } from '../theme';

interface Props {
  onOpenQueue: () => void;
  onOpenLyrics: () => void;
}

const H = 56;
const THUMB_W = 72;
const THUMB_H = 44;
const PAD = 6;

/**
 * Нижний переключатель. Ползунок ведёт палец 1:1:
 *   тяну ВПРАВО до иконки списка → открывается «Очередь»,
 *   тяну ВЛЕВО до иконки текста → открывается «Текст песни».
 * Все размеры берутся из refs (нет «устаревших замыканий»), а решение принимается по
 * реальному положению ползунка и скорости.
 */
export const SheetSwitcher: React.FC<Props> = ({ onOpenQueue, onOpenLyrics }) => {
  const [width, setWidth] = useState(300);
  const maxTravel = useRef(100);
  const x = useRef(new Animated.Value(0)).current;
  const base = useRef(0);
  const detent = useRef(false);
  const cbs = useRef({ onOpenQueue, onOpenLyrics });
  cbs.current = { onOpenQueue, onOpenLyrics };

  const max = Math.max(40, (width - THUMB_W) / 2 - PAD);
  maxTravel.current = max;

  const springBack = () =>
    Animated.spring(x, { toValue: 0, useNativeDriver: true, damping: 16, stiffness: 220, mass: 0.9 }).start();

  const responder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => true,
      onPanResponderTerminationRequest: () => false,
      onPanResponderGrant: () => {
        detent.current = false;
        x.stopAnimation((v) => {
          base.current = v;
        });
        Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
      },
      onPanResponderMove: (_, g) => {
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
        const m = maxTravel.current;
        const v = Math.max(-m, Math.min(m, base.current + g.dx));
        const fling = Math.abs(g.vx) > 0.6 && Math.abs(v) > m * 0.35;
        const dir = v > 0 ? 1 : -1;
        if (Math.abs(v) >= m * 0.82 || fling) {
          Animated.timing(x, { toValue: dir * m, duration: 90, useNativeDriver: true }).start(() => {
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

  return (
    <Glass radius={H / 2} style={{ height: H }}>
      <View style={styles.fill} onLayout={onLayout}>
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

        {/* Ползунок — абсолютно позиционирован по центру */}
        <Animated.View
          style={[styles.thumb, { left: (width - THUMB_W) / 2, transform: [{ translateX: x }] }]}
          {...responder.panHandlers}
        >
          <Animated.View style={[styles.hint, { opacity: hintOpacity }]}>
            <Ionicons name="chevron-back" size={14} color="rgba(255,255,255,0.7)" />
            <View style={styles.grip} />
            <Ionicons name="chevron-forward" size={14} color="rgba(255,255,255,0.7)" />
          </Animated.View>
        </Animated.View>
      </View>
    </Glass>
  );
};

const styles = StyleSheet.create({
  fill: { flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: PAD },
  slot: {
    width: THUMB_W,
    height: THUMB_H,
    alignItems: 'center',
    justifyContent: 'center',
  },
  thumb: {
    position: 'absolute',
    top: (H - THUMB_H) / 2,
    width: THUMB_W,
    height: THUMB_H,
    borderRadius: THUMB_H / 2,
    backgroundColor: 'rgba(255,255,255,0.16)',
    borderWidth: StyleSheet.hairlineWidth * 2,
    borderColor: 'rgba(255,255,255,0.28)',
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 5,
  },
  hint: { flexDirection: 'row', alignItems: 'center', gap: 2 },
  grip: { width: 14, height: 4, borderRadius: 2, backgroundColor: 'rgba(255,255,255,0.85)' },
});
