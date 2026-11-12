import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Animated, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { AudioEngine } from '../services/audioEngine';
import { TrackFile } from '../types';
import { LyricLine, LyricsData, activeLineIndex, isSectionLine, loadLyrics, saveLrc, shiftLyricsOffset } from '../services/lyrics';
import { usePosition } from '../hooks/useAudioController';
import { colors, formatTime, type } from '../theme';
import { Glass, PressableScale } from './ui';

const savedCache = new Map<string, LyricsData>();

const LyricRow = React.memo(function LyricRow(p: {
  line: LyricLine;
  active: boolean;
  past: boolean;
  onPress: () => void;
  onLayoutY: (y: number, h: number) => void;
}) {
  const a = useRef(new Animated.Value(p.active ? 1 : 0)).current;
  useEffect(() => {
    Animated.spring(a, { toValue: p.active ? 1 : 0, useNativeDriver: true, damping: 22, stiffness: 240, mass: 0.7 }).start();
  }, [p.active, a]);
  return (
    <Pressable onPress={p.onPress} onLayout={(e) => p.onLayoutY(e.nativeEvent.layout.y, e.nativeEvent.layout.height)}>
      <Animated.Text
        style={[
          p.line.section ? styles.section : styles.line,
          {
            opacity: a.interpolate({ inputRange: [0, 1], outputRange: [p.past ? 0.32 : 0.45, 1] }),
            transform: [{ scale: a.interpolate({ inputRange: [0, 1], outputRange: [0.95, 1.04] }) }],
          },
        ]}
      >
        {p.line.text}
      </Animated.Text>
    </Pressable>
  );
});

interface Props {
  engine: AudioEngine;
  track: TrackFile | undefined;
  duration: number;
  isPlaying: boolean;
  bottomPad: number;
  onSaved: () => void;
}

export const LyricsView: React.FC<Props> = ({ engine, track, duration, isPlaying, bottomPad, onSaved }) => {
  const [data, setData] = useState<LyricsData | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [searching, setSearching] = useState(false);
  const [showOffset, setShowOffset] = useState(false);
  const [stamps, setStamps] = useState<number[]>([]);
  const pos = usePosition(engine, 60);
  const scrollRef = useRef<any>(null);
  const viewH = useRef(500);
  const ys = useRef<Record<number, number>>({});
  const userScrolling = useRef(false);
  const resumeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const durKey = Math.round(duration / 5);

  const fetchLyrics = useCallback(
    async (forceOnline = false) => {
      if (!track) {
        setData(null);
        return;
      }
      if (!forceOnline) {
        const cached = savedCache.get(track.id);
        if (cached) {
          setData(cached);
          return;
        }
      }
      setSearching(true);
      try {
        const d = await loadLyrics(track, duration, true);
        setData(d);
        if (d.synced) savedCache.set(track.id, d);
      } catch (e) {
        console.warn('[lyrics] fetch error:', e);
      } finally {
        setSearching(false);
      }
    },
    [track, duration]
  );

  useEffect(() => {
    let cancelled = false;
    setSyncing(false);
    setShowOffset(false);
    setStamps([]);
    ys.current = {};
    if (!track) {
      setData(null);
      return;
    }
    const cached = savedCache.get(track.id);
    if (cached) {
      setData(cached);
      return;
    }
    setSearching(true);
    loadLyrics(track, duration, true)
      .then((d) => {
        if (!cancelled) {
          setData(d);
          if (d.synced) savedCache.set(track.id, d);
        }
      })
      .finally(() => {
        if (!cancelled) setSearching(false);
      });

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [track?.id, track?.lrcUri, durKey]);

  const lines = data?.lines ?? [];
  const active = useMemo(() => (syncing ? -1 : activeLineIndex(lines, pos, 0.18)), [lines, pos, syncing]);

  // автопрокрутка к активной строке по реально измеренным высотам
  useEffect(() => {
    if (active < 0 || userScrolling.current) return;
    const y = ys.current[active];
    if (y === undefined) return;
    scrollRef.current?.scrollTo({ y: Math.max(0, y - viewH.current * 0.32), animated: true });
  }, [active]);

  const onAdjustOffset = async (deltaSec: number) => {
    if (!track || !data || data.lines.length === 0) return;
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    const shifted = shiftLyricsOffset(data.lines, deltaSec);
    const updated: LyricsData = { ...data, lines: shifted, synced: true };
    setData(updated);
    savedCache.set(track.id, updated);
    try {
      await saveLrc(track, shifted);
      onSaved();
    } catch (e) {
      console.warn('[lyrics] offset save failed', e);
    }
  };

  const startSync = () => {
    if (!data || data.plain.length === 0) return;
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    setStamps([]);
    setSyncing(true);
    setShowOffset(false);
    engine.seek(0);
    if (!engine.getState().isPlaying) engine.togglePlay();
  };

  const stamp = () => {
    if (!data) return;
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    const t = Math.max(0, engine.getPosition() - 0.15); // компенсация времени реакции
    setStamps((s) => (s.length < data.plain.length ? [...s, t] : s));
  };

  const undo = () => {
    setStamps((s) => {
      const next = s.slice(0, -1);
      if (next.length > 0) engine.seek(Math.max(0, next[next.length - 1] - 1));
      return next;
    });
  };

  const save = async () => {
    if (!track || !data) return;
    const newLines: LyricLine[] = data.plain.map((text, i) => ({ time: stamps[i] ?? 0, text, section: isSectionLine(text) }));
    try {
      await saveLrc(track, newLines);
      const d: LyricsData = { lines: newLines, synced: true, source: 'manual', plain: data.plain };
      savedCache.set(track.id, d);
      setData(d);
      setSyncing(false);
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      onSaved();
    } catch (e) {
      console.warn('[lyrics] save failed', e);
    }
  };

  const onPressLine = useCallback(
    (l: LyricLine) => {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
      engine.seek(Math.max(0, l.time));
    },
    [engine]
  );

  const finished = syncing && data ? stamps.length >= data.plain.length : false;

  if (!track) return <View style={{ flex: 1 }} />;

  if (data && data.source === 'none' && !searching) {
    return (
      <View style={styles.empty}>
        <Ionicons name="text" size={40} color={colors.text3} />
        <Text style={styles.emptyTitle}>Текст не найден</Text>
        <Text style={styles.emptyText}>
          В файле нет встроенного текста. Вы можете найти синхронизированный текст песни в онлайн-каталоге или разместить рядом файл .lrc.
        </Text>
        <PressableScale onPress={() => fetchLyrics(true)} scaleTo={0.96} style={{ marginTop: 12 }}>
          <View style={styles.findBtn}>
            <Ionicons name="cloud-download-outline" size={18} color={colors.onAccent} style={{ marginRight: 6 }} />
            <Text style={styles.findBtnText}>Искать в онлайн-каталоге</Text>
          </View>
        </PressableScale>
      </View>
    );
  }

  const statusTitle = syncing
    ? 'Разметка'
    : searching
    ? 'Поиск в сети…'
    : data?.synced
    ? data.source === 'lrclib'
      ? 'Синхронизирован (LRCLIB)'
      : 'Синхронизирован'
    : 'Приблизительно';

  return (
    <View style={{ flex: 1 }}>
      {data && (
        <View style={styles.statusRow}>
          <Glass radius={12} style={{ height: 26 }}>
            <View style={styles.chip}>
              {searching ? (
                <ActivityIndicator size="small" color={colors.text} style={{ transform: [{ scale: 0.6 }] }} />
              ) : (
                <View style={[styles.dot, { backgroundColor: data.synced ? '#30d158' : colors.text3 }]} />
              )}
              <Text style={styles.chipText}>{statusTitle}</Text>
            </View>
          </Glass>

          {!syncing && (
            <View style={styles.actionsRow}>
              {data.synced && (
                <PressableScale onPress={() => setShowOffset(!showOffset)} scaleTo={0.95}>
                  <Text style={[styles.link, showOffset && { color: colors.text }]}>Смещение</Text>
                </PressableScale>
              )}
              <PressableScale onPress={() => fetchLyrics(true)} scaleTo={0.95} hitSlop={6}>
                <Ionicons name="refresh" size={16} color={colors.text2} />
              </PressableScale>
              <PressableScale onPress={startSync} scaleTo={0.95}>
                <Text style={styles.link}>{data.synced ? 'Разметить' : 'Разметить точно'}</Text>
              </PressableScale>
            </View>
          )}
        </View>
      )}

      {/* Быстрая калибровка смещения (+/- 0.5с / 0.1с) как в Dynamic-Lyrics */}
      {showOffset && data?.synced && (
        <View style={styles.offsetBar}>
          <Glass radius={14} intensity={60}>
            <View style={styles.offsetInner}>
              <Text style={styles.offsetTitle}>Сдвиг текста:</Text>
              <PressableScale onPress={() => onAdjustOffset(-0.5)} scaleTo={0.92}>
                <View style={styles.offsetBtn}>
                  <Text style={styles.offsetBtnText}>-0.5s</Text>
                </View>
              </PressableScale>
              <PressableScale onPress={() => onAdjustOffset(-0.1)} scaleTo={0.92}>
                <View style={styles.offsetBtn}>
                  <Text style={styles.offsetBtnText}>-0.1s</Text>
                </View>
              </PressableScale>
              <PressableScale onPress={() => onAdjustOffset(+0.1)} scaleTo={0.92}>
                <View style={styles.offsetBtn}>
                  <Text style={styles.offsetBtnText}>+0.1s</Text>
                </View>
              </PressableScale>
              <PressableScale onPress={() => onAdjustOffset(+0.5)} scaleTo={0.92}>
                <View style={styles.offsetBtn}>
                  <Text style={styles.offsetBtnText}>+0.5s</Text>
                </View>
              </PressableScale>
            </View>
          </Glass>
        </View>
      )}

      <ScrollView
        ref={scrollRef}
        onLayout={(e) => (viewH.current = e.nativeEvent.layout.height)}
        contentContainerStyle={{ paddingHorizontal: 24, paddingTop: 12, paddingBottom: bottomPad + (syncing ? 120 : 40) }}
        showsVerticalScrollIndicator={false}
        onScrollBeginDrag={() => {
          userScrolling.current = true;
          if (resumeTimer.current) clearTimeout(resumeTimer.current);
        }}
        onScrollEndDrag={() => {
          if (resumeTimer.current) clearTimeout(resumeTimer.current);
          resumeTimer.current = setTimeout(() => (userScrolling.current = false), 3000);
        }}
      >
        {syncing && data
          ? data.plain.map((text, i) => {
              const done = i < stamps.length;
              const isNext = i === stamps.length;
              return (
                <Text
                  key={i}
                  style={[
                    isSectionLine(text) ? styles.section : styles.line,
                    { opacity: isNext ? 1 : done ? 0.45 : 0.3 },
                  ]}
                >
                  {text}
                </Text>
              );
            })
          : lines.map((l, i) => (
              <LyricRow
                key={i}
                line={l}
                active={i === active}
                past={i < active}
                onPress={() => onPressLine(l)}
                onLayoutY={(y) => {
                  ys.current[i] = y;
                }}
              />
            ))}
      </ScrollView>

      {syncing && data && (
        <View style={[styles.syncBar, { bottom: bottomPad }]}>
          <Glass radius={28} intensity={70}>
            <View style={styles.syncInner}>
              <Text style={styles.syncHint} numberOfLines={2}>
                {finished
                  ? 'Все строки размечены'
                  : `Нажимайте «Метка» ровно в момент, когда начинается строка (${stamps.length}/${data.plain.length})`}
              </Text>
              <View style={styles.syncBtns}>
                <PressableScale onPress={() => setSyncing(false)}>
                  <Text style={styles.link}>Отмена</Text>
                </PressableScale>
                <PressableScale onPress={undo} disabled={stamps.length === 0}>
                  <Ionicons name="arrow-undo" size={22} color={stamps.length ? colors.text : colors.text3} />
                </PressableScale>
                <PressableScale onPress={() => engine.togglePlay()}>
                  <Ionicons name={isPlaying ? 'pause' : 'play'} size={22} color={colors.text} />
                </PressableScale>
                <Text style={styles.syncTime}>{formatTime(pos)}</Text>
                <PressableScale onPress={finished ? save : stamp} scaleTo={0.94} haptic="none">
                  <View style={styles.stampBtn}>
                    <Text style={styles.stampText}>{finished ? 'Сохранить' : 'Метка'}</Text>
                  </View>
                </PressableScale>
              </View>
            </View>
          </Glass>
        </View>
      )}
    </View>
  );
};

const styles = StyleSheet.create({
  line: { fontSize: 27, fontWeight: '700', letterSpacing: -0.5, color: colors.text, paddingVertical: 8, transformOrigin: 'left center' },
  section: {
    fontSize: 13,
    fontWeight: '700',
    color: colors.text2,
    textTransform: 'uppercase',
    letterSpacing: 1.2,
    paddingTop: 18,
    paddingBottom: 4,
    transformOrigin: 'left center',
  },
  statusRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 24, paddingBottom: 6 },
  actionsRow: { flexDirection: 'row', alignItems: 'center', gap: 14 },
  chip: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 10 },
  dot: { width: 6, height: 6, borderRadius: 3 },
  chipText: { ...type.caption, color: colors.text, fontSize: 11 },
  link: { ...type.body, fontWeight: '600', color: colors.text2, fontSize: 13 },
  empty: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 36, gap: 10 },
  emptyTitle: { ...type.title, color: colors.text },
  emptyText: { ...type.body, color: colors.text2, textAlign: 'center', lineHeight: 21 },
  findBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.accent,
    paddingHorizontal: 18,
    paddingVertical: 10,
    borderRadius: 20,
  },
  findBtnText: { ...type.headline, color: colors.onAccent, fontSize: 14 },
  offsetBar: { paddingHorizontal: 24, paddingBottom: 6 },
  offsetInner: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 12, paddingVertical: 6 },
  offsetTitle: { ...type.caption, color: colors.text2, fontSize: 11 },
  offsetBtn: { backgroundColor: 'rgba(255,255,255,0.12)', paddingHorizontal: 10, paddingVertical: 4, borderRadius: 8 },
  offsetBtnText: { ...type.mono, color: colors.text, fontSize: 11, fontWeight: '600' },
  syncBar: { position: 'absolute', left: 16, right: 16 },
  syncInner: { padding: 14, gap: 10 },
  syncHint: { ...type.caption, color: colors.text2 },
  syncBtns: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  syncTime: { ...type.mono, color: colors.text2 },
  stampBtn: { height: 44, paddingHorizontal: 22, borderRadius: 22, backgroundColor: colors.accent, alignItems: 'center', justifyContent: 'center' },
  stampText: { ...type.headline, color: colors.onAccent },
});
