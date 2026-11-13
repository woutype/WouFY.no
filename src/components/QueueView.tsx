import React, { useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  Animated,
  FlatList,
  PanResponder,
  RefreshControl,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { LinearGradient } from 'expo-linear-gradient';
import { TrackFile } from '../types';
import { colors, type } from '../theme';
import { CoverArt, Glass, PressableScale } from './ui';

export const ROW_H = 68;

export type SortOption = 'default' | 'title' | 'artist' | 'album';
export type FilterTag = 'all' | 'lyrics' | 'lossless';

const SORT_LABELS: Record<SortOption, { label: string; icon: keyof typeof Ionicons.glyphMap }> = {
  default: { label: 'По умолчанию (очередь)', icon: 'reorder-two-outline' },
  title: { label: 'По названию (А–Я)', icon: 'text-outline' },
  artist: { label: 'По артисту (А–Я)', icon: 'person-outline' },
  album: { label: 'По альбому (номера)', icon: 'disc-outline' },
};

const FILTER_TAG_LABELS: Record<FilterTag, string> = {
  all: 'Все',
  lyrics: 'С текстом',
  lossless: 'Hi-Res / FLAC',
};

function getTrackNumber(t: TrackFile): number {
  if (t.trackNumber && !isNaN(t.trackNumber)) return t.trackNumber;
  const match = (t.title || t.filename).match(/^(\d+)[\.\s\-_]/);
  if (match) return parseInt(match[1], 10);
  return 999;
}

function applySort(list: TrackFile[], mode: SortOption): TrackFile[] {
  if (mode === 'default') return list;
  const copy = [...list];
  if (mode === 'title') {
    return copy.sort((a, b) => a.title.localeCompare(b.title, 'ru', { sensitivity: 'base' }));
  }
  if (mode === 'artist') {
    return copy.sort((a, b) => {
      const artA = (a.artist || 'Неизвестный исполнитель').trim();
      const artB = (b.artist || 'Неизвестный исполнитель').trim();
      const c = artA.localeCompare(artB, 'ru', { sensitivity: 'base' });
      if (c !== 0) return c;
      return a.title.localeCompare(b.title, 'ru', { sensitivity: 'base' });
    });
  }
  if (mode === 'album') {
    return copy.sort((a, b) => {
      const albA = (a.album || 'Сингл').trim();
      const albB = (b.album || 'Сингл').trim();
      const c = albA.localeCompare(albB, 'ru', { sensitivity: 'base' });
      if (c !== 0) return c;
      const numA = getTrackNumber(a);
      const numB = getTrackNumber(b);
      if (numA !== numB) return numA - numB;
      return a.title.localeCompare(b.title, 'ru', { sensitivity: 'base' });
    });
  }
  return copy;
}

interface RowProps {
  track: TrackFile;
  queueIndex: number;
  isCurrent: boolean;
  isPlaying: boolean;
  isPast: boolean;
  canDrag: boolean;
  shift: number; // -1, 0, 1 — сдвиг при перетаскивании соседа
  hasActiveDrag: boolean;
  dragging: boolean;
  dragY: Animated.Value;
  onPlay: (index: number, track: TrackFile) => void;
  onDragStart: (index: number) => void;
  onDragMove: (dy: number) => void;
  onDragEnd: () => void;
}

/** Индекс перетаскиваемой ячейки: нужен, чтобы поднять её НАД соседями */
const DragCtx = React.createContext<number>(-1);

const DragCell = (props: any) => {
  const dragIdx = useContext(DragCtx);
  const lifted = dragIdx >= 0 && dragIdx === props.index;
  return (
    <View onLayout={props.onLayout} style={[props.style, lifted && { zIndex: 999, elevation: 12 }]}>
      {props.children}
    </View>
  );
};

const QueueRow = React.memo(function QueueRow(p: RowProps) {
  const shiftAnim = useRef(new Animated.Value(0)).current;
  const scaleAnim = useRef(new Animated.Value(1)).current;

  // Плавный сдвиг строк без дерганий и рывков
  useLayoutEffect(() => {
    if (!p.hasActiveDrag) {
      shiftAnim.stopAnimation();
      shiftAnim.setValue(0);
      return;
    }
    Animated.spring(shiftAnim, {
      toValue: p.shift * ROW_H,
      damping: 24,
      stiffness: 240,
      mass: 0.5,
      useNativeDriver: true,
    }).start();
  }, [p.shift, p.hasActiveDrag, shiftAnim]);

  useEffect(() => {
    Animated.spring(scaleAnim, {
      toValue: p.dragging ? 1.025 : 1,
      damping: 20,
      stiffness: 220,
      mass: 0.5,
      useNativeDriver: true,
    }).start();
  }, [p.dragging, scaleAnim]);

  const cb = useRef(p);
  cb.current = p;
  const handlePan = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: (_, g) => Math.abs(g.dy) > 2,
      onPanResponderTerminationRequest: () => false,
      onPanResponderGrant: () => cb.current.onDragStart(cb.current.queueIndex),
      onPanResponderMove: (_, g) => cb.current.onDragMove(g.dy),
      onPanResponderRelease: () => cb.current.onDragEnd(),
      onPanResponderTerminate: () => cb.current.onDragEnd(),
    })
  ).current;

  return (
    <Animated.View
      style={[
        styles.row,
        p.dragging && styles.rowDragging,
        {
          transform: [{ translateY: p.dragging ? p.dragY : shiftAnim }, { scale: scaleAnim }],
        },
      ]}
    >
      <PressableScale onPress={() => cb.current.onPlay(cb.current.queueIndex, p.track)} scaleTo={0.98} style={styles.rowMain} haptic="light">
        <View style={{ opacity: p.isPast && !p.isCurrent ? 0.55 : 1 }}>
          <CoverArt uri={p.track.artworkUri} size={44} radius={10} />
          {p.isCurrent && (
            <View style={styles.playingBadge}>
              <Ionicons name={p.isPlaying ? 'volume-medium' : 'pause'} size={18} color={colors.text} />
            </View>
          )}
        </View>
        <View style={styles.rowText}>
          <Text style={[styles.rowTitle, p.isCurrent && { fontWeight: '800' }, p.isPast && !p.isCurrent && { color: colors.text2 }]} numberOfLines={1}>
            {p.track.title}
          </Text>
          <Text style={styles.rowArtist} numberOfLines={1}>
            {p.track.artist}{p.track.album ? ` · ${p.track.album}` : ''}
          </Text>
        </View>
      </PressableScale>
      {p.canDrag && (
        <View style={styles.handle} {...handlePan.panHandlers}>
          <Ionicons name="reorder-three" size={26} color={p.dragging ? colors.text : colors.text3} />
        </View>
      )}
    </Animated.View>
  );
});

interface Props {
  tracks: TrackFile[]; // очередь в порядке воспроизведения
  currentIndex: number;
  currentTrackId?: string;
  isPlaying: boolean;
  searchQuery: string;
  onSearchChange: (q: string) => void;
  onPlay: (index: number, track?: TrackFile) => void;
  onMove: (from: number, to: number) => void;
  onReorder?: (newTracks: TrackFile[]) => void;
  onRefresh: () => Promise<void>;
  bottomPad: number;
}

export const QueueView: React.FC<Props> = ({
  tracks,
  currentIndex,
  currentTrackId,
  isPlaying,
  searchQuery,
  onSearchChange,
  onPlay,
  onMove,
  onReorder,
  onRefresh,
  bottomPad,
}) => {
  const listRef = useRef<FlatList<{ track: TrackFile; qi: number }>>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [drag, setDrag] = useState<{ from: number; hover: number } | null>(null);
  const dragY = useRef(new Animated.Value(0)).current;
  const [sortMode, setSortMode] = useState<SortOption>('default');
  const [showFilterMenu, setShowFilterMenu] = useState(false);

  /**
   * Локальная копия очереди нужна, чтобы в момент «бросания» перестановка и сброс сдвигов
   * применились одним обновлением (атомарно) — иначе строки на кадр прыгают назад.
   */
  const [localTracks, setLocalTracks] = useState(tracks);
  useEffect(() => {
    if (!drag) setLocalTracks(tracks);
  }, [tracks, drag]);

  const [filterTag, setFilterTag] = useState<FilterTag>('all');
  const hasFilter = searchQuery.trim().length > 0 || filterTag !== 'all' || sortMode !== 'default';
  const filtering = hasFilter;

  const handleSelectSort = (mode: SortOption) => {
    Haptics.selectionAsync();
    setSortMode(mode);
    setShowFilterMenu(false);
    if (mode === 'default') {
      setLocalTracks(tracks);
      onReorder?.(tracks);
      return;
    }
    const sorted = applySort(tracks, mode);
    setLocalTracks(sorted);
    onReorder?.(sorted);
  };

  const handleReset = useCallback(() => {
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    onSearchChange('');
    setFilterTag('all');
    setSortMode('default');
    setLocalTracks(tracks);
    onReorder?.(tracks);
    setShowFilterMenu(false);
  }, [tracks, onSearchChange, onReorder]);

  const data = useMemo(() => {
    let list = localTracks;
    if (filterTag === 'lyrics') {
      list = list.filter((t) => Boolean(t.lyrics || t.syncedLyrics || t.lrcUri));
    } else if (filterTag === 'lossless') {
      list = list.filter((t) => ['flac', 'wav', 'aiff', 'aif'].includes((t.extension || '').toLowerCase()));
    }
    const q = searchQuery.trim().toLowerCase();
    if (q.length > 0) {
      list = list.filter(
        (t) =>
          t.title.toLowerCase().includes(q) ||
          t.artist.toLowerCase().includes(q) ||
          (t.album && t.album.toLowerCase().includes(q)) ||
          t.filename.toLowerCase().includes(q)
      );
    }
    return list.map((track, qi) => ({ track, qi }));
  }, [localTracks, searchQuery, filterTag]);

  // перетаскивание (только когда нет фильтра: позиции строк = индексы очереди)
  const scrollY = useRef(0);
  const dragInfo = useRef({ from: -1, startScroll: 0, dy: 0, hover: -1, listH: 600 });
  const autoScroll = useRef<ReturnType<typeof setInterval> | null>(null);
  const tracksLen = useRef(localTracks.length);
  tracksLen.current = localTracks.length;
  const cbs = useRef({ onMove, onPlay });
  cbs.current = { onMove, onPlay };

  const updateHover = useCallback(() => {
    const d = dragInfo.current;
    if (d.from < 0) return;
    const total = d.dy + (scrollY.current - d.startScroll);
    dragY.setValue(total);
    const hover = Math.max(0, Math.min(tracksLen.current - 1, Math.round(d.from + total / ROW_H)));
    if (hover !== d.hover) {
      d.hover = hover;
      Haptics.selectionAsync();
      setDrag({ from: d.from, hover });
    }
  }, [dragY]);

  const stopAuto = () => {
    if (autoScroll.current) clearInterval(autoScroll.current);
    autoScroll.current = null;
  };

  const onDragStart = useCallback(
    (from: number) => {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
      dragY.stopAnimation();
      dragY.setValue(0);
      dragInfo.current = { ...dragInfo.current, from, startScroll: scrollY.current, dy: 0, hover: from };
      setDrag({ from, hover: from });
    },
    [dragY]
  );

  const onDragMove = useCallback(
    (dy: number) => {
      const d = dragInfo.current;
      if (d.from < 0) return;
      d.dy = dy;
      updateHover();
      // автопрокрутка у краёв списка — один интервал, скорость плавно растёт к краю
      const visibleTop = d.from * ROW_H + dy - d.startScroll;
      let speed = 0;
      const zone = 70;
      if (visibleTop < zone) speed = -Math.min(16, 3 + ((zone - visibleTop) / zone) * 13);
      else if (visibleTop > d.listH - ROW_H - zone) speed = Math.min(16, 3 + ((visibleTop - (d.listH - ROW_H - zone)) / zone) * 13);
      if (speed === 0) {
        stopAuto();
        return;
      }
      stopAuto();
      autoScroll.current = setInterval(() => {
        const max = Math.max(0, tracksLen.current * ROW_H - d.listH + bottomPad);
        const next = Math.max(0, Math.min(max, scrollY.current + speed));
        if (next === scrollY.current) return;
        scrollY.current = next;
        listRef.current?.scrollToOffset({ offset: next, animated: false });
        updateHover();
      }, 16);
    },
    [updateHover, bottomPad]
  );

  const onDragEnd = useCallback(() => {
    stopAuto();
    const d = dragInfo.current;
    const { from, hover } = d;
    if (from < 0) return;
    dragInfo.current.from = -1;
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);

    const settle = { damping: 26, stiffness: 300, mass: 0.6, useNativeDriver: true } as const;
    if (hover === from || hover < 0) {
      Animated.spring(dragY, { toValue: 0, ...settle }).start(() => setDrag(null));
    } else {
      Animated.spring(dragY, { toValue: (hover - from) * ROW_H, ...settle }).start(() => {
        cbs.current.onMove(from, hover);
        setLocalTracks((prev) => {
          const next = [...prev];
          const [moved] = next.splice(from, 1);
          next.splice(hover, 0, moved);
          return next;
        });
        setSortMode('default');
        setDrag(null);
      });
    }
  }, [dragY]);

  useEffect(() => stopAuto, []);

  // при открытии прокручиваем к текущему треку
  useEffect(() => {
    if (!filtering && currentIndex > 2) {
      const t = setTimeout(() => listRef.current?.scrollToOffset({ offset: (currentIndex - 1) * ROW_H, animated: false }), 50);
      return () => clearTimeout(t);
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const currentTrackIndex = useMemo(
    () => (currentTrackId ? localTracks.findIndex((t) => t.id === currentTrackId) : currentIndex),
    [localTracks, currentTrackId, currentIndex]
  );

  const playAt = useCallback((i: number, track: TrackFile) => {
    cbs.current.onPlay(i, track);
  }, []);

  const renderItem = useCallback(
    ({ item }: { item: { track: TrackFile; qi: number } }) => {
      let shift = 0;
      if (drag) {
        if (drag.from < drag.hover && item.qi > drag.from && item.qi <= drag.hover) shift = -1;
        else if (drag.hover < drag.from && item.qi >= drag.hover && item.qi < drag.from) shift = 1;
      }
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
          shift={shift}
          hasActiveDrag={drag !== null}
          dragging={drag?.from === item.qi}
          dragY={dragY}
          onPlay={playAt}
          onDragStart={onDragStart}
          onDragMove={onDragMove}
          onDragEnd={onDragEnd}
        />
      );
    },
    [drag, currentTrackId, currentIndex, currentTrackIndex, isPlaying, filtering, dragY, playAt, onDragStart, onDragMove, onDragEnd]
  );

  const totalMin = Math.round(localTracks.length ? localTracks.length * 3.4 : 0);

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
                  placeholder="Поиск по названию, артисту, альбому"
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
          <PressableScale onPress={() => setShowFilterMenu((v) => !v)} hitSlop={6}>
            <View style={[styles.filterBtn, (sortMode !== 'default' || showFilterMenu) && styles.filterBtnActive]}>
              <Ionicons
                name="funnel-outline"
                size={17}
                color={(sortMode !== 'default' || showFilterMenu) ? colors.onAccent : colors.text}
              />
            </View>
          </PressableScale>
        </View>

        {/* Быстрые фильтр-чипы (Все / С текстом / FLAC) + Кнопка Сбросить */}
        <View style={styles.filterChipsRow}>
          {(['all', 'lyrics', 'lossless'] as const).map((tag) => {
            const active = filterTag === tag;
            return (
              <PressableScale
                key={tag}
                onPress={() => {
                  Haptics.selectionAsync();
                  setFilterTag(tag);
                }}
                scaleTo={0.94}
              >
                <View style={[styles.filterChip, active && styles.filterChipActive]}>
                  <Text style={[styles.filterChipText, active && styles.filterChipTextActive]}>
                    {FILTER_TAG_LABELS[tag]}
                  </Text>
                </View>
              </PressableScale>
            );
          })}
          {hasFilter && (
            <PressableScale onPress={handleReset} scaleTo={0.92} style={{ marginLeft: 'auto' }}>
              <View style={styles.resetBtn}>
                <Ionicons name="refresh-outline" size={13} color={colors.accent} />
                <Text style={styles.resetBtnText}>Сбросить</Text>
              </View>
            </PressableScale>
          )}
        </View>

        {showFilterMenu && (
          <Glass radius={16} style={styles.filterMenu}>
            <View style={styles.filterInner}>
              {(['title', 'artist', 'album', 'default'] as const).map((opt) => {
                const active = sortMode === opt;
                return (
                  <PressableScale key={opt} onPress={() => handleSelectSort(opt)}>
                    <View style={[styles.filterOption, active && styles.filterOptionActive]}>
                      <Ionicons
                        name={SORT_LABELS[opt].icon}
                        size={17}
                        color={active ? colors.onAccent : colors.text}
                      />
                      <Text style={[styles.filterOptionText, active && styles.filterOptionTextActive]}>
                        {SORT_LABELS[opt].label}
                      </Text>
                      {active && (
                        <Ionicons name="checkmark" size={16} color={colors.onAccent} style={{ marginLeft: 'auto' }} />
                      )}
                    </View>
                  </PressableScale>
                );
              })}
              {hasFilter && (
                <PressableScale onPress={handleReset}>
                  <View style={styles.resetMenuBtn}>
                    <Ionicons name="refresh-outline" size={15} color={colors.accent} />
                    <Text style={styles.resetMenuText}>Сбросить все фильтры и сортировку</Text>
                  </View>
                </PressableScale>
              )}
            </View>
          </Glass>
        )}

        <View style={styles.metaRow}>
          <Text style={styles.count}>
            {filtering ? `Найдено: ${data.length}` : `${localTracks.length} ${plural(localTracks.length)}${totalMin ? ` · ~${totalMin} мин` : ''}`}
          </Text>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
            {sortMode !== 'default' && (
              <PressableScale onPress={() => handleSelectSort('default')}>
                <View style={styles.activePill}>
                  <Text style={styles.activePillText}>{SORT_LABELS[sortMode].label}</Text>
                  <Ionicons name="close-circle" size={13} color={colors.text2} />
                </View>
              </PressableScale>
            )}
            {hasFilter && (
              <PressableScale onPress={handleReset}>
                <View style={styles.resetPill}>
                  <Ionicons name="close-circle" size={12} color={colors.text2} />
                  <Text style={styles.resetPillText}>Сбросить всё</Text>
                </View>
              </PressableScale>
            )}
          </View>
        </View>
      </View>

      <View style={{ flex: 1 }}>
      <DragCtx.Provider value={drag ? drag.from : -1}>
      <FlatList
        ref={listRef}
        data={data}
        keyExtractor={(i) => i.track.id}
        renderItem={renderItem}
        CellRendererComponent={DragCell}
        extraData={drag}
        getItemLayout={(_, i) => ({ length: ROW_H, offset: ROW_H * i, index: i })}
        scrollEnabled={!drag}
        initialNumToRender={14}
        windowSize={9}
        maxToRenderPerBatch={10}
        onScroll={(e) => {
          scrollY.current = e.nativeEvent.contentOffset.y;
          if (dragInfo.current.from >= 0) updateHover();
        }}
        scrollEventThrottle={16}
        onLayout={(e) => (dragInfo.current.listH = e.nativeEvent.layout.height)}
        contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: bottomPad }}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
        showsVerticalScrollIndicator={false}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            tintColor={colors.text2}
            onRefresh={async () => {
              setRefreshing(true);
              await onRefresh();
              setRefreshing(false);
            }}
          />
        }
        ListEmptyComponent={
          <View style={styles.empty}>
            <Ionicons name="musical-notes-outline" size={40} color={colors.text3} />
            <Text style={styles.emptyTitle}>{filtering ? 'Ничего не найдено' : 'Здесь пока пусто'}</Text>
            {!filtering && (
              <Text style={styles.emptyText}>
                Откройте «Файлы» → На iPhone → Woufy → Music и положите туда музыку или целую папку. Потяните список вниз, чтобы обновить.
              </Text>
            )}
          </View>
        }
      />
      </DragCtx.Provider>
      {/* мягкое растворение списка у краёв — без резкого обрезания строк */}
      <LinearGradient pointerEvents="none" colors={['rgba(8,8,8,0.85)', 'rgba(8,8,8,0)']} style={styles.fadeTop} />
      <LinearGradient pointerEvents="none" colors={['rgba(8,8,8,0)', 'rgba(8,8,8,0.85)']} style={[styles.fadeBottom, { height: Math.min(bottomPad, 96) }]} />
      </View>
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
  searchWrap: { paddingHorizontal: 16, paddingBottom: 8 },
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
  filterBtnActive: {
    backgroundColor: colors.accent,
    borderColor: colors.accent,
  },
  filterMenu: {
    marginTop: 8,
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.14)',
    overflow: 'hidden',
  },
  filterInner: { padding: 6, gap: 2 },
  filterOption: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 10,
    paddingHorizontal: 12,
    borderRadius: 10,
    gap: 10,
  },
  filterOptionActive: {
    backgroundColor: colors.accent,
  },
  filterOptionText: { ...type.body, fontSize: 14, color: colors.text, fontWeight: '500' },
  filterOptionTextActive: { color: colors.onAccent, fontWeight: '700' },
  resetMenuBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 10,
    paddingHorizontal: 12,
    borderRadius: 10,
    gap: 8,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.stroke,
    marginTop: 4,
  },
  resetMenuText: { ...type.body, fontSize: 13, color: colors.accent, fontWeight: '600' },
  filterChipsRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginTop: 10,
  },
  filterChip: {
    paddingVertical: 5,
    paddingHorizontal: 12,
    borderRadius: 12,
    backgroundColor: 'rgba(255, 255, 255, 0.06)',
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.1)',
  },
  filterChipActive: {
    backgroundColor: colors.accent,
    borderColor: colors.accent,
  },
  filterChipText: { ...type.caption, fontSize: 12, color: colors.text2, fontWeight: '600' },
  filterChipTextActive: { color: colors.onAccent, fontWeight: '700' },
  resetBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingVertical: 5,
    paddingHorizontal: 10,
    borderRadius: 12,
    backgroundColor: 'rgba(255, 255, 255, 0.08)',
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.16)',
  },
  resetBtnText: { ...type.caption, fontSize: 12, color: colors.accent, fontWeight: '700' },
  metaRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 10, paddingHorizontal: 4 },
  activePill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingVertical: 3,
    paddingHorizontal: 8,
    borderRadius: 10,
    backgroundColor: 'rgba(255,255,255,0.1)',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(255,255,255,0.2)',
  },
  activePillText: { ...type.caption, fontSize: 11, color: colors.text2, fontWeight: '600' },
  resetPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingVertical: 3,
    paddingHorizontal: 8,
    borderRadius: 10,
    backgroundColor: 'rgba(255,255,255,0.08)',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(255,255,255,0.18)',
  },
  resetPillText: { ...type.caption, fontSize: 11, color: colors.accent, fontWeight: '600' },
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
  rowDragging: {
    backgroundColor: 'rgba(255,255,255,0.09)',
    borderColor: 'rgba(255,255,255,0.22)',
  },
  fadeTop: { position: 'absolute', top: 0, left: 0, right: 0, height: 14 },
  fadeBottom: { position: 'absolute', bottom: 0, left: 0, right: 0 },
  rowMain: { flexDirection: 'row', alignItems: 'center', flex: 1, paddingVertical: 10 },
  rowText: { flex: 1, marginLeft: 12 },
  rowTitle: { ...type.headline, fontSize: 16, color: colors.text, fontWeight: '600' },
  rowArtist: { ...type.body, fontSize: 13, color: colors.text3, marginTop: 2 },
  playingBadge: {
    ...StyleSheet.absoluteFill,
    borderRadius: 10,
    backgroundColor: 'rgba(0,0,0,0.5)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  handle: { width: 48, height: ROW_H, alignItems: 'center', justifyContent: 'center' },
  empty: { alignItems: 'center', paddingTop: 60, paddingHorizontal: 32, gap: 10 },
  emptyTitle: { ...type.title, color: colors.text },
  emptyText: { ...type.body, color: colors.text2, textAlign: 'center', lineHeight: 21 },
});
