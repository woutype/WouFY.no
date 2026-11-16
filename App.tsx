import React, { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { ActivityIndicator, Alert, Animated, AppState, Platform, Share, StyleSheet, Text, View } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { enrichTracks, scanLibrary, startLibraryWatcher } from './src/services/fileScanner';
import { sampleBus } from './src/services/sampleBus';
import { musicHaptics } from './src/services/musicHaptics';
import { bpmService } from './src/services/bpm';
import { volumeService } from './src/services/volumeService';
import { flushState, getState, loadCachedTracks, loadState, patchState, saveCachedTracks } from './src/services/library';
import { useAudioEngine, useEngineState } from './src/hooks/useAudioController';
import { useMetrics } from './src/layout';
import { DEFAULT_DJ, DEFAULT_FX, DJSettings, FxSettings, TrackFile } from './src/types';
import { colors } from './src/theme';
import { AmbientBackground } from './src/components/ui';
import { NowPlayingCard } from './src/components/NowPlayingCard';
import { QueueView } from './src/components/QueueView';
import { LyricsView } from './src/components/LyricsView';
import { SheetMode, SheetPanel } from './src/components/SheetPanel';
import { StatsView } from './src/components/StatsView';
import { TagEditorModal } from './src/components/TagEditorModal';
import { SettingsModal } from './src/components/SettingsModal';
import { statsService } from './src/services/statsService';
import { splitArtists } from './src/services/queueOrder';

function Root() {
  const m = useMetrics();
  const engine = useAudioEngine();
  const state = useEngineState(engine);

  const [ready, setReady] = useState(false);
  const [libCount, setLibCount] = useState(0);
  const [sheet, setSheet] = useState<SheetMode>('queue');
  const [scrollToCurrentTrigger, setScrollToCurrentTrigger] = useState(0);
  const [expanded, setExpanded] = useState(true);
  const [search, setSearch] = useState('');
  const [searchLyrics, setSearchLyrics] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [showTagEditor, setShowTagEditor] = useState(false);
  const [dj, setDj] = useState<DJSettings>(DEFAULT_DJ);
  const [fx, setFxState] = useState<FxSettings>(DEFAULT_FX);
  const [hapticsOn, setHapticsOn] = useState(false);
  const [sheetScrollEnabled, setSheetScrollEnabled] = useState(true);
  const libRef = useRef<Map<string, TrackFile>>(new Map());
  const lastScanAt = useRef(0);
  const progress = useRef(new Animated.Value(1)).current;

  // перерисовка при появлении нового BPM
  useSyncExternalStore(bpmService.subscribe.bind(bpmService), () => bpmService.version);

  /* ───────── загрузка библиотеки ───────── */
  // Список файлов показывается МГНОВЕННО (по именам файлов); теги и обложки дочитываются в фоне пачками.
  const rescan = useCallback(async (): Promise<string> => {
    const res = await scanLibrary();
    // не откатываем уже прочитанные теги, если кэш на диске ещё не успели обновить
    const merged = res.tracks.map((t) => {
      const known = libRef.current.get(t.id);
      return known && known.tagged && t.tagged === false ? { ...known, uri: t.uri, lrcUri: t.lrcUri } : t;
    });
    const prev = libRef.current;
    const same = prev.size === merged.length && merged.every((t) => {
      const cur = prev.get(t.id);
      return cur && cur.uri === t.uri;
    });
    const lrcChanged = same ? merged.filter((t) => prev.get(t.id)?.lrcUri !== t.lrcUri) : [];
    libRef.current = new Map(merged.map((t) => [t.id, t]));
    bpmService.registerTags(merged);
    setLibCount(merged.length);
    const st = getState();
    // состав библиотеки не изменился (обычный возврат в приложение) — очередь не пересобираем и не перерисовываем
    if (!same) engine.setLibrary(merged, st.order, st.lastTrackId);
    else if (lrcChanged.length) engine.patchTracks(lrcChanged);
    lastScanAt.current = Date.now();
    const s = engine.getState();
    const curTrackId = s.queue[s.index]?.id ?? st.lastTrackId;
    const prio = [curTrackId, ...s.queue.slice(Math.max(0, s.index - 2), s.index + 20).map((t) => t.id)].filter(Boolean) as string[];

    enrichTracks(merged, (upd) => {
      for (const u of upd) libRef.current.set(u.id, u);
      bpmService.registerTags([...libRef.current.values()]);
      engine.patchTracks(upd);
    }, undefined, prio);
    const parts = [`Найдено: ${merged.length}`];
    if (res.added) parts.push(`новых: ${res.added}`);
    if (res.removed) parts.push(`удалено: ${res.removed}`);
    return parts.join(' · ');
  }, [engine]);

  useEffect(() => {
    engine.configure({
      bpmLookup: (t) => bpmService.get(t.id),
      gridLookup: (t) => bpmService.gridOf(t.id),
      // анализ темпа (беззвучный «разведчик») ставим на паузу на время склейки — чтобы не нагружать процессор
      onMixingChange: (mixing) => bpmService.setPaused(mixing),
      onTrackChange: (cur, upcoming) => {
        bpmService.request(cur, true);
        upcoming.forEach((t) => bpmService.request(t));
      },
      onPersist: (s) => patchState(s),
    });
    (async () => {
      // 1. Быстрая параллельная загрузка настроек, кэша и статистики за считанные миллисекунды
      const [st, cached] = await Promise.all([
        loadState(),
        loadCachedTracks(),
        statsService.load().catch(() => {}),
      ]);

      const settings = { ...DEFAULT_DJ, ...(st.dj ?? {}) };
      setDj(settings);
      engine.setDJ(settings);
      const fxSettings = { ...DEFAULT_FX, ...(st.fx ?? {}) };
      setFxState(fxSettings);
      engine.setFx(fxSettings);
      setHapticsOn(Boolean(st.musicHaptics));

      if (st.repeat) engine.setRepeat(st.repeat);

      // Громкость запрашиваем в фоне, не блокируя мгновенный показ плеера
      volumeService.getVolume().then((curVol) => {
        engine.setVolume(curVol, false);
      }).catch(() => {
        if (st.volume !== undefined) engine.setVolume(st.volume, false);
      });

      // Мгновенная инициализация из дискового кэша: плеер готов за 20 мс!
      if (cached.length > 0) {
        libRef.current = new Map(cached.map((t) => [t.id, t]));
        bpmService.registerTags(cached);
        setLibCount(cached.length);
        engine.setLibrary(cached, st.order, st.lastTrackId);
        if (st.shuffle) engine.setShuffle(true);
        setReady(true);
      }

      // Если кэша ещё нет (первый запуск / после сбоя) — сканируем и сразу открываем
      if (cached.length === 0) {
        try {
          await rescan();
        } catch (e) {
          console.error('Scan error:', e);
        }
        if (st.shuffle) engine.setShuffle(true);
        setReady(true);
      } else {
        // Фоновая проверка библиотеки без задержки первого кадра
        setTimeout(() => {
          rescan().catch(() => {});
        }, 250);
      }
    })();

    // Автоматический мониторинг добавления файлов через ядро iOS (как в Spotify)
    const stopWatcher = startLibraryWatcher(() => {
      rescan().catch(() => {});
    });

    const sub = AppState.addEventListener('change', (s) => {
      if (s === 'active') {
        engine.resyncSession(); // возвращаем аудио-сессию (экран блокировки / Dynamic Island) после фона
        // Мгновенно подхватываем файлы при возврате из приложения «Файлы» или Telegram
        if (Date.now() - lastScanAt.current > 1200) rescan().catch(() => {});
        volumeService.getVolume().then((vol) => engine.setVolume(vol, false));
      } else {
        statsService.checkpoint();
        flushState();
      }
    });

    return () => {
      sub.remove();
      stopWatcher();
    };
  }, [engine, rescan]);

  useEffect(() => {
    bpmService.setActivePlayback(state.isPlaying); // запасной режим анализа (без нативного модуля) работает только при остановленной музыке
  }, [state.isPlaying]);
  // шина семплов следует за главным плеером; тактильный отклик работает только во время воспроизведения
  useEffect(() => {
    sampleBus.setPlayer(state.player);
  }, [state.player]);
  const curTrackId = state.queue[state.index]?.id;
  useEffect(() => {
    // после смены трека/старта у expo-audio слетает семплирование — переустанавливаем (волна и тактильный отклик)
    sampleBus.refresh();
  }, [curTrackId, state.isPlaying, state.player]);
  useEffect(() => {
    musicHaptics.configure({
      getPosition: () => engine.getPosition(),
      getGrid: () => {
        const t = engine.currentTrack;
        return t ? bpmService.gridOf(t.id) : undefined;
      },
    });
  }, [engine]);
  useEffect(() => {
    musicHaptics.setEnabled(hapticsOn && state.isPlaying);
  }, [hapticsOn, state.isPlaying]);

  // поиск применяется к самой очереди (с небольшой задержкой, чтобы не пересобирать её на каждую букву)
  useEffect(() => {
    const t = setTimeout(() => engine.setFilter({ query: search, searchLyrics }), search ? 160 : 0);
    return () => clearTimeout(t);
  }, [engine, search, searchLyrics]);

  const updateDj = (s: DJSettings) => {
    setDj(s);
    engine.setDJ(s);
    patchState({ dj: s });
  };
  const updateFx = (s: FxSettings) => {
    setFxState(s);
    engine.setFx(s);
    patchState({ fx: s });
  };
  const toggleHaptics = (on: boolean) => {
    setHapticsOn(on);
    patchState({ musicHaptics: on });
  };

  /* ───────── карточка плеера ↔ вторичный экран ───────── */
  const settle = useCallback(
    (target: 0 | 1) => {
      setExpanded(target === 1);
      if (target === 0 && sheet === 'queue') {
        setScrollToCurrentTrigger((v) => v + 1);
      }
      Animated.spring(progress, {
        toValue: target,
        useNativeDriver: true,
        damping: 26,
        stiffness: 230,
        mass: 1,
        overshootClamping: true,
      }).start();
    },
    [progress, sheet]
  );

  const openSheet = useCallback(
    (mode: SheetMode) => {
      setSheet(mode);
      if (mode === 'queue') {
        setScrollToCurrentTrigger((v) => v + 1);
      }
      settle(0);
    },
    [settle]
  );

  const onArtistPress = useCallback(
    (artist: string) => {
      const parts = splitArtists(artist);
      if (parts.length > 1) {
        Alert.alert(
          'Исполнители',
          'Выберите исполнителя для фильтрации:',
          [
            ...parts.map((p) => ({
              text: p,
              onPress: () => {
                setSearch(p);
                openSheet('queue');
              },
            })),
            { text: 'Отмена', style: 'cancel' as const },
          ]
        );
      } else {
        setSearch(artist);
        openSheet('queue');
      }
    },
    [openSheet]
  );

  const handleSaveTrack = useCallback(
    (updated: TrackFile) => {
      libRef.current.set(updated.id, updated);
      engine.patchTracks([updated]);
      saveCachedTracks([...libRef.current.values()]).catch(() => {});
      bpmService.registerTags([updated]);
    },
    [engine]
  );

  const handleShareTrack = useCallback(
    async (t?: TrackFile) => {
      const target = t ?? state.queue[state.index];
      if (!target) return;
      try {
        await Share.share(
          Platform.OS === 'ios'
            ? { url: target.uri, title: `${target.artist} — ${target.title}` }
            : { message: `${target.artist} — ${target.title}`, title: target.title }
        );
      } catch (e) {
        console.warn('Share error:', e);
      }
    },
    [state.queue, state.index]
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
        <Text style={styles.loadingText}>Загрузка…</Text>
      </View>
    );
  }

  const sheetScale = progress.interpolate({ inputRange: [0, 1], outputRange: [1, 0.95] });
  const sheetOpacity = progress.interpolate({ inputRange: [0, 1], outputRange: [1, 0] });
  const bottomPad = m.miniArea + 12;

  return (
    <View style={styles.root}>
      <StatusBar style="light" />

      {/* Размытый фон из обложки — один на всё приложение (раньше было два, и каждый размывался при смене трека) */}
      <AmbientBackground uri={track?.artworkUri} />

      {/* Вторичный экран (под карточкой плеера) */}
      <Animated.View
        style={[StyleSheet.absoluteFill, { opacity: sheetOpacity, transform: [{ scale: sheetScale }] }]}
        pointerEvents={expanded ? 'none' : 'auto'}
      >
        <SheetPanel
          mode={sheet}
          onModeChange={setSheet}
          progress={progress}
          onSettle={settle}
          topInset={m.top}
          width={m.W}
          scrollEnabled={sheetScrollEnabled}
        >
          <QueueView
            tracks={state.queue}
            allTracks={engine.libraryOrder()}
            currentIndex={state.index}
            currentTrackId={engine.currentTrack?.id}
            isPlaying={state.isPlaying}
            searchQuery={search}
            onSearchChange={setSearch}
            sortMode={state.sort}
            onSortChange={(m) => engine.setFilter({ sort: m })}
            searchLyrics={searchLyrics}
            onSearchLyricsChange={setSearchLyrics}
            pinned={state.pinned}
            onPlay={(i, track) => (track ? engine.playTrack(track) : engine.playIndex(i))}
            onPlayTrackWithSeek={(track, seekTime) => engine.playTrack(track, seekTime)}
            onMove={(a, b) => engine.moveQueueItem(a, b)}
            onRefresh={async () => {
              await rescan();
            }}
            bottomPad={bottomPad}
            scrollToCurrentTrigger={scrollToCurrentTrigger}
          />
          <LyricsView
            engine={engine}
            track={track}
            duration={state.duration}
            isPlaying={state.isPlaying}
            bottomPad={bottomPad}
            onSaved={rescan}
            visible={!expanded && sheet === 'lyrics'}
          />
          <StatsView
            tracks={engine.libraryOrder()}
            onPlayTopTracks={(topTracks, index) => engine.playTopTracks(topTracks, index)}
            onArtistPress={onArtistPress}
            bottomPad={bottomPad}
            visible={!expanded && sheet === 'stats'}
            onRowActiveChange={(active) => setSheetScrollEnabled(!active)}
          />
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
        onEditTags={() => setShowTagEditor(true)}
        onShareTrack={handleShareTrack}
        bpm={bpm}
        bpmSource={bpmSource}
      />

      <TagEditorModal
        visible={showTagEditor}
        track={track}
        onSave={handleSaveTrack}
        onClose={() => setShowTagEditor(false)}
      />

      <SettingsModal
        visible={showSettings}
        settings={dj}
        onUpdateSettings={updateDj}
        fx={fx}
        onUpdateFx={updateFx}
        fxNativeReady={engine.fxNativeReady}
        fxActive={engine.fxActive}
        musicHaptics={hapticsOn}
        onToggleHaptics={toggleHaptics}
        onClose={() => setShowSettings(false)}
        trackCount={libCount}
        onRescan={rescan}
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
