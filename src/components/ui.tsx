import React, { useEffect, useRef, useState } from 'react';
import {
  Animated,
  Image,
  LayoutChangeEvent,
  PanResponder,
  Pressable,
  StyleProp,
  StyleSheet,
  View,
  ViewStyle,
} from 'react-native';
import { BlurView } from 'expo-blur';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { colors, radius, springs } from '../theme';

/* ───────── Liquid Glass ───────── */

interface GlassProps {
  style?: StyleProp<ViewStyle>;
  radius?: number;
  intensity?: number;
  children?: React.ReactNode;
}

/** Матовое стекло: размытие + лёгкая подсветка верхней грани + тонкая обводка. Без свечения. */
export const Glass: React.FC<GlassProps> = ({ style, radius: r = radius.lg, intensity = 40, children }) => (
  <View style={[{ borderRadius: r, overflow: 'hidden' }, styles.glassBorder, { borderRadius: r }, style]}>
    <BlurView intensity={intensity} tint="dark" style={StyleSheet.absoluteFill} />
    <View style={[StyleSheet.absoluteFill, { backgroundColor: colors.glass }]} />
    <LinearGradient
      colors={['rgba(255,255,255,0.10)', 'rgba(255,255,255,0)']}
      style={[StyleSheet.absoluteFill, { height: '55%' }]}
      pointerEvents="none"
    />
    {children}
  </View>
);

/* ───────── Кнопка с мягкой пружиной ───────── */

interface PressableScaleProps {
  onPress?: () => void;
  onLongPress?: () => void;
  haptic?: 'light' | 'medium' | 'selection' | 'none';
  style?: StyleProp<ViewStyle>;
  hitSlop?: number;
  scaleTo?: number;
  disabled?: boolean;
  children?: React.ReactNode;
}

export const PressableScale: React.FC<PressableScaleProps> = ({
  onPress,
  onLongPress,
  haptic = 'light',
  style,
  hitSlop = 8,
  scaleTo = 0.9,
  disabled,
  children,
}) => {
  const scale = useRef(new Animated.Value(1)).current;
  const to = (v: number) =>
    Animated.spring(scale, { toValue: v, useNativeDriver: true, ...springs.snappy }).start();
  return (
    <Pressable
      disabled={disabled}
      hitSlop={hitSlop}
      onPressIn={() => to(scaleTo)}
      onPressOut={() => to(1)}
      onLongPress={onLongPress}
      onPress={() => {
        if (haptic === 'light') Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
        else if (haptic === 'medium') Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
        else if (haptic === 'selection') Haptics.selectionAsync();
        onPress?.();
      }}
    >
      <Animated.View style={[style, { transform: [{ scale }] }]}>{children}</Animated.View>
    </Pressable>
  );
};

interface IconButtonProps {
  name: React.ComponentProps<typeof Ionicons>['name'];
  onPress?: () => void;
  size?: number;
  box?: number;
  color?: string;
  glass?: boolean;
  active?: boolean;
  haptic?: PressableScaleProps['haptic'];
}

export const IconButton: React.FC<IconButtonProps> = ({
  name,
  onPress,
  size = 20,
  box = 40,
  color = colors.text,
  glass = false,
  active = false,
  haptic = 'light',
}) => (
  <PressableScale onPress={onPress} haptic={haptic} hitSlop={6}>
    {glass ? (
      <Glass radius={box / 2} style={{ width: box, height: box }}>
        <View style={styles.center}>
          <Ionicons name={name} size={size} color={active ? colors.text : color} />
        </View>
      </Glass>
    ) : (
      <View style={{ width: box, height: box, alignItems: 'center', justifyContent: 'center' }}>
        <Ionicons name={name} size={size} color={active ? colors.text : color} />
        {active && <View style={styles.activeDot} />}
      </View>
    )}
  </PressableScale>
);

/* ───────── Обложка ───────── */

interface CoverArtProps {
  uri?: string;
  size: number;
  radius?: number;
  style?: StyleProp<ViewStyle>;
}

export const CoverArt: React.FC<CoverArtProps> = ({ uri, size, radius: r = 24, style }) => (
  <View style={[{ width: size, height: size, borderRadius: r, overflow: 'hidden', backgroundColor: colors.bgElevated }, style]}>
    {uri ? (
      <Image source={{ uri }} style={{ width: size, height: size }} resizeMode="cover" fadeDuration={0} />
    ) : (
      <LinearGradient colors={['#2A2A2E', '#161618']} style={styles.center}>
        <Ionicons name="musical-notes" size={Math.max(14, size * 0.28)} color="rgba(255,255,255,0.35)" />
      </LinearGradient>
    )}
  </View>
);

/* ───────── Фон из размытой обложки (с кросс-фейдом) ───────── */

export const AmbientBackground: React.FC<{ uri?: string }> = ({ uri }) => {
  const [a, setA] = useState<string | undefined>(uri);
  const [b, setB] = useState<string | undefined>(undefined);
  const mix = useRef(new Animated.Value(0)).current;
  const showingB = useRef(false);

  useEffect(() => {
    const current = showingB.current ? b : a;
    if (uri === current) return;
    if (showingB.current) {
      setA(uri);
      Animated.timing(mix, { toValue: 0, duration: 600, useNativeDriver: true }).start();
    } else {
      setB(uri);
      Animated.timing(mix, { toValue: 1, duration: 600, useNativeDriver: true }).start();
    }
    showingB.current = !showingB.current;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [uri]);

  const layer = (u: string | undefined, opacity: Animated.AnimatedInterpolation<number> | Animated.Value) =>
    u ? (
      <Animated.Image
        source={{ uri: u }}
        blurRadius={50}
        resizeMode="cover"
        style={[styles.ambientImg, { opacity }]}
      />
    ) : null;

  return (
    <View style={StyleSheet.absoluteFill} pointerEvents="none">
      <View style={[StyleSheet.absoluteFill, { backgroundColor: colors.bg }]} />
      {layer(a, mix.interpolate({ inputRange: [0, 1], outputRange: [1, 0] }))}
      {layer(b, mix)}
      <LinearGradient
        colors={['rgba(10,10,11,0.55)', 'rgba(10,10,11,0.82)', 'rgba(10,10,11,0.96)']}
        style={StyleSheet.absoluteFill}
      />
    </View>
  );
};

/* ───────── Скраббер (перемотка / громкость) ───────── */

interface ScrubberProps {
  value: number;
  max: number;
  onScrub?: (v: number) => void;
  onCommit: (v: number) => void;
  height?: number;
  disabled?: boolean;
}

export const Scrubber: React.FC<ScrubberProps> = ({ value, max, onScrub, onCommit, height = 6, disabled }) => {
  const [width, setWidth] = useState(1);
  const [dragValue, setDragValue] = useState<number | null>(null);
  const grow = useRef(new Animated.Value(0)).current;
  const w = useRef(1);
  const startRatio = useRef(0);
  const maxRef = useRef(max);
  const cbs = useRef({ onScrub, onCommit });
  maxRef.current = max;
  cbs.current = { onScrub, onCommit };

  const toValue = (ratio: number) => Math.min(1, Math.max(0, ratio)) * maxRef.current;

  const responder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => true,
      onPanResponderTerminationRequest: () => false,
      onPanResponderGrant: (e) => {
        startRatio.current = e.nativeEvent.locationX / w.current;
        const v = toValue(startRatio.current);
        setDragValue(v);
        cbs.current.onScrub?.(v);
        Haptics.selectionAsync();
        Animated.spring(grow, { toValue: 1, useNativeDriver: true, ...springs.snappy }).start();
      },
      onPanResponderMove: (_, g) => {
        const v = toValue(startRatio.current + g.dx / w.current);
        setDragValue(v);
        cbs.current.onScrub?.(v);
      },
      onPanResponderRelease: (_, g) => {
        const v = toValue(startRatio.current + g.dx / w.current);
        setDragValue(null);
        cbs.current.onCommit(v);
        Animated.spring(grow, { toValue: 0, useNativeDriver: true, ...springs.snappy }).start();
      },
      onPanResponderTerminate: () => {
        setDragValue(null);
        Animated.spring(grow, { toValue: 0, useNativeDriver: true, ...springs.snappy }).start();
      },
    })
  ).current;

  const shown = dragValue ?? value;
  const ratio = max > 0 ? Math.min(1, Math.max(0, shown / max)) : 0;

  return (
    <View
      style={{ height: 32, justifyContent: 'center', opacity: disabled ? 0.4 : 1 }}
      onLayout={(e: LayoutChangeEvent) => {
        w.current = Math.max(1, e.nativeEvent.layout.width);
        setWidth(w.current);
      }}
      pointerEvents={disabled ? 'none' : 'auto'}
      {...responder.panHandlers}
    >
      <Animated.View
        style={{
          height,
          borderRadius: height,
          overflow: 'hidden',
          backgroundColor: 'rgba(255,255,255,0.18)',
          transform: [{ scaleY: grow.interpolate({ inputRange: [0, 1], outputRange: [1, 1.7] }) }],
        }}
      >
        <View style={{ height, width: width * ratio, backgroundColor: colors.text, borderRadius: height }} />
      </Animated.View>
    </View>
  );
};

const styles = StyleSheet.create({
  glassBorder: {
    borderWidth: StyleSheet.hairlineWidth * 2,
    borderColor: colors.stroke,
  },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  activeDot: {
    position: 'absolute',
    bottom: 2,
    width: 4,
    height: 4,
    borderRadius: 2,
    backgroundColor: colors.text,
  },
  ambientImg: {
    position: 'absolute',
    top: -60,
    left: -60,
    right: -60,
    bottom: -60,
  },
});
