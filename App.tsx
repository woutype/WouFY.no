import React, { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { ActivityIndicator, Alert, Animated, AppState, Platform, StyleSheet, Text, View } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { scanLibrary } from './src/services/fileScanner';
import { bpmService } from './src/services/bpm';
import { flushState, getState, loadState, patchState } from './src/services/library';
import { useAudioEngine, useEngineState } from './src/hooks/useAudioController';
import { useMetrics } from './src/layout';
import { DEFAULT_DJ, DJSettings, TrackFile } from './src/types';
import { colors } from './src/theme';
import { AmbientBackground } from './src/components/ui';
import { NowPlayingCard } from './src/components/NowPlayingCard';
import { QueueView } from './src/components/QueueView';
import { LyricsView } from './src/components/LyricsView';
import { SheetPanel } from './src/components/SheetPanel';
import { SettingsModal } from './src/components/SettingsModal';

function Root() {
  const m = useMetrics();
  const engine = useAudioEngine();
  const state = useEngineState(engine);

  const [ready, setReady] = useState(false);
  const [libCount, setLibCount] = useState(0);
  const [sheet, setSheet] = useState<'queue' | 'lyrics'>('queue');
  const [expanded, setExpanded] = useState(true);
  const [search, setSearch] = useState('');
  const [showSettings, setShowSettings] = useState(false);
  const [dj, setDj] = useState<DJSettings>(DEFAULT_DJ);
  const progress = useRef(new Animated.Value(1)).current;

  // перерисовка при появлении нового BPM
  useSyncExternalStore(bpmService.subscribe.bind(bpmService), () => JSON.stringify(getState().bpm ?? {}));

  /* ───────── загрузка библиотеки ───────── */
  const rescan = useCallback(async () => {
    try {
      const found: TrackFile[] = await scanLibrary();
      bpmService.registerTags(found);
      setLibCount(found.length);
      const st = getState();
      engine.setLibrary(found, st.order, st.lastTrackId);
    } catch (e) {
      console.error('Scan error:', e);
    }
  }, [engine]);

  useEffect(() => {
    engine.configure({
      bpmLookup: (t) => bpmService.get(t.id),
      onTrackChange: (cur, upcoming) => {
        if (!engine.getState().mixing) {
          bpmService.request(cur, true);
          upcoming.forEach((t) => bpmService.request(t));
        }
      },
      onPersist: (s) => patchState(s),
    });
    (async () => {
      const st = await loadState();
      const settings = { ...DEFAULT_DJ, ...(st.dj ?? {}) };
      setDj(settings);
      engine.setDJ(settings);
      if (st.volume !== undefined) engine.setVolume(st.volume);
      if (st.repeat) engine.setRepeat(st.repeat);
      await rescan();
      if (st.shuffle) engine.setShuffle(true);
      setReady(true);
    })();
    const sub = AppState.addEventListener('change', (s) => {
      if (s === 'active') rescan(); // подхватываем файлы, добавленные через «Файлы»
      else flushState();
    });
    return () => sub.remove();
  }, [engine, rescan]);

  const updateDj = (s: DJSettings) => {
    setDj(s);
    engine.setDJ(s);
    patchState({ dj: s });
  };

  /* ───────── карточка плеера ↔ вторичный экран ───────── */
  const settle = useCallback(
    (target: 0 | 1) => {
      setExpanded(target === 1);
      Animated.spring(progress, {
        toValue: target,
        useNativeDriver: true,
        damping: 26,
        stiffness: 230,
        mass: 1,
        overshootClamping: true,
      }).start();
    },
    [progress]
  );

  const openSheet = useCallback(
    (mode: 'queue' | 'lyrics') => {
      setSheet(mode);
      settle(0);
    },
    [settle]
  );

  const onArtistPress = useCallback(
    (artist: string) => {
      setSearch(artist);
      openSheet('queue');
    },
    [openSheet]
  );

  /* ───────── BPM ───────── */
  const track = state.queue[state.index];
  const bpm = track ? bpmService.get(track.id) : undefined;
  const bpmSource = track ? bpmService.sourceOf(track.id) : undefined;

  const editBpm = useCallback(() => {
    if (!track) return;
    const apply = (txt?: string) => {
      const v = parseFloat((txt ?? '').replace(',', '.'));
      if (isFinite(v) && v >= 40 && v <= 240) bpmService.setManual(track.id, Math.round(v * 10) / 10);
    };
    if (Platform.OS === 'ios') {
      Alert.prompt(
        'BPM трека',
        `${track.title}\nУкажите темп вручную. Он используется для подгона темпа при склейке.`,
        [
          { text: 'Сбросить', style: 'destructive', onPress: () => bpmService.setManual(track.id, null) },
          { text: 'Отмена', style: 'cancel' },
          { text: 'Сохранить', onPress: apply },
        ],
        'plain-text',
        bpm ? String(Math.round(bpm)) : '',
        'numeric'
      );
    } else {
      Alert.alert('BPM трека', bpm ? `${Math.round(bpm)} BPM` : 'Определяется автоматически');
    }
  }, [track, bpm]);

  if (!ready) {
    return (
      <View style={styles.loading}>
        <StatusBar style="light" />
        <ActivityIndicator color={colors.text2} />
        <Text style={styles.loadingText}>Загрузка библиотеки…</Text>
      </View>
    );
  }

  const sheetScale = progress.interpolate({ inputRange: [0, 1], outputRange: [1, 0.95] });
  const sheetOpacity = progress.interpolate({ inputRange: [0, 1], outputRange: [1, 0.25] });
  const bottomPad = m.miniArea + 12;

  return (
    <View style={styles.root}>
      <StatusBar style="light" />

      {/* Вторичный экран (под карточкой плеера) */}
      <Animated.View
        style={[StyleSheet.absoluteFill, { opacity: sheetOpacity, transform: [{ scale: sheetScale }] }]}
        pointerEvents={expanded ? 'none' : 'auto'}
      >
        <AmbientBackground uri={track?.artworkUri} />
        <SheetPanel mode={sheet} onModeChange={setSheet} progress={progress} onSettle={settle} topInset={m.top}>
          {sheet === 'queue' ? (
            <QueueView
              tracks={state.queue}
              currentIndex={state.index}
              isPlaying={state.isPlaying}
              searchQuery={search}
              onSearchChange={setSearch}
              onPlay={(i) => engine.playIndex(i)}
              onMove={(a, b) => engine.moveQueueItem(a, b)}
              onReorder={(q) => engine.reorderQueue(q)}
              onRefresh={rescan}
              bottomPad={bottomPad}
            />
          ) : (
            <LyricsView
              engine={engine}
              track={track}
              duration={state.duration}
              isPlaying={state.isPlaying}
              bottomPad={bottomPad}
              onSaved={rescan}
            />
          )}
        </SheetPanel>
      </Animated.View>

      <NowPlayingCard
        engine={engine}
        state={state}
        m={m}
        progress={progress}
        expanded={expanded}
        onSettle={settle}
        onOpenSheet={openSheet}
        onOpenSettings={() => setShowSettings(true)}
        onArtistPress={onArtistPress}
        onEditBpm={editBpm}
        bpm={bpm}
        bpmSource={bpmSource}
      />

      <SettingsModal
        visible={showSettings}
        settings={dj}
        onUpdateSettings={updateDj}
        onClose={() => setShowSettings(false)}
        trackCount={libCount}
        onRescan={rescan}
        bpmInfo={track ? { title: track.title, bpm, source: bpmSource } : undefined}
        onEditBpm={editBpm}
      />
    </View>
  );
}

export default function App() {
  return (
    <SafeAreaProvider>
      <Root />
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  loading: { flex: 1, backgroundColor: colors.bg, alignItems: 'center', justifyContent: 'center', gap: 12 },
  loadingText: { color: colors.text2, fontSize: 14, fontWeight: '500' },
});
