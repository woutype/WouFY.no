import { Platform } from 'react-native';

/**
 * Дизайн-система Woufy: графитовая монохромная палитра, мягкое «жидкое стекло»,
 * никакого неонового свечения. Белый — единственный акцент.
 */
export const colors = {
  bg: '#0A0A0B',
  bgElevated: '#141416',
  glass: 'rgba(255,255,255,0.07)',
  glassStrong: 'rgba(255,255,255,0.12)',
  glassPressed: 'rgba(255,255,255,0.16)',
  stroke: 'rgba(255,255,255,0.12)',
  strokeSoft: 'rgba(255,255,255,0.07)',
  highlight: 'rgba(255,255,255,0.28)',
  text: '#FFFFFF',
  text2: 'rgba(255,255,255,0.64)',
  text3: 'rgba(255,255,255,0.38)',
  onAccent: '#0A0A0B',
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
