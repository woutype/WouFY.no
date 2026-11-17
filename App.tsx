import React, { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { ActivityIndicator, Alert, Animated, AppState, BackHandler, Platform, Share, StyleSheet, Text, UIManager, View } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider } from 'react-native-safe-area-context';

if (Platform.OS === 'android' && UIManager.setLayoutAnimationEnabledExperimental) {
  UIManager.setLayoutAnimationEnabledExperimental(true);
}
import { enrichTracks, scanLibrary, startLibraryWatcher } from './src/services/fileScanner';
import { sampleBus } from './src/services/sampleBus';
import { musicHaptics } from './src/services/musicHaptics';
import { bpmService } from './src/services/bpm';
import { volumeService } from './src/services/volumeService';
import { flushState, getState, loadCachedTracks, loadState, patchState, resolveTrackUri, saveCachedTracks } from './src/services/library';
import { deriveFx } from './src/services/audioEngine';
import { WoufyFX } from './src/services/fxPlayer';
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
import { checkForUpdate, UpdateInfo } from './src/services/updateService';

const subscribeBpm = (cb: () => void) => bpmService.subscribe(cb);

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
  const [onlyWithLyrics, setOnlyWithLyrics] = useState(false);
  const [onlyWithArtwork, setOnlyWithArtwork] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [showTagEditor, setShowTagEditor] = useState(false);
  const [dj, setDj] = useState<DJSettings>(DEFAULT_DJ);
  const [fx, setFxState] = useState<FxSettings>(DEFAULT_FX);
  const [hapticsOn, setHapticsOn] = useState(false);
  const [sheetScrollEnabled, setSheetScrollEnabled] = useState(true);
  const [exportingFx, setExportingFx] = useState(false);
  const [updateInfo, setUpdateInfo] = useState<UpdateInfo | null>(null);
  const updatePromptShown = useRef(false);
  const libRef = useRef<Map<string, TrackFile>>(new Map());
  const lastScanAt = useRef(0);
  const progress = useRef(new Animated.Value(1)).current;

  // перерисовка при появлении нового BPM
  useSyncExternalStore(subscribeBpm, () => bpmService.version);

  const allTracks = useMemo(() => engine.libraryOrder(), [engine, state.queue, libCount]);

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

  // поиск и фильтры применяются к самой очереди (с небольшой задержкой, чтобы не пересобирать её на каждую букву)
  useEffect(() => {
    const t = setTimeout(
      () => engine.setFilter({ query: search, searchLyrics, onlyWithLyrics, onlyWithArtwork }),
      search ? 160 : 0
    );
    return () => clearTimeout(t);
  }, [engine, search, searchLyrics, onlyWithLyrics, onlyWithArtwork]);

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

  const handleCheckUpdate = useCallback(async () => {
    const info = await checkForUpdate(true);
    setUpdateInfo(info);
    return info;
  }, []);

  useEffect(() => {
    if (!ready) return;
    const timer = setTimeout(() => {
      checkForUpdate(true)
        .then((info) => {
          setUpdateInfo(info);
          if (info.hasUpdate && !updatePromptShown.current) {
            updatePromptShown.current = true;
            const desc = info.notes
              ? `Вышла новая версия WouFY.no v${info.latestVersion} (у вас v${info.currentVersion}).\n\n${info.notes}`
              : `Вышла новая версия WouFY.no v${info.latestVersion} (у вас v${info.currentVersion}). Откройте настройки, чтобы обновить приложение без потери треков и настроек.`;
            Alert.alert('Доступно обновление', desc, [
              { text: 'Позже', style: 'cancel' },
              { text: 'Перейти в настройки', onPress: () => setShowSettings(true) },
            ]);
          }
        })
        .catch(() => {});
    }, 1200);
    return () => clearTimeout(timer);
  }, [ready]);

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

  useEffect(() => {
    if (Platform.OS !== 'android') return;
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      if (!expanded) {
        settle(1);
        return true;
      }
      return false;
    });
    return () => sub.remove();
  }, [expanded, settle]);

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

  const shareFileUri = useCallback(async (uri: string, target: TrackFile, suffix = '') => {
    try {
      const label = `${target.artist} — ${target.title}${suffix}`;
      await Share.share(
        Platform.OS === 'ios'
          ? { url: uri, title: label }
          : { message: label, title: target.title }
      );
    } catch (e) {
      console.warn('Share error:', e);
    }
  }, []);

  const handleShareTrack = useCallback(
    async (t?: TrackFile) => {
      const target = t ?? state.queue[state.index];
      if (!target) return;

      const derived = deriveFx(fx);
      const activeLabels: string[] = [];
      if (fx.enabled) {
        if (fx.slowed) activeLabels.push(fx.slowedReverb ? 'Slowed + Reverb' : 'Slowed');
        else if (fx.speedUp) activeLabels.push('Speed Up');
        if (fx.reverb && !fx.slowed) activeLabels.push('Реверберация');
        if (fx.spatial8d) activeLabels.push('8D аудио');
      }
      const hasActiveFx =
        fx.enabled && (derived.speed !== 1 || derived.reverb > 0 || derived.spatial);

      if (!hasActiveFx) {
        await shareFileUri(resolveTrackUri(target.uri || target.id), target);
        return;
      }

      const fxName = activeLabels.join(' · ') || 'Звуковые эффекты';
      Alert.alert(
        'Поделиться треком',
        `${target.artist} — ${target.title}\nВключён эффект: ${fxName}`,
        [
          {
            text: `С эффектом (${fxName})`,
            onPress: async () => {
              const nativeFx = WoufyFX;
              if (!nativeFx || typeof nativeFx.exportTrackWithFx !== 'function') {
                Alert.alert(
                  'Экспорт с эффектом',
                  'Рендер аудиофайла с эффектами доступен в нативной сборке iOS (.ipa). Отправляем оригинальный файл.',
                  [{ text: 'ОК', onPress: () => shareFileUri(resolveTrackUri(target.uri || target.id), target) }]
                );
                return;
              }
              setExportingFx(true);
              try {
                const outUri = await nativeFx.exportTrackWithFx({
                  uri: resolveTrackUri(target.uri || target.id),
                  title: `${target.artist} - ${target.title}`,
                  speed: derived.speed,
                  reverbAmount: derived.reverb,
                  spatial8d: derived.spatial,
                });
                setExportingFx(false);
                await shareFileUri(outUri, target, ` (${fxName})`);
              } catch (e: any) {
                setExportingFx(false);
                Alert.alert('Ошибка обработки', e?.message || 'Не удалось применить эффект к файлу');
              }
            },
          },
          {
            text: 'Без эффекта (оригинал)',
            onPress: () => shareFileUri(resolveTrackUri(target.uri || target.id), target),
          },
          { text: 'Отмена', style: 'cancel' },
        ]
      );
    },
    [state.queue, state.index, fx, shareFileUri]
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
      const cur = bpm ? Math.round(bpm) : 120;
      Alert.alert(
        'BPM трека',
        `${track.title}\nТекущий темп: ${bpm ? `${Math.round(bpm)} BPM` : 'Определяется автоматически'}`,
        [
          { text: 'Авто (Сброс)', style: 'destructive', onPress: () => bpmService.setManual(track.id, null) },
          { text: `${Math.max(40, cur - 1)} BPM (-1)`, onPress: () => bpmService.setManual(track.id, Math.max(40, cur - 1)) },
          { text: `${Math.min(240, cur + 1)} BPM (+1)`, onPress: () => bpmService.setManual(track.id, Math.min(240, cur + 1)) },
        ],
        { cancelable: true }
      );
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
            allTracks={allTracks}
            currentIndex={state.index}
            currentTrackId={engine.currentTrack?.id}
            isPlaying={state.isPlaying}
            searchQuery={search}
            onSearchChange={setSearch}
            sortMode={state.sort}
            onSortChange={(m) => engine.setFilter({ sort: m })}
            searchLyrics={searchLyrics}
            onSearchLyricsChange={setSearchLyrics}
            onlyWithLyrics={onlyWithLyrics}
            onOnlyWithLyricsChange={setOnlyWithLyrics}
            onlyWithArtwork={onlyWithArtwork}
            onOnlyWithArtworkChange={setOnlyWithArtwork}
            pinned={state.pinned}
            customReordered={state.customReordered}
            onResetCustomReorder={() => engine.resetCustomReorder()}
            onPlay={(i, track) => (track ? engine.playTrack(track) : engine.playIndex(i))}
            onPlayTrackWithSeek={(track, seekTime) => engine.playTrack(track, seekTime)}
            onMove={(a, b) => engine.moveQueueItem(a, b)}
            onRefresh={async () => {
              await rescan();
            }}
            bottomPad={bottomPad}
            scrollToCurrentTrigger={scrollToCurrentTrigger}
            onGestureActiveChange={(active) => setSheetScrollEnabled(!active)}
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
            tracks={allTracks}
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
        hasUpdate={Boolean(updateInfo?.hasUpdate)}
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
        updateInfo={updateInfo}
        onCheckUpdate={handleCheckUpdate}
      />

      {exportingFx && (
        <View style={styles.fxExportOverlay} pointerEvents="auto">
          <View style={styles.fxExportPill}>
            <ActivityIndicator size="small" color={colors.text} />
            <Text style={styles.fxExportText}>Применяем звуковой эффект…</Text>
          </View>
        </View>
      )}
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
  fxExportOverlay: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: 'rgba(0,0,0,0.45)',
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 999,
  },
  fxExportPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: 20,
    paddingVertical: 14,
    borderRadius: 999,
    backgroundColor: 'rgba(24,24,28,0.95)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.2)',
  },
  fxExportText: { color: colors.text, fontSize: 14, fontWeight: '700' },
});
