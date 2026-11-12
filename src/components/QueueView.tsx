import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
import { TrackFile } from '../types';
import { colors, type } from '../theme';
import { CoverArt, Glass, PressableScale } from './ui';

export const ROW_H = 68;

export type SortOption = 'default' | 'date' | 'album' | 'artist';

const SORT_LABELS: Record<SortOption, { label: string; icon: keyof typeof Ionicons.glyphMap }> = {
  default: { label: 'По умолчанию', icon: 'reorder-two-outline' },
  date: { label: 'Дата добавления', icon: 'calendar-outline' },
  album: { label: 'Альбом (по номерам)', icon: 'disc-outline' },
  artist: { label: 'Артист', icon: 'person-outline' },
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
  if (mode === 'date') {
    return copy.sort((a, b) => (b.mtime ?? 0) - (a.mtime ?? 0));
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
  if (mode === 'artist') {
    return copy.sort((a, b) => {
      const artA = (a.artist || 'Неизвестный исполнитель').trim();
      const artB = (b.artist || 'Неизвестный исполнитель').trim();
      const c = artA.localeCompare(artB, 'ru', { sensitivity: 'base' });
      if (c !== 0) return c;
      const albA = (a.album || 'Сингл').trim();
      const albB = (b.album || 'Сингл').trim();
      const c2 = albA.localeCompare(albB, 'ru', { sensitivity: 'base' });
      if (c2 !== 0) return c2;
      return getTrackNumber(a) - getTrackNumber(b);
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
  onPress: () => void;
  onDragStart: (index: number) => void;
  onDragMove: (dy: number) => void;
  onDragEnd: () => void;
}

const QueueRow = React.memo(function QueueRow(p: RowProps) {
  const shiftAnim = useRef(new Animated.Value(0)).current;
  const scaleAnim = useRef(new Animated.Value(1)).current;

  useEffect(() => {
    if (!p.hasActiveDrag) {
      shiftAnim.setValue(0);
    } else {
      Animated.timing(shiftAnim, {
        toValue: p.shift * ROW_H,
        duration: 110,
        useNativeDriver: true,
      }).start();
    }
  }, [p.shift, p.hasActiveDrag, shiftAnim]);

  useEffect(() => {
    Animated.spring(scaleAnim, {
      toValue: p.dragging ? 1.025 : 1,
      damping: 22,
      stiffness: 280,
      mass: 0.7,
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
          transform: [
            { translateY: p.dragging ? p.dragY : shiftAnim },
            { scale: scaleAnim },
          ],
          zIndex: p.dragging ? 999 : 1,
        },
      ]}
    >
      <PressableScale onPress={p.onPress} scaleTo={0.98} style={styles.rowMain} haptic="light">
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
          <Ionicons name="reorder-three" size={26} color={colors.text3} />
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
  onPlay: (index: number) => void;
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

  const isReorderingRef = useRef(false);
  const [localTracks, setLocalTracks] = useState(tracks);

  useEffect(() => {
    if (isReorderingRef.current) {
      isReorderingRef.current = false;
      return;
    }
    if (!drag) setLocalTracks(sortMode === 'default' ? tracks : applySort(tracks, sortMode));
  }, [tracks, drag, sortMode]);

  const handleSelectSort = (mode: SortOption) => {
    Haptics.selectionAsync();
    setSortMode(mode);
    setShowFilterMenu(false);
    const sorted = applySort(tracks, mode);
    setLocalTracks(sorted);
    onReorder?.(sorted);
  };

  const filtering = searchQuery.trim().length > 0;
  const data = useMemo(() => {
    const items = localTracks.map((track, qi) => ({ track, qi }));
    if (!filtering) return items;
    const q = searchQuery.toLowerCase();
    return items.filter(
      ({ track: t }) =>
        t.title.toLowerCase().includes(q) || t.artist.toLowerCase().includes(q) || t.filename.toLowerCase().includes(q)
    );
  }, [localTracks, searchQuery, filtering]);

  // перетаскивание (только когда нет фильтра: позиции строк = индексы очереди)
  const scrollY = useRef(0);
  const dragInfo = useRef({ from: -1, startScroll: 0, dy: 0, hover: -1, listH: 600 });
  const autoScroll = useRef<ReturnType<typeof setInterval> | null>(null);
  const tracksLen = useRef(localTracks.length);
  tracksLen.current = localTracks.length;

  const updateHover = useCallback(() => {
    const d = dragInfo.current;
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
      dragInfo.current = { ...dragInfo.current, from, startScroll: scrollY.current, dy: 0, hover: from };
      dragY.setValue(0);
      setDrag({ from, hover: from });
    },
    [dragY]
  );

  const onDragMove = useCallback(
    (dy: number) => {
      const d = dragInfo.current;
      d.dy = dy;
      updateHover();
      // автопрокрутка у краёв списка
      const visibleTop = d.from * ROW_H + dy - d.startScroll; // позиция строки в окне списка
      stopAuto();
      let speed = 0;
      if (visibleTop < 40) speed = -10;
      else if (visibleTop > d.listH - ROW_H - 40) speed = 10;
      if (speed !== 0) {
        autoScroll.current = setInterval(() => {
          const max = Math.max(0, tracksLen.current * ROW_H - d.listH + bottomPad);
          const next = Math.max(0, Math.min(max, scrollY.current + speed));
          if (next === scrollY.current) return;
          scrollY.current = next;
          listRef.current?.scrollToOffset({ offset: next, animated: false });
          updateHover();
        }, 16);
      }
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

    if (hover === from || hover < 0) {
      Animated.timing(dragY, { toValue: 0, duration: 100, useNativeDriver: true }).start(() => {
        setDrag(null);
      });
    } else {
      Animated.timing(dragY, { toValue: (hover - from) * ROW_H, duration: 110, useNativeDriver: true }).start(() => {
        isReorderingRef.current = true;
        // 1. Синхронно обновляем очередь в движке
        onMove(from, hover);
        // 2. В том же тике обновляем локальный список без задержек и гонок
        setLocalTracks((prev) => {
          const next = [...prev];
          const [moved] = next.splice(from, 1);
          next.splice(hover, 0, moved);
          return next;
        });
        setSortMode('default');
        dragY.setValue(0);
        setDrag(null);
      });
    }
  }, [dragY, onMove]);

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

  const renderItem = ({ item }: { item: { track: TrackFile; qi: number } }) => {
    let shift = 0;
    if (drag) {
      if (drag.from < drag.hover && item.qi > drag.from && item.qi <= drag.hover) shift = -1;
      else if (drag.hover < drag.from && item.qi >= drag.hover && item.qi < drag.from) shift = 1;
    }
    const isCurrent = currentTrackId
      ? item.track.id === currentTrackId
      : item.qi === currentIndex;
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
        onPress={() => onPlay(item.qi)}
        onDragStart={onDragStart}
        onDragMove={onDragMove}
        onDragEnd={onDragEnd}
      />
    );
  };

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
                  placeholder="Поиск по названию и исполнителю"
                  placeholderTextColor={colors.text3}
                  value={searchQuery}
                  onChangeText={onSearchChange}
                  autoCorrect={false}
                  returnKeyType="search"
                  selectionColor={colors.text}
                />
                {filtering && (
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

        {showFilterMenu && (
          <Glass radius={16} style={styles.filterMenu}>
            <View style={styles.filterInner}>
              {(['date', 'album', 'artist', 'default'] as const).map((opt) => {
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
            </View>
          </Glass>
        )}

        <View style={styles.metaRow}>
          <Text style={styles.count}>
            {filtering ? `Найдено: ${data.length}` : `${localTracks.length} ${plural(localTracks.length)}${totalMin ? ` · ~${totalMin} мин` : ''}`}
          </Text>
          {sortMode !== 'default' && (
            <PressableScale onPress={() => handleSelectSort('default')}>
              <View style={styles.activePill}>
                <Text style={styles.activePillText}>{SORT_LABELS[sortMode].label}</Text>
                <Ionicons name="close-circle" size={13} color={colors.text2} />
              </View>
            </PressableScale>
          )}
        </View>
      </View>

      <FlatList
        ref={listRef}
        data={data}
        keyExtractor={(i) => i.track.id}
        renderItem={renderItem}
        extraData={drag}
        getItemLayout={(_, i) => ({ length: ROW_H, offset: ROW_H * i, index: i })}
        scrollEnabled={!drag}
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
    backgroundColor: colors.glass,
    borderWidth: StyleSheet.hairlineWidth * 2,
    borderColor: colors.stroke,
    alignItems: 'center',
    justifyContent: 'center',
  },
  filterBtnActive: {
    backgroundColor: colors.accent,
    borderColor: colors.accent,
  },
  filterMenu: {
    marginTop: 8,
    borderWidth: StyleSheet.hairlineWidth * 2,
    borderColor: colors.stroke,
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
  metaRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 8, paddingHorizontal: 4 },
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
    backgroundColor: 'rgba(255,255,255,0.06)',
    borderColor: 'rgba(255,255,255,0.45)',
    shadowColor: '#FFFFFF',
    shadowOpacity: 0.2,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: 2 },
  },
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
