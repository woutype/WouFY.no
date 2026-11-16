import React, { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import { Animated, Easing, FlatList, LayoutAnimation, PanResponder, Pressable, RefreshControl, StyleSheet, Text, TextInput, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { LinearGradient } from 'expo-linear-gradient';
import { TrackFile } from '../types';
import { colors, type } from '../theme';
import { CoverArt, Glass, PressableScale } from './ui';
import { SortOption } from '../services/queueOrder';
import { LyricsSearchModal } from './LyricsSearchModal';

export type { SortOption };

export const ROW_H = 68;

const SORT_LABELS: Record<SortOption, { label: string; icon: keyof typeof Ionicons.glyphMap }> = {
  default: { label: 'По умолчанию', icon: 'reorder-two-outline' },
  recent: { label: 'Недавно добавленные', icon: 'time-outline' },
  title: { label: 'По названию (А–Я)', icon: 'text-outline' },
  artist: { label: 'По артисту', icon: 'person-outline' },
  album: { label: 'По альбому', icon: 'disc-outline' },
};

/* ───────── мини-эквалайзер на обложке играющего трека ───────── */

const EQ_BARS = [
  { lo: 0.25, hi: 0.95, up: 380, down: 330 },
  { lo: 0.2, hi: 0.75, up: 290, down: 420 },
  { lo: 0.3, hi: 1.0, up: 450, down: 300 },
  { lo: 0.22, hi: 0.8, up: 340, down: 380 },
];
const EQ_H = 16;

/** Чисто декоративная анимация: на воспроизведении столбики пляшут, на паузе плавно опускаются в точки */
const MiniEq: React.FC<{ playing: boolean }> = React.memo(({ playing }) => {
  const vals = useRef(EQ_BARS.map((b) => new Animated.Value(b.lo))).current;
  useEffect(() => {
    if (!playing) {
      const anims = vals.map((v) => Animated.timing(v, { toValue: 0.16, duration: 260, easing: Easing.out(Easing.cubic), useNativeDriver: true }));
      Animated.parallel(anims).start();
      return;
    }
    const loops = vals.map((v, i) => {
      const c = EQ_BARS[i];
      return Animated.loop(
        Animated.sequence([
          Animated.timing(v, { toValue: c.hi, duration: c.up, easing: Easing.inOut(Easing.sin), useNativeDriver: true }),
          Animated.timing(v, { toValue: c.lo, duration: c.down, easing: Easing.inOut(Easing.sin), useNativeDriver: true }),
        ])
      );
    });
    loops.forEach((l, i) => setTimeout(() => l.start(), i * 70));
    return () => loops.forEach((l) => l.stop());
  }, [playing, vals]);
  return (
    <View style={styles.eqRow}>
      {vals.map((v, i) => (
        <Animated.View
          key={i}
          style={{
            width: 3,
            height: EQ_H,
            borderRadius: 1.5,
            backgroundColor: '#fff',
            marginHorizontal: 1.5,
            transform: [{ translateY: EQ_H / 2 }, { scaleY: v }, { translateY: -EQ_H / 2 }],
          }}
        />
      ))}
    </View>
  );
});

/* ───────── строка очереди ───────── */

const RowContent: React.FC<{
  track: TrackFile;
  isCurrent: boolean;
  isPlaying: boolean;
  isPast: boolean;
}> = React.memo(({ track, isCurrent, isPlaying, isPast }) => (
  <>
    <View style={{ opacity: isPast && !isCurrent ? 0.55 : 1 }}>
      <CoverArt uri={track.artworkUri} size={44} radius={10} />
      {isCurrent && (
        <View style={styles.playingBadge}>
          <MiniEq playing={isPlaying} />
        </View>
      )}
    </View>
    <View style={styles.rowText}>
      <Text style={[styles.rowTitle, isCurrent && { fontWeight: '800' }, isPast && !isCurrent && { color: colors.text2 }]} numberOfLines={1}>
        {track.title}
      </Text>
      <Text style={styles.rowArtist} numberOfLines={1}>
        {track.artist}
        {track.album && track.album !== 'Сингл' ? ` · ${track.album}` : ''}
      </Text>
    </View>
  </>
));

interface RowProps {
  track: TrackFile;
  queueIndex: number;
  isCurrent: boolean;
  isPlaying: boolean;
  isPast: boolean;
  canDrag: boolean;
  /** строку сейчас несёт палец: вместо неё в списке пустое место, а сама она нарисована поверх (оверлей) */
  hidden: boolean;
  hasActiveDrag: boolean;
  onPlay: (index: number, track: TrackFile) => void;
  onDragStart: (index: number) => void;
  onDragMove: (dy: number) => void;
  onDragEnd: () => void;
}

const QueueRow = React.memo(function QueueRow(p: RowProps) {
  const cb = useRef(p);
  cb.current = p;
  const handlePan = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => cb.current.canDrag,
      onMoveShouldSetPanResponder: (_, g) => cb.current.canDrag && Math.abs(g.dy) > 2,
      onPanResponderTerminationRequest: () => false,
      onPanResponderGrant: () => cb.current.onDragStart(cb.current.queueIndex),
      onPanResponderMove: (_, g) => cb.current.onDragMove(g.dy),
      onPanResponderRelease: () => cb.current.onDragEnd(),
      onPanResponderTerminate: () => cb.current.onDragEnd(),
    })
  ).current;

  return (
    <View style={[styles.row, p.hidden && styles.rowHidden]}>
      <PressableScale
        onPress={() => cb.current.onPlay(cb.current.queueIndex, p.track)}
        scaleTo={0.98}
        style={styles.rowMain}
        haptic="light"
        disabled={p.hasActiveDrag}
      >
        <RowContent track={p.track} isCurrent={p.isCurrent} isPlaying={p.isPlaying} isPast={p.isPast} />
      </PressableScale>
      {p.canDrag && (
        <View style={styles.handle} {...handlePan.panHandlers} hitSlop={{ top: 8, bottom: 8, left: 12, right: 12 }}>
          <Ionicons name="reorder-three" size={26} color={colors.text3} />
        </View>
      )}
    </View>
  );
});

/* ───────── меню сортировки: плавное появление ───────── */

const SortMenu: React.FC<{
  visible: boolean;
  sortMode: SortOption;
  searchLyrics: boolean;
  onSelect: (m: SortOption) => void;
  onToggleSearchLyrics: () => void;
  onOpenLyricsSearch: () => void;
  onClose: () => void;
}> = ({ visible, sortMode, searchLyrics, onSelect, onToggleSearchLyrics, onOpenLyricsSearch, onClose }) => {
  const [mounted, setMounted] = useState(visible);
  const t = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (visible) {
      setMounted(true);
      Animated.spring(t, { toValue: 1, damping: 22, stiffness: 280, mass: 0.8, useNativeDriver: true }).start();
    } else {
      Animated.timing(t, { toValue: 0, duration: 180, easing: Easing.out(Easing.cubic), useNativeDriver: true }).start(({ finished }) => {
        if (finished) setMounted(false);
      });
    }
  }, [visible, t]);

  if (!mounted) return null;
  return (
    <>
      {/* прозрачная подложка: тап мимо закрывает меню */}
      <Animated.View style={[styles.menuBackdrop, { opacity: t }]}>
        <Pressable style={StyleSheet.absoluteFill} onPress={onClose} />
      </Animated.View>
      <Animated.View
        style={[
          styles.menuWrap,
          {
            opacity: t,
            transform: [
              { translateY: t.interpolate({ inputRange: [0, 1], outputRange: [-12, 0] }) },
              { scale: t.interpolate({ inputRange: [0, 1], outputRange: [0.90, 1] }) },
            ],
          },
        ]}
      >
        <Glass radius={18} intensity={70} style={styles.menuGlass}>
          <View style={styles.filterInner}>
            <Text style={styles.menuSectionTitle}>Сортировка</Text>
            {(['recent', 'title', 'artist', 'album', 'default'] as const).map((opt) => {
              const active = sortMode === opt;
              return (
                <PressableScale key={opt} onPress={() => onSelect(opt)} scaleTo={0.97} haptic="selection">
                  <View style={[styles.filterOption, active && styles.filterOptionActive]}>
                    <Ionicons name={SORT_LABELS[opt].icon} size={17} color={active ? colors.onAccent : colors.text} />
                    <Text style={[styles.filterOptionText, active && styles.filterOptionTextActive]}>{SORT_LABELS[opt].label}</Text>
                    {active && <Ionicons name="checkmark" size={16} color={colors.onAccent} style={{ marginLeft: 'auto' }} />}
                  </View>
                </PressableScale>
              );
            })}

            <View style={styles.menuDivider} />

            <Text style={styles.menuSectionTitle}>Поиск по тексту</Text>
            <PressableScale
              onPress={() => {
                onClose();
                onOpenLyricsSearch();
              }}
              scaleTo={0.97}
              haptic="medium"
            >
              <View style={styles.filterOption}>
                <Ionicons name="sparkles-outline" size={17} color={colors.accent} />
                <View style={{ flex: 1, paddingRight: 8 }}>
                  <Text style={[styles.filterOptionText, { color: colors.accent, fontWeight: '700' }]}>
                    Панель поиска в текстах
                  </Text>
                  <Text style={styles.filterOptionSub}>
                    Поиск фрагментов с подсветкой
                  </Text>
                </View>
                <Ionicons name="chevron-forward" size={15} color={colors.accent} />
              </View>
            </PressableScale>

            <PressableScale onPress={onToggleSearchLyrics} scaleTo={0.97} haptic="selection">
              <View style={[styles.filterOption, searchLyrics && styles.filterOptionActive]}>
                <Ionicons name="document-text-outline" size={17} color={searchLyrics ? colors.onAccent : colors.text} />
                <View style={{ flex: 1, paddingRight: 8 }}>
                  <Text style={[styles.filterOptionText, searchLyrics && styles.filterOptionTextActive]}>
                    Быстрый фильтр очереди
                  </Text>
                  <Text style={[styles.filterOptionSub, searchLyrics && styles.filterOptionSubActive]}>
                    Искать в строке поиска очереди
                  </Text>
                </View>
                <View style={[styles.toggleBox, searchLyrics && styles.toggleBoxActive]}>
                  {searchLyrics && <Ionicons name="checkmark" size={13} color="#FFFFFF" />}
                </View>
              </View>
            </PressableScale>
          </View>
        </Glass>
      </Animated.View>
    </>
  );
};

/* ───────── ползунок быстрой прокрутки ───────── */

const THUMB_H = 52;
const THUMB_TOP = 6;
const STRIP_W = 22;

interface BubbleHandle {
  show: (text: string, sub: string) => void;
  hide: () => void;
}

/** Плашка у ползунка: «N / всего» и название. Свой state — при перетаскивании не перерисовывается весь список */
const ScrollBubble = forwardRef<BubbleHandle, { y: Animated.Value }>(function ScrollBubble({ y }, ref) {
  const [txt, setTxt] = useState<{ a: string; b: string } | null>(null);
  useImperativeHandle(ref, () => ({
    show: (a, b) => setTxt({ a, b }),
    hide: () => setTxt(null),
  }));
  if (!txt) return null;
  return (
    <Animated.View pointerEvents="none" style={[styles.bubble, { transform: [{ translateY: y }] }]}>
      <Text style={styles.bubbleMain}>{txt.a}</Text>
      {txt.b ? (
        <Text style={styles.bubbleSub} numberOfLines={1}>
          {txt.b}
        </Text>
      ) : null}
    </Animated.View>
  );
});

/* ───────── экран очереди ───────── */

interface Props {
  tracks: TrackFile[]; // очередь в порядке воспроизведения
  currentIndex: number;
  currentTrackId?: string;
  isPlaying: boolean;
  searchQuery: string;
  onSearchChange: (q: string) => void;
  /** сортировка и поиск применяются к самой очереди (в движке), здесь только органы управления */
  sortMode: SortOption;
  onSortChange: (m: SortOption) => void;
  searchLyrics?: boolean;
  onSearchLyricsChange?: (v: boolean) => void;
  /** играющий трек не подходит под фильтр: он первый в очереди, но в списке не показывается */
  pinned: boolean;
  onPlay: (index: number, track?: TrackFile) => void;
  onPlayTrackWithSeek?: (track: TrackFile, seekTime?: number) => void;
  onMove: (from: number, to: number) => void;
  onRefresh: () => Promise<void>;
  bottomPad: number;
  scrollToCurrentTrigger?: number;
}

interface DragState {
  id: string;
}

export const QueueView: React.FC<Props> = ({
  tracks,
  currentIndex,
  currentTrackId,
  isPlaying,
  searchQuery,
  onSearchChange,
  sortMode,
  onSortChange,
  searchLyrics = false,
  onSearchLyricsChange,
  pinned,
  onPlay,
  onPlayTrackWithSeek,
  onMove,
  onRefresh,
  bottomPad,
  scrollToCurrentTrigger,
}) => {
  const listRef = useRef<FlatList<{ track: TrackFile; qi: number }>>(null);
  const [listH, setListH] = useState(600);
  const thumbY = useRef(new Animated.Value(THUMB_TOP)).current;
  const thumbOpacity = useRef(new Animated.Value(0)).current;
  const thumbShown = useRef(false);
  const thumbHideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scrollerDrag = useRef(false);
  const bubbleRef = useRef<BubbleHandle>(null);
  const guardUntil = useRef(0);
  const [refreshing, setRefreshing] = useState(false);
  const [drag, setDrag] = useState<DragState | null>(null);
  const [showFilterMenu, setShowFilterMenu] = useState(false);
  const [showLyricsSearch, setShowLyricsSearch] = useState(false);

  // Локальная копия очереди: перестановка и сброс сдвигов применяются одним обновлением
  const [localTracks, setLocalTracks] = useState(tracks);
  useEffect(() => {
    if (drag) return;
    const wait = guardUntil.current - Date.now();
    if (wait > 0) {
      const t = setTimeout(() => setLocalTracks(tracks), wait + 20);
      return () => clearTimeout(t);
    }
    setLocalTracks(tracks);
  }, [tracks, drag]);

  const sortActive = sortMode !== 'default';
  const filtering = searchQuery.trim().length > 0 || sortActive || searchLyrics;

  const handleSelectSort = (mode: SortOption) => {
    setShowFilterMenu(false);
    LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
    onSortChange(mode);
  };

  const handleReset = useCallback(() => {
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
    onSearchChange('');
    onSearchLyricsChange?.(false);
    setShowFilterMenu(false);
    if (sortMode !== 'default') onSortChange('default');
  }, [onSearchChange, onSearchLyricsChange, onSortChange, sortMode]);

  // очередь уже отфильтрована и отсортирована движком; закреплённый (не подходящий под фильтр) играющий трек не показываем
  const data = useMemo(() => {
    const out: { track: TrackFile; qi: number }[] = [];
    localTracks.forEach((track, qi) => {
      if (pinned && qi === 0) return;
      out.push({ track, qi });
    });
    return out;
  }, [localTracks, pinned]);

  /* ───────── перетаскивание ─────────
   * Схема без рассинхрона «нативная анимация ↔ перестановка списка» (из-за него трек на секунду «телепортировался» назад):
   *  • поднятая строка рисуется ОТДЕЛЬНЫМ оверлеем и следует за пальцем; на её месте в списке — пустая ячейка;
   *  • соседи расходятся «вживую»: порядок списка меняется на каждом шаге, а движение ячеек анимирует LayoutAnimation;
   *  • при отпускании оверлей садится ровно в свой слот, и только после этого — одним кадром — убирается (строка
   *    в списке уже стоит на месте), поэтому прыжков нет.
   */
  const scrollY = useRef(0);
  const dragInfo = useRef<{
    active: boolean;
    from: number;
    hover: number;
    startTop: number;
    dy: number;
    top: number;
    listH: number;
    base: TrackFile[];
  }>({ active: false, from: -1, hover: -1, startTop: 0, dy: 0, top: 0, listH: 600, base: [] });
  const overlayY = useRef(new Animated.Value(0)).current;
  const overlayScale = useRef(new Animated.Value(1)).current;
  const autoRaf = useRef<number | null>(null);
  const tracksLen = useRef(localTracks.length);
  tracksLen.current = localTracks.length;
  const localRef = useRef(localTracks);
  localRef.current = localTracks;
  const bottomRef = useRef(bottomPad);
  bottomRef.current = bottomPad;
  const cbs = useRef({ onMove, onPlay });
  cbs.current = { onMove, onPlay };
  const LIST_TOP = 4; // paddingTop списка

  const updateHover = useCallback(() => {
    const d = dragInfo.current;
    if (!d.active) return;
    const minTop = LIST_TOP - ROW_H * 0.4;
    const maxTop = d.listH - ROW_H * 0.6;
    const top = Math.max(minTop, Math.min(maxTop, d.startTop + d.dy));
    d.top = top;
    overlayY.setValue(top);

    const contentY = top + scrollY.current;
    const hover = Math.max(0, Math.min(tracksLen.current - 1, Math.round((contentY - LIST_TOP) / ROW_H)));
    if (hover !== d.hover) {
      d.hover = hover;
      Haptics.selectionAsync();
      LayoutAnimation.configureNext(LayoutAnimation.create(190, LayoutAnimation.Types.easeInEaseOut, LayoutAnimation.Properties.opacity));
      const next = [...d.base];
      const [mv] = next.splice(d.from, 1);
      next.splice(hover, 0, mv);
      setLocalTracks(next);
    }
  }, [overlayY]);

  /** Автопрокрутка у краёв (60 fps): скорость растёт плавно по мере приближения пальца к краю */
  const stopAuto = () => {
    if (autoRaf.current !== null) cancelAnimationFrame(autoRaf.current);
    autoRaf.current = null;
  };
  const startAuto = () => {
    if (autoRaf.current !== null) return;
    const ZONE = 96;
    const MAX_SPEED = 17;
    const loop = () => {
      const d = dragInfo.current;
      if (!d.active) {
        autoRaf.current = null;
        return;
      }
      const top = d.startTop + d.dy;
      const visibleH = d.listH - bottomRef.current * 0.8; // нижнюю часть закрывает мини-плеер
      let k = 0;
      if (top < ZONE) k = -Math.min(1, (ZONE - top) / ZONE);
      else if (top > visibleH - ROW_H - ZONE) k = Math.min(1, (top - (visibleH - ROW_H - ZONE)) / ZONE);
      if (k !== 0) {
        const eased = Math.sign(k) * Math.pow(Math.abs(k), 1.6);
        const maxScroll = Math.max(0, tracksLen.current * ROW_H + LIST_TOP + bottomRef.current - d.listH);
        const next = Math.max(0, Math.min(maxScroll, scrollY.current + eased * MAX_SPEED));
        if (next !== scrollY.current) {
          scrollY.current = next;
          listRef.current?.scrollToOffset({ offset: next, animated: false });
          updateHover();
        }
      }
      autoRaf.current = requestAnimationFrame(loop);
    };
    autoRaf.current = requestAnimationFrame(loop);
  };

  const onDragStart = useCallback(
    (from: number) => {
      const list = localRef.current;
      if (from < 0 || from >= list.length) return;
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
      const startTop = LIST_TOP + from * ROW_H - scrollY.current;
      dragInfo.current = { ...dragInfo.current, active: true, from, hover: from, startTop, dy: 0, top: startTop, base: list };
      overlayY.stopAnimation();
      overlayY.setValue(startTop);
      overlayScale.setValue(1);
      Animated.spring(overlayScale, { toValue: 1.03, damping: 20, stiffness: 320, mass: 0.5, useNativeDriver: true }).start();
      setDrag({ id: list[from].id });
      startAuto();
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [overlayY, overlayScale]
  );

  const onDragMove = useCallback(
    (dy: number) => {
      const d = dragInfo.current;
      if (!d.active) return;
      d.dy = dy;
      updateHover();
    },
    [updateHover]
  );

  const onDragEnd = useCallback(() => {
    stopAuto();
    const d = dragInfo.current;
    if (!d.active) return;
    d.active = false;
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    const { from, hover } = d;
    const finalTop = LIST_TOP + hover * ROW_H - scrollY.current;

    // Раньше оверлей убирался по окончании пружины (spring) — она «доезжает» до порога покоя 1–2 секунды,
    // поэтому рамка активного трека висела после отпускания. Теперь анимация посадки — короткая, с фиксированной
    // длительностью, а оверлей убирается строго по таймеру, независимо от того, как закончилась анимация.
    const currentTop = d.top; // положение оверлея под пальцем (обновляется в updateHover)
    const dist = Math.abs(finalTop - currentTop);
    const SETTLE_MS = dist < 2 ? 0 : Math.round(Math.min(150, 70 + dist * 0.45));

    let finished = false;
    const finalize = () => {
      if (finished) return;
      finished = true;
      guardUntil.current = Date.now() + 600; // не даём устаревшему списку из движка перебить порядок
      if (hover !== from) cbs.current.onMove(from, hover);
      setDrag(null); // оверлей исчезает, строка в списке на месте — один кадр, без прыжков
    };

    overlayScale.stopAnimation();
    overlayY.stopAnimation();
    if (SETTLE_MS === 0) {
      overlayScale.setValue(1);
      finalize();
      return;
    }
    Animated.timing(overlayScale, { toValue: 1, duration: SETTLE_MS, easing: Easing.out(Easing.cubic), useNativeDriver: true }).start();
    Animated.timing(overlayY, { toValue: finalTop, duration: SETTLE_MS, easing: Easing.out(Easing.cubic), useNativeDriver: true }).start();
    setTimeout(finalize, SETTLE_MS + 16);
  }, [overlayY, overlayScale]);

  useEffect(() => stopAuto, []);

  const dragTrack = useMemo(() => (drag ? localTracks.find((t) => t.id === drag.id) : undefined), [drag, localTracks]);

  /* ───────── ползунок: потянул вниз — пролистал до самого последнего трека ───────── */
  const contentH = LIST_TOP + data.length * ROW_H + bottomPad;
  const maxScroll = Math.max(0, contentH - listH);
  const travel = Math.max(1, listH - bottomPad - THUMB_H - THUMB_TOP * 2);
  const scrollable = data.length * ROW_H > listH * 1.5;
  const geo = useRef({ maxScroll, travel, n: data.length });
  geo.current = { maxScroll, travel, n: data.length };
  const dataRef = useRef(data);
  dataRef.current = data;
  const sortRef = useRef(sortMode);
  sortRef.current = sortMode;

  const showThumb = useCallback(() => {
    if (!thumbShown.current) {
      thumbShown.current = true;
      Animated.timing(thumbOpacity, { toValue: 1, duration: 120, useNativeDriver: true }).start();
    }
    if (thumbHideTimer.current) clearTimeout(thumbHideTimer.current);
    thumbHideTimer.current = setTimeout(() => {
      if (scrollerDrag.current) return;
      thumbShown.current = false;
      Animated.timing(thumbOpacity, { toValue: 0, duration: 260, useNativeDriver: true }).start();
    }, 1300);
  }, [thumbOpacity]);

  const syncThumb = useCallback(
    (y: number) => {
      const g = geo.current;
      const ratio = g.maxScroll > 0 ? Math.min(1, Math.max(0, y / g.maxScroll)) : 0;
      thumbY.setValue(THUMB_TOP + ratio * g.travel);
    },
    [thumbY]
  );

  const scrollerPan = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => true,
      onPanResponderTerminationRequest: () => false,
      onPanResponderGrant: (e) => {
        scrollerDrag.current = true;
        scrollerStart.current = e.nativeEvent.locationY;
        Haptics.selectionAsync();
        showThumb();
        moveScroller(0);
      },
      onPanResponderMove: (_, g) => moveScroller(g.dy),
      onPanResponderRelease: () => endScroller(),
      onPanResponderTerminate: () => endScroller(),
    })
  ).current;
  const scrollerStart = useRef(0);
  const lastBubbleIdx = useRef(-1);

  function moveScroller(dy: number) {
    const g = geo.current;
    const y = scrollerStart.current + dy;
    const ratio = Math.min(1, Math.max(0, (y - THUMB_TOP - THUMB_H / 2) / g.travel));
    const offset = ratio * g.maxScroll;
    scrollY.current = offset;
    thumbY.setValue(THUMB_TOP + ratio * g.travel);
    listRef.current?.scrollToOffset({ offset, animated: false });
    const idx = Math.min(g.n - 1, Math.max(0, Math.round(ratio * (g.n - 1))));
    if (idx !== lastBubbleIdx.current) {
      lastBubbleIdx.current = idx;
      const t = dataRef.current[idx]?.track;
      const mode = sortRef.current;
      const sub = t ? (mode === 'artist' ? t.artist : mode === 'album' ? t.album || 'Сингл' : t.title) : '';
      bubbleRef.current?.show(`${idx + 1} / ${g.n}`, sub);
    }
  }

  function endScroller() {
    scrollerDrag.current = false;
    lastBubbleIdx.current = -1;
    bubbleRef.current?.hide();
    showThumb(); // запускает таймер скрытия
  }

  // поиск изменился — список с начала; сортировка — к играющему треку
  useEffect(() => {
    listRef.current?.scrollToOffset({ offset: 0, animated: false });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchQuery]);
  useEffect(() => {
    if (sortMode === 'default') return;
    const i = data.findIndex((d) => d.track.id === currentTrackId);
    listRef.current?.scrollToOffset({ offset: Math.max(0, (i < 0 ? 0 : i - 1) * ROW_H), animated: false });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sortMode]);

  // переход в очередь по слайдеру: центрируем играющий трек
  useEffect(() => {
    if (!scrollToCurrentTrigger) return;
    const scrollTargetIdx = data.findIndex(
      (d) => (currentTrackId ? d.track.id === currentTrackId : d.qi === currentIndex)
    );
    if (scrollTargetIdx >= 0) {
      const targetOffset = Math.max(0, 4 + scrollTargetIdx * ROW_H - Math.max(0, (listH - ROW_H) / 2));
      scrollY.current = targetOffset;
      syncThumb(targetOffset);
      listRef.current?.scrollToOffset({ offset: targetOffset, animated: false });
      const t = setTimeout(() => {
        listRef.current?.scrollToOffset({ offset: targetOffset, animated: false });
      }, 50);
      return () => clearTimeout(t);
    }
  }, [scrollToCurrentTrigger]); // eslint-disable-line react-hooks/exhaustive-deps

  const currentTrackIndex = useMemo(
    () => (currentTrackId ? localTracks.findIndex((t) => t.id === currentTrackId) : currentIndex),
    [localTracks, currentTrackId, currentIndex]
  );

  const playAt = useCallback((i: number, track: TrackFile) => {
    cbs.current.onPlay(i, track);
  }, []);

  const renderItem = useCallback(
    ({ item }: { item: { track: TrackFile; qi: number } }) => {
      const isCurrent = currentTrackId ? item.track.id === currentTrackId : item.qi === currentIndex;
      const isPast = item.qi < (currentTrackIndex >= 0 ? currentTrackIndex : currentIndex);
      return (
        <QueueRow
          track={item.track}
          queueIndex={item.qi}
          isCurrent={isCurrent}
          isPlaying={isPlaying}
          isPast={isPast}
          canDrag={!filtering}
          hidden={drag?.id === item.track.id}
          hasActiveDrag={drag !== null}
          onPlay={playAt}
          onDragStart={onDragStart}
          onDragMove={onDragMove}
          onDragEnd={onDragEnd}
        />
      );
    },
    [drag, currentTrackId, currentIndex, currentTrackIndex, isPlaying, filtering, playAt, onDragStart, onDragMove, onDragEnd]
  );

  // Плавное появление блока «фильтр + сбросить»
  const chipAnim = useRef(new Animated.Value(sortActive ? 1 : 0)).current;
  useEffect(() => {
    Animated.timing(chipAnim, { toValue: sortActive ? 1 : 0, duration: 220, easing: Easing.out(Easing.cubic), useNativeDriver: true }).start();
  }, [sortActive, chipAnim]);

  const funnelActive = sortActive || searchLyrics || showFilterMenu;

  return (
    <View style={{ flex: 1 }}>
      <View style={styles.searchWrap}>
        <View style={styles.searchRow}>
          <View style={{ flex: 1 }}>
            <Glass radius={14} style={{ height: 40 }}>
              <View style={styles.searchInner}>
                <Ionicons name="search" size={16} color={colors.text3} />
                <TextInput
                  style={styles.searchInput}
                  placeholder={searchLyrics ? 'Поиск по строчке из текста…' : 'Поиск по названию, артисту, альбому'}
                  placeholderTextColor={colors.text3}
                  value={searchQuery}
                  onChangeText={onSearchChange}
                  autoCorrect={false}
                  returnKeyType="search"
                  selectionColor={colors.text}
                />
                {searchQuery.trim().length > 0 && (
                  <PressableScale onPress={() => onSearchChange('')} hitSlop={10}>
                    <Ionicons name="close-circle" size={18} color={colors.text3} />
                  </PressableScale>
                )}
              </View>
            </Glass>
          </View>
          <PressableScale onPress={() => setShowLyricsSearch(true)} hitSlop={6}>
            <View style={[styles.filterBtn, showLyricsSearch && styles.filterBtnActive]}>
              <Ionicons name="document-text-outline" size={17} color={showLyricsSearch ? colors.onAccent : colors.text} />
            </View>
          </PressableScale>
          <PressableScale onPress={() => setShowFilterMenu((v) => !v)} hitSlop={6}>
            <View style={[styles.filterBtn, funnelActive && styles.filterBtnActive]}>
              <Ionicons name="funnel-outline" size={17} color={funnelActive ? colors.onAccent : colors.text} />
            </View>
          </PressableScale>
        </View>

        <View style={styles.metaRow}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
            <Text style={styles.count}>
              {filtering ? `Найдено: ${data.length}` : `${localTracks.length} ${plural(localTracks.length)}`}
            </Text>
            {searchLyrics && (
              <View style={styles.lyricsPill}>
                <Ionicons name="document-text" size={11} color={colors.accent} />
                <Text style={styles.lyricsPillText}>В текстах</Text>
              </View>
            )}
          </View>
          <Animated.View
            pointerEvents={sortActive ? 'auto' : 'none'}
            style={[styles.metaRight, { opacity: chipAnim, transform: [{ translateX: chipAnim.interpolate({ inputRange: [0, 1], outputRange: [12, 0] }) }] }]}
          >
            <View style={styles.activePill}>
              <Text style={styles.activePillText} numberOfLines={1}>
                {SORT_LABELS[sortMode].label}
              </Text>
            </View>
            <PressableScale onPress={handleReset} scaleTo={0.92}>
              <View style={styles.resetBtn}>
                <Ionicons name="close" size={13} color={colors.accent} />
                <Text style={styles.resetBtnText}>Сбросить</Text>
              </View>
            </PressableScale>
          </Animated.View>
        </View>
      </View>

      <View style={styles.dividerWrap} pointerEvents="none">
        <LinearGradient
          start={{ x: 0, y: 0 }}
          end={{ x: 1, y: 0 }}
          colors={['rgba(255,255,255,0)', 'rgba(255,255,255,0.15)', 'rgba(255,255,255,0)']}
          style={styles.divider}
        />
      </View>

      <View style={{ flex: 1 }}>
          <FlatList
            ref={listRef}
            data={data}
            keyExtractor={(i) => i.track.id}
            renderItem={renderItem}
            extraData={drag}
            getItemLayout={(_, i) => ({ length: ROW_H, offset: ROW_H * i, index: i })}
            scrollEnabled={!drag}
            initialNumToRender={16}
            windowSize={7}
            maxToRenderPerBatch={12}
            updateCellsBatchingPeriod={30}
            removeClippedSubviews={false}
            onScroll={(e) => {
              scrollY.current = e.nativeEvent.contentOffset.y;
              if (dragInfo.current.from >= 0) updateHover();
              if (!scrollerDrag.current && scrollable) {
                syncThumb(scrollY.current);
                showThumb();
              }
            }}
            scrollEventThrottle={16}
            onLayout={(e) => {
              dragInfo.current.listH = e.nativeEvent.layout.height;
              setListH(e.nativeEvent.layout.height);
            }}
            contentContainerStyle={{ paddingHorizontal: 16, paddingTop: 4, paddingBottom: bottomPad }}
            keyboardShouldPersistTaps="handled"
            keyboardDismissMode="on-drag"
            showsVerticalScrollIndicator={false}
            refreshControl={
              <RefreshControl
                refreshing={refreshing}
                tintColor={colors.text2}
                onRefresh={async () => {
                  setRefreshing(true);
                  try {
                    await onRefresh();
                  } finally {
                    setRefreshing(false);
                  }
                }}
              />
            }
            ListEmptyComponent={
              <View style={styles.empty}>
                <Ionicons name="musical-notes-outline" size={40} color={colors.text3} />
                <Text style={styles.emptyTitle}>{filtering ? 'Ничего не найдено' : 'Здесь пока пусто'}</Text>
                {!filtering && (
                  <Text style={styles.emptyText}>
                    Откройте «Файлы» → На iPhone → WouFY.no → Music и положите туда музыку или целую папку. Потяните список вниз, чтобы обновить.
                  </Text>
                )}
              </View>
            }
          />
        {drag && dragTrack && (
          <Animated.View
            pointerEvents="none"
            style={[styles.overlayRow, { transform: [{ translateY: overlayY }, { scale: overlayScale }] }]}
          >
            <View style={styles.rowMain}>
              <RowContent
                track={dragTrack}
                isCurrent={dragTrack.id === currentTrackId}
                isPlaying={isPlaying}
                isPast={false}
              />
            </View>
            <View style={styles.handle}>
              <Ionicons name="reorder-three" size={26} color={colors.text} />
            </View>
          </Animated.View>
        )}
        <LinearGradient
          pointerEvents="none"
          colors={['rgba(8,8,8,0)', 'rgba(8,8,8,0.85)']}
          style={[styles.fadeBottom, { height: Math.min(bottomPad, 96) }]}
        />
        {/* ползунок быстрой прокрутки: тянем вдоль правого края — список едет до самого последнего трека */}
        {scrollable && !drag && (
          <>
            <Animated.View pointerEvents="none" style={[styles.thumb, { opacity: thumbOpacity, transform: [{ translateY: thumbY }] }]} />
            <View style={[styles.scrollStrip, { height: Math.max(0, listH - bottomPad + 8) }]} {...scrollerPan.panHandlers} />
            <ScrollBubble ref={bubbleRef} y={thumbY} />
          </>
        )}
        <LyricsSearchModal
          visible={showLyricsSearch}
          tracks={tracks}
          onSelectTrack={(track, seekTime) => {
            setShowLyricsSearch(false);
            if (onPlayTrackWithSeek) {
              onPlayTrackWithSeek(track, seekTime);
            } else {
              onPlay(-1, track);
            }
          }}
          onClose={() => setShowLyricsSearch(false)}
        />
      </View>

      {/* меню сортировки: крепится ровно под кнопкой фильтра с отступом 6px */}
      <SortMenu
        visible={showFilterMenu}
        sortMode={sortMode}
        searchLyrics={searchLyrics}
        onSelect={handleSelectSort}
        onToggleSearchLyrics={() => onSearchLyricsChange?.(!searchLyrics)}
        onOpenLyricsSearch={() => setShowLyricsSearch(true)}
        onClose={() => setShowFilterMenu(false)}
      />
    </View>
  );
};

function plural(n: number) {
  const a = n % 10;
  const b = n % 100;
  if (a === 1 && b !== 11) return 'трек';
  if (a >= 2 && a <= 4 && (b < 12 || b > 14)) return 'трека';
  return 'треков';
}

const styles = StyleSheet.create({
  searchWrap: { paddingHorizontal: 16, paddingBottom: 4 },
  searchRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  searchInner: { flex: 1, flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12, gap: 8 },
  searchInput: { flex: 1, color: colors.text, fontSize: 15, paddingVertical: 0 },
  filterBtn: {
    width: 40,
    height: 40,
    borderRadius: 14,
    backgroundColor: 'rgba(255, 255, 255, 0.08)',
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.15)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  filterBtnActive: { backgroundColor: colors.accent, borderColor: colors.accent },
  menuBackdrop: { position: 'absolute', top: -300, left: -100, right: -100, bottom: -1000, zIndex: 90 },
  menuWrap: {
    position: 'absolute',
    top: 46,
    right: 16,
    width: 260,
    zIndex: 100,
    transformOrigin: 'top right',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 12 },
    shadowOpacity: 0.5,
    shadowRadius: 24,
    elevation: 12,
  },
  menuGlass: { borderWidth: 1, borderColor: 'rgba(255, 255, 255, 0.16)' },
  filterInner: { padding: 6, gap: 2 },
  filterOption: { flexDirection: 'row', alignItems: 'center', paddingVertical: 11, paddingHorizontal: 12, borderRadius: 12, gap: 10 },
  filterOptionActive: { backgroundColor: colors.accent },
  filterOptionText: { ...type.body, fontSize: 14, color: colors.text, fontWeight: '500' },
  filterOptionTextActive: { color: colors.onAccent, fontWeight: '700' },
  menuSectionTitle: {
    ...type.caption,
    fontSize: 10,
    fontWeight: '700',
    color: colors.text3,
    textTransform: 'uppercase',
    paddingHorizontal: 12,
    paddingTop: 6,
    paddingBottom: 2,
    letterSpacing: 0.5,
  },
  menuDivider: {
    height: 1,
    backgroundColor: 'rgba(255, 255, 255, 0.1)',
    marginVertical: 4,
  },
  filterOptionSub: {
    ...type.caption,
    fontSize: 10,
    color: colors.text3,
    marginTop: 2,
    fontWeight: '500',
  },
  filterOptionSubActive: {
    color: 'rgba(8, 8, 8, 0.60)',
    fontWeight: '500',
  },
  toggleBox: {
    width: 20,
    height: 20,
    borderRadius: 6,
    borderWidth: 1.5,
    borderColor: 'rgba(255, 255, 255, 0.35)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  toggleBoxActive: {
    borderColor: '#080808',
    backgroundColor: '#080808',
  },
  lyricsPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingVertical: 3,
    paddingHorizontal: 7,
    borderRadius: 10,
    backgroundColor: 'rgba(255, 255, 255, 0.12)',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(255, 255, 255, 0.25)',
  },
  lyricsPillText: {
    ...type.caption,
    fontSize: 11,
    color: colors.text,
    fontWeight: '700',
  },
  metaRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 10, paddingHorizontal: 4, minHeight: 28 },
  metaRight: { flexDirection: 'row', alignItems: 'center', gap: 8, flexShrink: 1 },
  activePill: {
    paddingVertical: 4,
    paddingHorizontal: 10,
    borderRadius: 12,
    backgroundColor: 'rgba(255,255,255,0.1)',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(255,255,255,0.2)',
    flexShrink: 1,
  },
  activePillText: { ...type.caption, fontSize: 12, color: colors.text, fontWeight: '600' },
  resetBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingVertical: 4,
    paddingHorizontal: 10,
    borderRadius: 12,
    backgroundColor: 'rgba(255, 255, 255, 0.08)',
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.16)',
  },
  resetBtnText: { ...type.caption, fontSize: 12, color: colors.accent, fontWeight: '700' },
  count: { ...type.caption, color: colors.text3, marginLeft: 2 },
  row: {
    height: ROW_H,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 8,
    borderRadius: 16,
    borderWidth: 1.5,
    borderColor: 'transparent',
  },
  rowHidden: { opacity: 0 },
  overlayRow: {
    position: 'absolute',
    left: 16,
    right: 16,
    top: 0,
    height: ROW_H,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 8,
    borderRadius: 16,
    borderWidth: 1.5,
    backgroundColor: 'rgba(40,40,44,0.96)',
    borderColor: 'rgba(255,255,255,0.28)',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.4,
    shadowRadius: 14,
    elevation: 14,
    zIndex: 50,
  },
  thumb: { position: 'absolute', top: 0, right: 5, width: 5, height: THUMB_H, borderRadius: 3, backgroundColor: 'rgba(255,255,255,0.55)', zIndex: 15 },
  scrollStrip: { position: 'absolute', top: 0, right: 0, width: STRIP_W, zIndex: 16 },
  bubble: {
    position: 'absolute',
    top: 0,
    right: 30,
    minWidth: 90,
    maxWidth: 220,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 14,
    backgroundColor: 'rgba(40,40,44,0.96)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.2)',
    zIndex: 17,
  },
  bubbleMain: { ...type.mono, color: colors.text, fontSize: 13, fontWeight: '700' },
  bubbleSub: { ...type.caption, color: colors.text2, fontSize: 11, marginTop: 2 },
  eqRow: { flexDirection: 'row', alignItems: 'flex-end', justifyContent: 'center', height: EQ_H },
  dividerWrap: { paddingHorizontal: 20, paddingTop: 8, paddingBottom: 4 },
  divider: { height: 1, width: '100%' },
  fadeBottom: { position: 'absolute', bottom: 0, left: 0, right: 0 },
  rowMain: { flexDirection: 'row', alignItems: 'center', flex: 1, paddingVertical: 10 },
  rowText: { flex: 1, marginLeft: 12 },
  rowTitle: { ...type.headline, fontSize: 16, color: colors.text, fontWeight: '600' },
  rowArtist: { ...type.body, fontSize: 13, color: colors.text3, marginTop: 2 },
  playingBadge: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, borderRadius: 10, backgroundColor: 'rgba(0,0,0,0.42)', alignItems: 'center', justifyContent: 'center' },
  handle: { width: 48, height: ROW_H, alignItems: 'center', justifyContent: 'center' },
  empty: { alignItems: 'center', paddingTop: 60, paddingHorizontal: 32, gap: 10 },
  emptyTitle: { ...type.title, color: colors.text },
  emptyText: { ...type.body, color: colors.text2, textAlign: 'center', lineHeight: 21 },
});
