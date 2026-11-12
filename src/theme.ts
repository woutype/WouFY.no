import { Platform } from 'react-native';

/**
 * Дизайн-система Woufy: бездонный чёрный фон, чистое матовое стекло без эффектов,
 * никакого неона и 3D-засветов. Единственный акцент — чистый белый.
 */
export const colors = {
  bg: '#080808',
  bgElevated: '#111113',
  glass: 'rgba(255,255,255,0.055)',
  glassStrong: 'rgba(255,255,255,0.09)',
  glassPressed: 'rgba(255,255,255,0.13)',
  stroke: 'rgba(255,255,255,0.08)',
  strokeSoft: 'rgba(255,255,255,0.04)',
  highlight: 'rgba(255,255,255,0.22)',
  text: '#FFFFFF',
  text2: 'rgba(255,255,255,0.55)',
  text3: 'rgba(255,255,255,0.30)',
  onAccent: '#080808',
  accent: '#FFFFFF',
  danger: '#FF6B6B',
};

export const radius = {
  sm: 10,
  md: 16,
  lg: 24,
  xl: 32,
  pill: 999,
};

export const spacing = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
  xxl: 32,
};

export const type = {
  largeTitle: {
    fontSize: 34,
    fontWeight: '800' as const,
    letterSpacing: -1,
  },
  title: { fontSize: 22, fontWeight: '700' as const, letterSpacing: -0.5 },
  headline: { fontSize: 17, fontWeight: '600' as const, letterSpacing: -0.2 },
  body: { fontSize: 15, fontWeight: '500' as const },
  caption: { fontSize: 12, fontWeight: '500' as const },
  mono: {
    fontSize: 12,
    fontWeight: '500' as const,
    fontVariant: ['tabular-nums' as const],
  },
};

export const springs = {
  /** Мягкая «жидкая» пружина для раскрытия плеера */
  sheet: { damping: 22, stiffness: 190, mass: 1 },
  /** Короткая отзывчивая пружина для кнопок и обложки */
  snappy: { damping: 18, stiffness: 320, mass: 0.8 },
};

export const fontFamilyMono = Platform.select({ ios: 'Menlo', default: 'monospace' });

export function formatTime(seconds: number): string {
  if (!seconds || isNaN(seconds) || seconds < 0) return '0:00';
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins}:${secs < 10 ? '0' : ''}${secs}`;
}
