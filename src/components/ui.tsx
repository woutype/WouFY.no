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
  useWindowDimensions,
} from 'react-native';
import { BlurView } from 'expo-blur';
import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { colors, radius, springs } from '../theme';
import { TrackFile } from '../types';
import { useFullArtwork } from '../hooks/useFullArtwork';

/* ───────── Liquid Glass ───────── */

interface GlassProps {
  style?: StyleProp<ViewStyle>;
  radius?: number;
  intensity?: number;
  children?: React.ReactNode;
}

/** Матовое стекло: лёгкое размытие + почти невидимая заливка + идеально плавная обводка без черных засечек на iOS */
export const Glass: React.FC<GlassProps> = ({ style, radius: r = radius.lg, intensity = 36, children }) => (
  <View style={[{ borderRadius: r, overflow: 'hidden' }, style]}>
    <BlurView intensity={intensity} tint="dark" style={StyleSheet.absoluteFill} />
    <View style={[StyleSheet.absoluteFill, { backgroundColor: colors.glass }]} />
    {/* Накладная обводка поверх BlurView исключает любые черные засечки CoreAnimation на Retina экранах */}
    <View
      pointerEvents="none"
      style={[
        StyleSheet.absoluteFill,
        {
          borderRadius: r,
          borderWidth: 1,
          borderColor: 'rgba(255, 255, 255, 0.14)',
        },
      ]}
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
  onLayout?: (e: LayoutChangeEvent) => void;
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
  onLayout,
  children,
}) => {
  const scale = useRef(new Animated.Value(1)).current;
  const to = (v: number) =>
    Animated.spring(scale, { toValue: v, useNativeDriver: true, ...springs.snappy }).start();

  const flat = (StyleSheet.flatten(style) || {}) as Record<string, any>;
  const pressableStyle: Record<string, any> = {};
  if (flat.flex !== undefined) pressableStyle.flex = flat.flex;
  if (flat.flexGrow !== undefined) pressableStyle.flexGrow = flat.flexGrow;
  if (flat.flexShrink !== undefined) pressableStyle.flexShrink = flat.flexShrink;
  if (flat.alignSelf !== undefined) pressableStyle.alignSelf = flat.alignSelf;
  if (flat.width !== undefined) pressableStyle.width = flat.width;
  if (flat.height !== undefined) pressableStyle.height = flat.height;
  if (flat.minHeight !== undefined) pressableStyle.minHeight = flat.minHeight;
  if (flat.maxHeight !== undefined) pressableStyle.maxHeight = flat.maxHeight;

  return (
    <Pressable
      disabled={disabled}
      hitSlop={hitSlop}
      style={pressableStyle}
      onLayout={onLayout}
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
      <View
        style={[
          styles.glassButton,
          {
            width: box,
            height: box,
            borderRadius: box / 2,
            backgroundColor: active ? 'rgba(255, 255, 255, 0.16)' : 'rgba(255, 255, 255, 0.08)',
            borderColor: active ? 'rgba(255, 255, 255, 0.32)' : 'rgba(255, 255, 255, 0.15)',
          },
        ]}
      >
        <Ionicons name={name} size={size} color={active ? colors.text : color} />
      </View>
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

export const CoverArt: React.FC<CoverArtProps> = ({ uri, size, radius: r = 24, style }) => {
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    setFailed(false);
  }, [uri]);

  return (
    <View style={[{ width: size, height: size, borderRadius: r, overflow: 'hidden', backgroundColor: colors.bgElevated }, style]}>
      {uri && !failed ? (
        <Image
          key={uri}
          source={{ uri }}
          style={{ width: size, height: size }}
          resizeMode="cover"
          fadeDuration={0}
          onError={() => setFailed(true)}
        />
      ) : (
        <View style={[styles.center, { backgroundColor: colors.bgElevated }]}>
          <Ionicons name="musical-notes" size={Math.max(14, size * 0.26)} color="rgba(255,255,255,0.22)" />
        </View>
      )}
    </View>
  );
};

/** Обложка главного экрана: мгновенно показывает миниатюру, поверх подгружает оригинал без сжатия */
export const FullCover: React.FC<{ track?: TrackFile; size: number; radius?: number }> = ({ track, size, radius: r = 24 }) => {
  const full = useFullArtwork(track);
  return (
    <View style={{ width: size, height: size }}>
      <CoverArt uri={track?.artworkUri} size={size} radius={r} />
      {full ? (
        <Image
          key={full}
          source={{ uri: full }}
          style={{ position: 'absolute', width: size, height: size, borderRadius: r }}
          resizeMode="cover"
          fadeDuration={0}
        />
      ) : null}
    </View>
  );
};

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
      Animated.timing(mix, { toValue: 0, duration: 700, useNativeDriver: true }).start();
    } else {
      setB(uri);
      Animated.timing(mix, { toValue: 1, duration: 700, useNativeDriver: true }).start();
    }
    showingB.current = !showingB.current;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [uri]);

  // Размытие считается на КРОШЕЧНОМ изображении (1/{K} размера экрана), а на весь экран оно растягивается масштабом на GPU.
  // Раньше размывалась картинка размером с экран при радиусе 80 — на каждую смену трека это были сотни миллисекунд работы процессора и нагрев.
  const { width: W, height: H } = useWindowDimensions();
  const K = 6;
  const iw = Math.ceil((W + 120) / K);
  const ih = Math.ceil((H + 120) / K);
  const layer = (u: string | undefined, opacity: Animated.AnimatedInterpolation<number> | Animated.Value) =>
    u ? (
      <Animated.Image
        source={{ uri: u }}
        blurRadius={14}
        resizeMode="cover"
        style={{
          position: 'absolute',
          width: iw,
          height: ih,
          left: (W - iw) / 2,
          top: (H - ih) / 2,
          opacity,
          transform: [{ scale: K }],
        }}
      />
    ) : null;

  return (
    <View style={StyleSheet.absoluteFill} pointerEvents="none">
      <View style={[StyleSheet.absoluteFill, { backgroundColor: colors.bg }]} />
      {layer(a, mix.interpolate({ inputRange: [0, 1], outputRange: [1, 0] }))}
      {layer(b, mix)}
      {/* Тёмное покрывало — без градиента, просто однородная полупрозрачность */}
      <View style={[StyleSheet.absoluteFill, { backgroundColor: 'rgba(8,8,8,0.72)' }]} />
    </View>
  );
};

/* ───────── Скраббер (перемотка / громкость) ───────── */

interface ScrubberProps {
  value: number;
  max: number;
  onScrub?: (v: number) => void;
  onCommit: (v: number) => void;
  /** жест прерван или это было простое касание в относительном режиме */
  onCancel?: () => void;
  height?: number;
  disabled?: boolean;
  /**
   * Относительный режим (для таймлайна): палец можно поставить в любое место,
   * и трек перематывается от ТЕКУЩЕЙ позиции на столько, на сколько провели пальцем
   * (вся ширина шкалы = вся длительность). Простое касание ничего не перематывает.
   */
  relative?: boolean;
}

export const Scrubber: React.FC<ScrubberProps> = ({ value, max, onScrub, onCommit, onCancel, height = 6, disabled, relative = false }) => {
  const [width, setWidth] = useState(1);
  const [dragValue, setDragValue] = useState<number | null>(null);
  const grow = useRef(new Animated.Value(0)).current;
  const w = useRef(1);
  const startRatio = useRef(0);
  const moved = useRef(false);
  const maxRef = useRef(max);
  const valueRef = useRef(value);
  const relRef = useRef(relative);
  const cbs = useRef({ onScrub, onCommit, onCancel });
  maxRef.current = max;
  valueRef.current = value;
  relRef.current = relative;
  cbs.current = { onScrub, onCommit, onCancel };

  const toValue = (ratio: number) => Math.min(1, Math.max(0, ratio)) * maxRef.current;

  const responder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => true,
      onPanResponderTerminationRequest: () => false,
      onPanResponderGrant: (e) => {
        moved.current = false;
        Haptics.selectionAsync();
        Animated.spring(grow, { toValue: 1, useNativeDriver: true, ...springs.snappy }).start();
        if (relRef.current) {
          // стартуем с того места, где трек сейчас — палец «берёт» таймлайн, а не переставляет метку
          startRatio.current = maxRef.current > 0 ? valueRef.current / maxRef.current : 0;
          setDragValue(valueRef.current);
        } else {
          startRatio.current = e.nativeEvent.locationX / w.current;
          const v = toValue(startRatio.current);
          setDragValue(v);
          cbs.current.onScrub?.(v);
        }
      },
      onPanResponderMove: (_, g) => {
        if (relRef.current && !moved.current && Math.abs(g.dx) < 2) return;
        moved.current = true;
        const v = toValue(startRatio.current + g.dx / w.current);
        setDragValue(v);
        cbs.current.onScrub?.(v);
      },
      onPanResponderRelease: (_, g) => {
        const v = toValue(startRatio.current + g.dx / w.current);
        setDragValue(null);
        // в относительном режиме простое касание без движения — ничего не перематываем
        if (!relRef.current || moved.current) cbs.current.onCommit(v);
        else cbs.current.onCancel?.();
        Animated.spring(grow, { toValue: 0, useNativeDriver: true, ...springs.snappy }).start();
      },
      onPanResponderTerminate: () => {
        setDragValue(null);
        cbs.current.onCancel?.();
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
      {/* дочерние элементы не перехватывают касания — locationX всегда считается от самой шкалы */}
      <Animated.View
        pointerEvents="none"
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
  glassButton: {
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
  },
  glassBorder: {
    borderWidth: 1,
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
});
