import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Animated, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { LinearGradient } from 'expo-linear-gradient';
import { AudioEngine } from '../services/audioEngine';
import { TrackFile } from '../types';
import {
  LyricLine,
  LyricsData,
  activeLineIndex,
  fetchOnlineLrc,
  isSectionLine,
  loadLyrics,
  parseLrc,
  saveLrc,
  shiftLyricsOffset,
} from '../services/lyrics';
import { usePosition } from '../hooks/useAudioController';
import { colors, formatTime, type } from '../theme';
import { Glass, PressableScale } from './ui';

const savedCache = new Map<string, LyricsData>();

/** прозрачность неактивных строк по расстоянию до активной — плавное «угасание» вместо резкой границы */
const DIST_OPACITY = [1, 0.62, 0.46, 0.34, 0.26, 0.2];

const LyricRow = React.memo(function LyricRow(p: {
  index: number;
  line: LyricLine;
  active: boolean;
  /** расстояние до активной строки (0…5) */
  dist: number;
  onPress: (index: number) => void;
  onLayoutY: (index: number, y: number) => void;
}) {
  const a = useRef(new Animated.Value(p.active ? 1 : 0)).current;
  useEffect(() => {
    Animated.spring(a, { toValue: p.active ? 1 : 0, useNativeDriver: true, damping: 22, stiffness: 240, mass: 0.7 }).start();
  }, [p.active, a]);
  const rest = DIST_OPACITY[Math.min(5, p.dist)];
  return (
    <Pressable onPress={() => p.onPress(p.index)} onLayout={(e) => p.onLayoutY(p.index, e.nativeEvent.layout.y)}>
      <Animated.Text
        style={[
          p.line.section ? styles.section : styles.line,
          {
            opacity: a.interpolate({ inputRange: [0, 1], outputRange: [rest, 1] }),
            transform: [{ scale: a.interpolate({ inputRange: [0, 1], outputRange: [0.95, 1.03] }) }],
          },
        ]}
      >
        {p.line.text}
      </Animated.Text>
    </Pressable>
  );
});

/** Время для режима разметки — отдельным компонентом, чтобы не перерисовывать весь текст */
const SyncTime: React.FC<{ engine: AudioEngine }> = ({ engine }) => {
  const pos = usePosition(engine, 100);
  return <Text style={styles.syncTime}>{formatTime(pos)}</Text>;
};

/**
 * Номер активной строки. Позиция читается у плеера 12 раз в секунду, а React-состояние меняется
 * только при смене строки — текст не перерисовывается постоянно (раньше все строки пересоздавались 16 раз в секунду).
 * `pin` фиксирует строку на ~1 сек после нажатия — пока плеер ещё перематывается, строка не «дёргается» назад.
 */
function useActiveLine(engine: AudioEngine, lines: LyricLine[], enabled: boolean) {
  const [active, setActive] = useState(-1);
  const hold = useRef<{ idx: number; until: number } | null>(null);
  const linesRef = useRef(lines);
  linesRef.current = lines;

  const compute = useCallback(() => {
    const h = hold.current;
    if (h && Date.now() < h.until) return h.idx;
    hold.current = null;
    return activeLineIndex(linesRef.current, engine.getPosition(), 0.12);
  }, [engine]);

  useEffect(() => {
    if (!enabled) {
      setActive(-1);
      return;
    }
    setActive(compute());
    const id = setInterval(() => setActive((prev) => {
      const n = compute();
      return n === prev ? prev : n;
    }), 80);
    return () => clearInterval(id);
  }, [enabled, lines, compute]);

  const pin = useCallback((idx: number) => {
    hold.current = { idx, until: Date.now() + 1000 };
    setActive(idx);
  }, []);

  return { active, pin };
}

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
  const [following, setFollowing] = useState(true);

  const scrollRef = useRef<React.ElementRef<typeof ScrollView>>(null);
  const viewH = useRef(500);
  const ys = useRef<Record<number, number>>({});
  const follow = useRef(true);
  const pendingScroll = useRef<number | null>(null);
  const resumeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const durationRef = useRef(duration);
  durationRef.current = duration;

  const lines = data?.lines ?? [];
  const { active, pin } = useActiveLine(engine, lines, !syncing && lines.length > 0);

  const setFollow = (v: boolean) => {
    follow.current = v;
    setFollowing(v);
  };

  /** прокрутка так, чтобы строка оказалась в верхней трети экрана; если строка ещё не измерена — ждём её onLayout */
  const scrollToLine = useCallback((idx: number, animated = true) => {
    if (idx < 0) return;
    const y = ys.current[idx];
    if (y === undefined) {
      pendingScroll.current = idx;
      return;
    }
    pendingScroll.current = null;
    scrollRef.current?.scrollTo({ y: Math.max(0, y - viewH.current * 0.3), animated });
  }, []);

  // автоследование за текстом
  useEffect(() => {
    if (active >= 0 && follow.current) scrollToLine(active, true);
  }, [active, scrollToLine]);

  const onLayoutY = useCallback(
    (i: number, y: number) => {
      ys.current[i] = y;
      if (pendingScroll.current === i && follow.current) scrollToLine(i, false);
    },
    [scrollToLine]
  );

  /* ───────── загрузка текста ───────── */

  useEffect(() => {
    let cancelled = false;
    setSyncing(false);
    setShowOffset(false);
    setStamps([]);
    setFollow(true);
    ys.current = {};
    pendingScroll.current = null;
    if (!track) {
      setData(null);
      setSearching(false);
      return;
    }
    const cached = savedCache.get(track.id);
    if (cached) {
      setData(cached);
      setSearching(false);
      return;
    }

    (async () => {
      // 1) быстро: встроенные источники (SYLT, .lrc, кэш, LRC в USLT) — без сети
      setSearching(true);
      let local: LyricsData | null = null;
      try {
        local = await loadLyrics(track, durationRef.current, false);
      } catch (e) {
        console.warn('[lyrics] local load error:', e);
      }
      if (cancelled) return;
      if (local) setData(local);
      if (local?.synced) {
        savedCache.set(track.id, local);
        setSearching(false);
        return;
      }
      // 2) сеть (LRCLIB): ждём, пока плеер узнает длительность — по ней выбирается нужная версия
      for (let i = 0; i < 12 && durationRef.current <= 0 && !cancelled; i++) await new Promise((r) => setTimeout(r, 150));
      if (cancelled) return;
      try {
        const online = await loadLyrics(track, durationRef.current, true);
        if (cancelled) return;
        if (online.synced || !local || local.source === 'none') setData(online);
        if (online.synced) savedCache.set(track.id, online);
      } catch (e) {
        console.warn('[lyrics] online load error:', e);
      } finally {
        if (!cancelled) setSearching(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [track?.id, track?.lrcUri]); // eslint-disable-line react-hooks/exhaustive-deps

  /** Принудительный поиск в онлайн-каталоге (кнопки «обновить» / «искать») */
  const fetchOnline = useCallback(async () => {
    if (!track) return;
    setSearching(true);
    try {
      const raw = await fetchOnlineLrc(track, durationRef.current || engine.getDuration());
      const parsed = raw ? parseLrc(raw) : null;
      if (parsed) {
        const d: LyricsData = { lines: parsed, synced: true, source: 'lrclib', plain: parsed.map((l) => l.text) };
        savedCache.set(track.id, d);
        setData(d);
        ys.current = {};
        saveLrc(track, parsed).catch(() => {});
      } else if (!data || data.source === 'none') {
        setData({ lines: [], synced: false, source: 'none', plain: [] });
      }
    } catch (e) {
      console.warn('[lyrics] fetch error:', e);
    } finally {
      setSearching(false);
    }
  }, [track, data, engine]);

  /* ───────── смещение, разметка ───────── */

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

  /** Нажатие на строку: перемотка к ней, строка сразу становится активной, и текст снова следует за песней */
  const linesRef = useRef(lines);
  linesRef.current = lines;
  const onPressLine = useCallback(
    (i: number) => {
      const l = linesRef.current[i];
      if (!l) return;
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
      if (resumeTimer.current) clearTimeout(resumeTimer.current);
      setFollow(true);
      pin(i);
      engine.seek(Math.max(0, l.time));
      scrollToLine(i, true);
    },
    [engine, pin, scrollToLine]
  );

  /* ───────── ручная прокрутка: на время пальца автоследование выключается ───────── */

  const scheduleResume = (ms: number) => {
    if (resumeTimer.current) clearTimeout(resumeTimer.current);
    resumeTimer.current = setTimeout(() => {
      setFollow(true);
      scrollToLine(active, true);
    }, ms);
  };
  const activeRef = useRef(active);
  activeRef.current = active;
  const resumeNow = () => {
    if (resumeTimer.current) clearTimeout(resumeTimer.current);
    setFollow(true);
    scrollToLine(activeRef.current, true);
  };
  useEffect(
    () => () => {
      if (resumeTimer.current) clearTimeout(resumeTimer.current);
    },
    []
  );

  const finished = syncing && data ? stamps.length >= data.plain.length : false;

  const rows = useMemo(
    () =>
      lines.map((l, i) => (
        <LyricRow
          key={i}
          index={i}
          line={l}
          active={i === active}
          dist={active < 0 ? 3 : Math.abs(i - active)}
          onPress={onPressLine}
          onLayoutY={onLayoutY}
        />
      )),
    [lines, active, onPressLine, onLayoutY]
  );

  if (!track) return <View style={{ flex: 1 }} />;

  if (data && data.source === 'none' && !searching) {
    return (
      <View style={styles.empty}>
        <Ionicons name="text" size={40} color={colors.text3} />
        <Text style={styles.emptyTitle}>Текст не найден</Text>
        <Text style={styles.emptyText}>
          В файле нет встроенного текста. Можно найти синхронизированный текст в онлайн-каталоге или положить рядом с треком файл .lrc с тем же именем.
        </Text>
        <PressableScale onPress={fetchOnline} scaleTo={0.96} style={{ marginTop: 12 }}>
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
    ? 'Поиск текста…'
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
              <PressableScale onPress={fetchOnline} scaleTo={0.95} hitSlop={6}>
                <Ionicons name="refresh" size={16} color={colors.text2} />
              </PressableScale>
              <PressableScale onPress={startSync} scaleTo={0.95}>
                <Text style={styles.link}>{data.synced ? 'Разметить' : 'Разметить точно'}</Text>
              </PressableScale>
            </View>
          )}
        </View>
      )}

      {/* Быстрая калибровка смещения (+/- 0.5с / 0.1с) */}
      {showOffset && data?.synced && (
        <View style={styles.offsetBar}>
          <Glass radius={14} intensity={60}>
            <View style={styles.offsetInner}>
              <Text style={styles.offsetTitle}>Сдвиг текста:</Text>
              {[-0.5, -0.1, 0.1, 0.5].map((d) => (
                <PressableScale key={d} onPress={() => onAdjustOffset(d)} scaleTo={0.92}>
                  <View style={styles.offsetBtn}>
                    <Text style={styles.offsetBtnText}>{d > 0 ? '+' : '-'}{Math.abs(d)}s</Text>
                  </View>
                </PressableScale>
              ))}
            </View>
          </Glass>
        </View>
      )}

      <View style={{ flex: 1 }}>
        <ScrollView
          ref={scrollRef}
          onLayout={(e) => (viewH.current = e.nativeEvent.layout.height)}
          contentContainerStyle={{ paddingHorizontal: 24, paddingTop: 12, paddingBottom: bottomPad + (syncing ? 120 : 40) }}
          showsVerticalScrollIndicator={false}
          scrollEventThrottle={32}
          onScrollBeginDrag={() => {
            if (resumeTimer.current) clearTimeout(resumeTimer.current);
            if (follow.current) setFollow(false);
          }}
          onScrollEndDrag={() => scheduleResume(4500)}
          onMomentumScrollBegin={() => {
            if (!follow.current && resumeTimer.current) clearTimeout(resumeTimer.current);
          }}
          onMomentumScrollEnd={() => {
            if (!follow.current) scheduleResume(4000);
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
            : rows}
        </ScrollView>
        {/* мягкое растворение текста у краёв */}
        <LinearGradient pointerEvents="none" colors={['rgba(8,8,8,0.8)', 'rgba(8,8,8,0)']} style={styles.fadeTop} />
        <LinearGradient pointerEvents="none" colors={['rgba(8,8,8,0)', 'rgba(8,8,8,0.8)']} style={[styles.fadeBottom, { height: Math.min(bottomPad, 110) }]} />

        {!syncing && !following && lines.length > 0 && (
          <View style={[styles.followPillWrap, { bottom: bottomPad + 8 }]} pointerEvents="box-none">
            <PressableScale onPress={resumeNow} scaleTo={0.95}>
              <View style={styles.followPill}>
                <Ionicons name="locate" size={15} color={colors.text} />
                <Text style={styles.followText}>К текущей строке</Text>
              </View>
            </PressableScale>
          </View>
        )}
      </View>

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
                <SyncTime engine={engine} />
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
  followPillWrap: { position: 'absolute', left: 0, right: 0, alignItems: 'center' },
  fadeTop: { position: 'absolute', top: 0, left: 0, right: 0, height: 22 },
  fadeBottom: { position: 'absolute', bottom: 0, left: 0, right: 0 },
  followPill: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 14, height: 36, borderRadius: 18, backgroundColor: 'rgba(255,255,255,0.14)', borderWidth: StyleSheet.hairlineWidth * 2, borderColor: colors.stroke },
  followText: { ...type.caption, color: colors.text, fontWeight: '600' },
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
