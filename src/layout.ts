import { useMemo } from 'react';
import { useWindowDimensions } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

export interface Metrics {
  W: number;
  H: number;
  top: number;
  bottom: number;
  /** сторона обложки в полном плеере */
  cover: number;
  topbarH: number;
  coverTop: number;
  miniH: number;
  miniMargin: number;
  /** Y верхней грани карточки в свёрнутом виде (мини-плеер) */
  collapsedTop: number;
  /** высота зоны, занятой мини-плеером снизу (отступ для списков) */
  miniArea: number;
  thumb: number;
}

export function useMetrics(): Metrics {
  const { width: W, height: H } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  return useMemo(() => {
    const top = Math.max(insets.top, 20);
    const bottom = Math.max(insets.bottom, 12);
    const topbarH = 52;
    const miniH = 64;
    const miniMargin = 12;
    // вертикальный бюджет под всё, кроме обложки: инфо+скраббер+кнопки+громкость+переключатель
    const rest = 330;
    const cover = Math.round(Math.min(W - 48, Math.max(200, H - top - bottom - topbarH - rest)));
    const miniArea = miniH + 8 + bottom + 4;
    return {
      W,
      H,
      top,
      bottom,
      cover,
      topbarH,
      coverTop: top + topbarH + 8,
      miniH,
      miniMargin,
      collapsedTop: H - miniArea,
      miniArea,
      thumb: 48,
    };
  }, [W, H, insets.top, insets.bottom]);
}
