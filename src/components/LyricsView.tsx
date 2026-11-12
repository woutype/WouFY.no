import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Animated, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { AudioEngine } from '../services/audioEngine';
import { TrackFile } from '../types';
import { LyricLine, LyricsData, activeLineIndex, isSectionLine, loadLyrics, saveLrc } from '../services/lyrics';
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
    Animated.spring(a, { toValue: p.active ? 1 : 0, useNativeDriver: true, damping: 20, stiffness: 220, mass: 0.8 }).start();
  }, [p.active, a]);
  return (
    <Pressable onPress={p.onPress} onLayout={(e) => p.onLayoutY(e.nativeEvent.layout.y, e.nativeEvent.layout.height)}>
      <Animated.Text
        style={[
          p.line.section ? styles.section : styles.line,
          {
            opacity: a.interpolate({ inputRange: [0, 1], outputRange: [p.past ? 0.28 : 0.42, 1] }),
            transform: [{ scale: a.interpolate({ inputRange: [0, 1], outputRange: [0.94, 1] }) }],
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
  const [stamps, setStamps] = useState<number[]>([]);
  const pos = usePosition(engine, 70);
  const scrollRef = useRef<any>(null);
  const viewH = useRef(500);
  const ys = useRef<Record<number, number>>({});
  const userScrolling = useRef(false);
  const resumeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const durKey = Math.round(duration / 5);
  useEffect(() => {
    let cancelled = false;
    setSyncing(false);
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
    loadLyrics(track, duration).then((d) => !cancelled && setData(d));
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [track?.id, track?.lrcUri, durKey]);

  const lines = data?.lines ?? [];
  const active = useMemo(() => (syncing ? -1 : activeLineIndex(lines, pos)), [lines, pos, syncing]);

  // автопрокрутка к активной строке (по реально измеренным высотам, а не по константе)
  useEffect(() => {
    if (active < 0 || userScrolling.current) return;
    const y = ys.current[active];
    if (y === undefined) return;
    scrollRef.current?.scrollTo({ y: Math.max(0, y - viewH.current * 0.3), animated: true });
  }, [active]);

  const startSync = () => {
    if (!data || data.plain.length === 0) return;
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    setStamps([]);
    setSyncing(true);
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

  if (data && data.source === 'none') {
    return (
      <View style={styles.empty}>
        <Ionicons name="text" size={40} color={colors.text3} />
        <Text style={styles.emptyTitle}>Текста нет</Text>
        <Text style={styles.emptyText}>
          Добавьте текст в теги трека (USLT) или положите рядом файл с тем же именем и расширением .lrc — тогда строки будут идти ровно в такт.
        </Text>
      </View>
    );
  }

  return (
    <View style={{ flex: 1 }}>
      {data && (
        <View style={styles.statusRow}>
          <Glass radius={12} style={{ height: 26 }}>
            <View style={styles.chip}>
              <View style={[styles.dot, { backgroundColor: data.synced ? colors.text : colors.text3 }]} />
              <Text style={styles.chipText}>{syncing ? 'Разметка' : data.synced ? 'Синхронизирован' : 'Приблизительно'}</Text>
            </View>
          </Glass>
          {!syncing && (
            <PressableScale onPress={startSync} scaleTo={0.95}>
              <Text style={styles.link}>{data.synced ? 'Переразметить' : 'Разметить точно'}</Text>
            </PressableScale>
          )}
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
  line: { fontSize: 27, fontWeight: '700', letterSpacing: -0.5, color: colors.text, paddingVertical: 7, transformOrigin: 'left center' },
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
  statusRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 24, paddingBottom: 4 },
  chip: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 10 },
  dot: { width: 6, height: 6, borderRadius: 3 },
  chipText: { ...type.caption, color: colors.text },
  link: { ...type.body, fontWeight: '600', color: colors.text2 },
  empty: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 36, gap: 10 },
  emptyTitle: { ...type.title, color: colors.text },
  emptyText: { ...type.body, color: colors.text2, textAlign: 'center', lineHeight: 21 },
  syncBar: { position: 'absolute', left: 16, right: 16 },
  syncInner: { padding: 14, gap: 10 },
  syncHint: { ...type.caption, color: colors.text2 },
  syncBtns: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  syncTime: { ...type.mono, color: colors.text2 },
  stampBtn: { height: 44, paddingHorizontal: 22, borderRadius: 22, backgroundColor: colors.accent, alignItems: 'center', justifyContent: 'center' },
  stampText: { ...type.headline, color: colors.onAccent },
});
