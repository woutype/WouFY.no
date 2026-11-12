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

interface RowProps {
  track: TrackFile;
  queueIndex: number;
  isCurrent: boolean;
  isPlaying: boolean;
  isPast: boolean;
  canDrag: boolean;
  shift: number; // -1, 0, 1 — сдвиг при перетаскивании соседа
  dragging: boolean;
  dragY: Animated.Value;
  onPress: () => void;
  onDragStart: (index: number) => void;
  onDragMove: (dy: number) => void;
  onDragEnd: () => void;
}

const QueueRow = React.memo(function QueueRow(p: RowProps) {
  const shiftAnim = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (p.shift === 0) {
      shiftAnim.setValue(0);
    } else {
      Animated.timing(shiftAnim, { toValue: p.shift * ROW_H, duration: 140, useNativeDriver: true }).start();
    }
  }, [p.shift, shiftAnim]);

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
            { scale: p.dragging ? 1.02 : 1 },
          ],
          zIndex: p.dragging ? 99 : 0,
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
  isPlaying: boolean;
  searchQuery: string;
  onSearchChange: (q: string) => void;
  onPlay: (index: number) => void;
  onMove: (from: number, to: number) => void;
  onRefresh: () => Promise<void>;
  bottomPad: number;
}

export const QueueView: React.FC<Props> = ({
  tracks,
  currentIndex,
  isPlaying,
  searchQuery,
  onSearchChange,
  onPlay,
  onMove,
  onRefresh,
  bottomPad,
}) => {
  const listRef = useRef<FlatList<{ track: TrackFile; qi: number }>>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [drag, setDrag] = useState<{ from: number; hover: number } | null>(null);
  const dragY = useRef(new Animated.Value(0)).current;

  const [localTracks, setLocalTracks] = useState(tracks);
  useEffect(() => {
    if (!drag) setLocalTracks(tracks);
  }, [tracks, drag]);

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
    if (hover === from) {
      Animated.timing(dragY, { toValue: 0, duration: 80, useNativeDriver: true }).start(() => {
        setDrag(null);
      });
    } else {
      Animated.timing(dragY, { toValue: (hover - from) * ROW_H, duration: 80, useNativeDriver: true }).start(() => {
        setLocalTracks((prev) => {
          const next = [...prev];
          const [moved] = next.splice(from, 1);
          next.splice(hover, 0, moved);
          return next;
        });
        dragY.setValue(0);
        setDrag(null);
        onMove(from, hover);
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

  const renderItem = ({ item }: { item: { track: TrackFile; qi: number } }) => {
    let shift = 0;
    if (drag) {
      if (drag.from < drag.hover && item.qi > drag.from && item.qi <= drag.hover) shift = -1;
      else if (drag.hover < drag.from && item.qi >= drag.hover && item.qi < drag.from) shift = 1;
    }
    return (
      <QueueRow
        track={item.track}
        queueIndex={item.qi}
        isCurrent={item.qi === currentIndex}
        isPlaying={isPlaying}
        isPast={item.qi < currentIndex}
        canDrag={!filtering}
        shift={shift}
        dragging={drag?.from === item.qi}
        dragY={dragY}
        onPress={() => onPlay(item.qi)}
        onDragStart={onDragStart}
        onDragMove={onDragMove}
        onDragEnd={onDragEnd}
      />
    );
  };

  const totalMin = Math.round(tracks.length ? tracks.length * 3.4 : 0);

  return (
    <View style={{ flex: 1 }}>
      <View style={styles.searchWrap}>
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
        <Text style={styles.count}>
          {filtering ? `Найдено: ${data.length}` : `${tracks.length} ${plural(tracks.length)}${totalMin ? ` · ~${totalMin} мин` : ''}`}
        </Text>
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
  searchInner: { flex: 1, flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12, gap: 8 },
  searchInput: { flex: 1, color: colors.text, fontSize: 15, paddingVertical: 0 },
  count: { ...type.caption, color: colors.text3, marginTop: 8, marginLeft: 4 },
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
