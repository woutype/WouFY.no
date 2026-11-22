import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Animated,
  Dimensions,
  FlatList,
  KeyboardAvoidingView,
  LayoutAnimation,
  Modal,
  PanResponder,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { BlurView } from 'expo-blur';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { TrackFile } from '../types';
import { colors, formatTime, type } from '../theme';
import { CoverArt, Glass, PressableScale } from './ui';
import {
  checkDownloadBackendHealth,
  DownloadApiError,
  DownloadPhase,
  downloadRemoteTrack,
  getDownloadApiConfig,
  RemoteTrackResult,
  searchRemoteTracks,
  setCustomDownloadApiUrl,
} from '../services/trackDownloader';

interface Props {
  visible: boolean;
  existingTracks: TrackFile[];
  onTrackDownloaded: (track: TrackFile) => Promise<void> | void;
  onPlayTrack?: (track: TrackFile) => void;
  onClose: () => void;
}

interface DownloadTaskState {
  phase: DownloadPhase | 'error';
  /** 0..1 */
  progress: number;
  error?: string;
  savedTrack?: TrackFile;
}

const DEBOUNCE_MS = 420;
const SCREEN_H = Dimensions.get('window').height;

function normalizeKey(artist: string, title: string): string {
  return `${artist}__${title}`
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

export const TrackDownloadModal: React.FC<Props> = ({
  visible,
  existingTracks,
  onTrackDownloaded,
  onPlayTrack,
  onClose,
}) => {
  const insets = useSafeAreaInsets();
  const panY = useRef(new Animated.Value(SCREEN_H)).current;

  const [titleQuery, setTitleQuery] = useState('');
  const [artistQuery, setArtistQuery] = useState('');
  const [results, setResults] = useState<RemoteTrackResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [hasSearched, setHasSearched] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);

  const [showServerConfig, setShowServerConfig] = useState(false);
  const [apiUrlInput, setApiUrlInput] = useState('');
  const [configuredUrl, setConfiguredUrl] = useState('');
  const [checkingHealth, setCheckingHealth] = useState(false);
  const [healthStatus, setHealthStatus] = useState<'idle' | 'ok' | 'fail'>('idle');

  const [downloads, setDownloads] = useState<Record<string, DownloadTaskState>>({});

  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const searchAbortRef = useRef<AbortController | null>(null);
  const downloadAbortsRef = useRef<Map<string, AbortController>>(new Map());
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (debounceRef.current) clearTimeout(debounceRef.current);
      searchAbortRef.current?.abort();
      for (const ctrl of downloadAbortsRef.current.values()) ctrl.abort();
      downloadAbortsRef.current.clear();
    };
  }, []);

  // Индекс уже существующих треков в локальной библиотеке для бейджа «В библиотеке»
  const existingMap = useMemo(() => {
    const map = new Map<string, TrackFile>();
    for (const t of existingTracks) {
      map.set(normalizeKey(t.artist, t.title), t);
    }
    return map;
  }, [existingTracks]);

  // Синхронизация URL бэкенда и анимация открытия
  useEffect(() => {
    if (!visible) return;
    const cfg = getDownloadApiConfig();
    setConfiguredUrl(cfg.baseUrl);
    setApiUrlInput(cfg.baseUrl);
    setHealthStatus('idle');
    setShowServerConfig(!cfg.baseUrl);

    panY.setValue(SCREEN_H);
    Animated.spring(panY, {
      toValue: 0,
      damping: 26,
      stiffness: 230,
      mass: 0.95,
      useNativeDriver: true,
    }).start();

    // Тихо «прогреваем» Render-инстанс при открытии окна
    if (cfg.baseUrl) {
      checkDownloadBackendHealth()
        .then((ok) => {
          if (mountedRef.current) setHealthStatus(ok ? 'ok' : 'idle');
        })
        .catch(() => {});
    }
  }, [visible, panY]);

  const handleClose = useCallback(() => {
    if (debounceRef.current) {
      clearTimeout(debounceRef.current);
      debounceRef.current = null;
    }
    searchAbortRef.current?.abort();
    Animated.timing(panY, {
      toValue: SCREEN_H,
      duration: 210,
      useNativeDriver: true,
    }).start(() => {
      onClose();
    });
  }, [onClose, panY]);

  const panResponder = useRef(
    PanResponder.create({
      onMoveShouldSetPanResponder: (_, g) => g.dy > 10 && Math.abs(g.dy) > Math.abs(g.dx) * 1.4,
      onPanResponderMove: (_, g) => {
        if (g.dy > 0) panY.setValue(g.dy);
      },
      onPanResponderRelease: (_, g) => {
        if (g.dy > 130 || g.vy > 0.65) {
          handleClose();
        } else {
          Animated.spring(panY, { toValue: 0, useNativeDriver: true, damping: 22, stiffness: 260 }).start();
        }
      },
    })
  ).current;

  const runSearch = useCallback(async (title: string, artist: string) => {
    const t = title.trim();
    const a = artist.trim();
    const combinedLen = t.length + a.length;

    searchAbortRef.current?.abort();

    if (combinedLen < 2) {
      setSearching(false);
      setHasSearched(false);
      setSearchError(null);
      setResults([]);
      return;
    }

    if (!getDownloadApiConfig().baseUrl) {
      setSearching(false);
      setHasSearched(false);
      setSearchError('Сначала укажите URL сервера на Render.');
      setShowServerConfig(true);
      return;
    }

    const ctrl = new AbortController();
    searchAbortRef.current = ctrl;
    setSearching(true);
    setSearchError(null);

    try {
      const items = await searchRemoteTracks({
        title: t,
        artist: a || undefined,
        limit: 25,
        signal: ctrl.signal,
      });
      if (!mountedRef.current || ctrl.signal.aborted) return;
      LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
      setResults(items);
      setHasSearched(true);
      setHealthStatus('ok');
    } catch (e: any) {
      if (!mountedRef.current || ctrl.signal.aborted) return;
      if (e instanceof DownloadApiError && e.code === 'ABORTED') return;
      setSearchError(e?.message || 'Не удалось выполнить поиск.');
      setHasSearched(true);
    } finally {
      if (mountedRef.current && !ctrl.signal.aborted) {
        setSearching(false);
      }
    }
  }, []);

  // Debounced поиск в реальном времени при вводе названия или исполнителя
  useEffect(() => {
    if (!visible) return;
    if (debounceRef.current) clearTimeout(debounceRef.current);

    const trimmedLen = titleQuery.trim().length + artistQuery.trim().length;
    if (trimmedLen < 2) {
      searchAbortRef.current?.abort();
      setSearching(false);
      setHasSearched(false);
      setSearchError(null);
      setResults([]);
      return;
    }

    if (!configuredUrl) return;

    debounceRef.current = setTimeout(() => {
      runSearch(titleQuery, artistQuery);
    }, DEBOUNCE_MS);

    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [visible, titleQuery, artistQuery, configuredUrl, runSearch]);

  const handleSubmitSearch = useCallback(() => {
    if (debounceRef.current) {
      clearTimeout(debounceRef.current);
      debounceRef.current = null;
    }
    runSearch(titleQuery, artistQuery);
  }, [runSearch, titleQuery, artistQuery]);

  const handleSaveServerUrl = useCallback(async () => {
    Haptics.selectionAsync();
    const saved = setCustomDownloadApiUrl(apiUrlInput);
    setConfiguredUrl(saved);
    setApiUrlInput(saved);
    setSearchError(null);
    setHealthStatus('idle');

    if (!saved) {
      return;
    }

    setCheckingHealth(true);
    const ok = await checkDownloadBackendHealth();
    if (!mountedRef.current) return;
    setCheckingHealth(false);
    setHealthStatus(ok ? 'ok' : 'fail');
    if (ok) {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
      setShowServerConfig(false);
      if (titleQuery.trim().length + artistQuery.trim().length >= 2) {
        runSearch(titleQuery, artistQuery);
      }
    }
  }, [apiUrlInput, titleQuery, artistQuery, runSearch]);

  const handleStartDownload = useCallback(
    async (item: RemoteTrackResult) => {
      const existingAbort = downloadAbortsRef.current.get(item.id);
      if (existingAbort) {
        // Повторное нажатие во время загрузки — отмена
        Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
        existingAbort.abort();
        downloadAbortsRef.current.delete(item.id);
        setDownloads((prev) => {
          const next = { ...prev };
          delete next[item.id];
          return next;
        });
        return;
      }

      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
      const ctrl = new AbortController();
      downloadAbortsRef.current.set(item.id, ctrl);

      setDownloads((prev) => ({
        ...prev,
        [item.id]: { phase: 'preparing', progress: 0 },
      }));

      try {
        const savedTrack = await downloadRemoteTrack(item, {
          signal: ctrl.signal,
          onProgress: (ev) => {
            if (!mountedRef.current) return;
            setDownloads((prev) => ({
              ...prev,
              [item.id]: {
                phase: ev.phase,
                progress: ev.progress,
              },
            }));
          },
        });

        await onTrackDownloaded(savedTrack);

        if (!mountedRef.current) return;
        downloadAbortsRef.current.delete(item.id);
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
        setDownloads((prev) => ({
          ...prev,
          [item.id]: {
            phase: 'done',
            progress: 1,
            savedTrack,
          },
        }));
      } catch (e: any) {
        downloadAbortsRef.current.delete(item.id);
        if (!mountedRef.current) return;
        if (e instanceof DownloadApiError && e.code === 'ABORTED') {
          setDownloads((prev) => {
            const next = { ...prev };
            delete next[item.id];
            return next;
          });
          return;
        }
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
        setDownloads((prev) => ({
          ...prev,
          [item.id]: {
            phase: 'error',
            progress: 0,
            error: e?.message || 'Ошибка скачивания',
          },
        }));
      }
    },
    [onTrackDownloaded]
  );

  const renderItem = useCallback(
    ({ item }: { item: RemoteTrackResult }) => {
      const task = downloads[item.id];
      const existingTrack = task?.savedTrack ?? existingMap.get(normalizeKey(item.artist, item.title));
      const isBusy = task?.phase === 'preparing' || task?.phase === 'downloading' || task?.phase === 'tagging';
      const isDone = task?.phase === 'done';
      const isError = task?.phase === 'error';
      const pct = Math.round((task?.progress ?? 0) * 100);

      const handleRowPress = () => {
        if (existingTrack && onPlayTrack) {
          Haptics.selectionAsync();
          onPlayTrack(existingTrack);
          handleClose();
          return;
        }
        if (!isBusy) {
          handleStartDownload(item);
        }
      };

      const fillWidth =
        task?.phase === 'tagging'
          ? '100%'
          : task?.phase === 'downloading'
            ? `${Math.max(10, pct)}%`
            : '12%';

      return (
        <View style={styles.resultItem}>
          <Glass radius={999} intensity={40} style={styles.resultGlass}>
            {/* Плавное заполнение фона карточки слева направо по мере загрузки */}
            {isBusy && (
              <View
                pointerEvents="none"
                style={[styles.progressBgFill, { width: fillWidth }]}
              />
            )}

            <Pressable style={styles.resultRow} onPress={handleRowPress}>
              <CoverArt uri={item.thumbnailUrl || item.coverUrl} size={48} radius={24} />

              <View style={styles.resultMeta}>
                <View style={styles.resultTitleRow}>
                  <Text style={styles.resultTitle} numberOfLines={1}>
                    {item.title}
                    {item.subtitle ? ` (${item.subtitle})` : ''}
                  </Text>
                  {item.explicit && (
                    <View style={styles.explicitBadge}>
                      <Text style={styles.explicitText}>E</Text>
                    </View>
                  )}
                </View>

                <Text style={styles.resultArtist} numberOfLines={1}>
                  {item.artist}
                  {item.album ? ` · ${item.album}` : ''}
                </Text>

                {isError && task?.error ? (
                  <Text style={styles.errorInline} numberOfLines={1}>
                    {task.error}
                  </Text>
                ) : (
                  <View style={styles.badgesRow}>
                    {item.duration ? (
                      <Text style={styles.metaText}>{formatTime(item.duration)}</Text>
                    ) : null}
                    {item.bitrate ? (
                      <View style={styles.metaPill}>
                        <Text style={styles.metaPillText}>{item.bitrate} kbps</Text>
                      </View>
                    ) : null}
                    {item.hasLyrics ? (
                      <View style={styles.metaPill}>
                        <Text style={styles.metaPillText}>Текст</Text>
                      </View>
                    ) : null}
                    {existingTrack && !isBusy ? (
                      <View style={[styles.metaPill, styles.inLibPill]}>
                        <Ionicons name="checkmark" size={10} color={colors.accent} />
                        <Text style={[styles.metaPillText, { color: colors.accent }]}>
                          {isDone ? 'Добавлен' : 'В библиотеке'}
                        </Text>
                      </View>
                    ) : null}
                  </View>
                )}
              </View>

              {/* Кнопка скачивания / индикатор прогресса / статус */}
              <PressableScale
                onPress={() => {
                  if (isDone && existingTrack && onPlayTrack) {
                    onPlayTrack(existingTrack);
                    handleClose();
                  } else {
                    handleStartDownload(item);
                  }
                }}
                scaleTo={0.9}
                haptic="none"
                hitSlop={8}
              >
                {isDone ? (
                  <View style={[styles.actionBtn, styles.actionBtnDone]}>
                    <Ionicons name={onPlayTrack ? 'play' : 'checkmark'} size={17} color={colors.onAccent} />
                  </View>
                ) : isBusy ? (
                  <View style={[styles.actionBtn, styles.actionBtnBusy]}>
                    {task?.phase === 'downloading' && pct > 0 ? (
                      <Text style={styles.progressPct}>{pct}%</Text>
                    ) : (
                      <ActivityIndicator size="small" color={colors.accent} />
                    )}
                  </View>
                ) : isError ? (
                  <View style={[styles.actionBtn, styles.actionBtnError]}>
                    <Ionicons name="refresh" size={17} color={colors.danger} />
                  </View>
                ) : (
                  <View style={styles.actionBtn}>
                    <Ionicons name="download-outline" size={18} color={colors.text} />
                  </View>
                )}
              </PressableScale>
            </Pressable>
          </Glass>
        </View>
      );
    },
    [downloads, existingMap, onPlayTrack, handleClose, handleStartDownload]
  );

  if (!visible) return null;

  const topOffset = Math.max(insets.top + 6, 16);
  const bottomPad = Math.max(insets.bottom + 24, 36);

  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      statusBarTranslucent
      onRequestClose={handleClose}
    >
      <View style={styles.backdrop}>
        <Pressable style={StyleSheet.absoluteFill} onPress={handleClose} />

        <Animated.View
          style={[
            styles.sheet,
            {
              marginTop: topOffset,
              transform: [{ translateY: panY }],
            },
          ]}
        >
          {Platform.OS === 'ios' ? (
            <BlurView intensity={78} tint="dark" style={StyleSheet.absoluteFill} />
          ) : null}
          <View style={[StyleSheet.absoluteFill, styles.sheetTint]} pointerEvents="none" />
          {/* Равномерная обводка со скруглением: не прерывается на углах CoreAnimation */}
          <View style={styles.sheetBorder} pointerEvents="none" />

          <KeyboardAvoidingView
            style={{ flex: 1 }}
            behavior={Platform.OS === 'ios' ? 'padding' : undefined}
          >
            {/* Шапка плавающего экрана */}
            <View style={styles.header} {...panResponder.panHandlers}>
              <View style={styles.grabber} />

              <View style={styles.headerRow}>
                <View style={styles.titleWrap}>
                  <View style={styles.titleIcon}>
                    <Ionicons name="download-outline" size={18} color={colors.text} />
                  </View>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.title}>Скачать треки</Text>
                    <Text style={styles.subtitle} numberOfLines={1}>
                      {configuredUrl ? 'Поиск и загрузка в библиотеку' : 'Требуется подключение сервера'}
                    </Text>
                  </View>
                </View>

                <View style={styles.headerActions}>
                  <PressableScale onPress={handleClose} scaleTo={0.92} haptic="light">
                    <View style={styles.iconBtn}>
                      <Ionicons name="close" size={19} color={colors.text2} />
                    </View>
                  </PressableScale>
                </View>
              </View>

              {/* Поля ввода: название трека и (опционально) исполнитель */}
              <View style={styles.inputsStack}>
                <Glass radius={999} intensity={40} style={styles.inputGlass}>
                  <View style={styles.inputBox}>
                    <Ionicons name="search" size={17} color={colors.text3} style={{ marginLeft: 14 }} />
                    <TextInput
                      style={styles.input}
                      placeholder="Название трека…"
                      placeholderTextColor={colors.text3}
                      value={titleQuery}
                      onChangeText={setTitleQuery}
                      autoFocus={Boolean(configuredUrl)}
                      autoCorrect={false}
                      returnKeyType="search"
                      onSubmitEditing={handleSubmitSearch}
                      selectionColor={colors.text}
                    />
                    {searching ? (
                      <ActivityIndicator size="small" color={colors.accent} style={{ marginRight: 14 }} />
                    ) : titleQuery.length > 0 ? (
                      <PressableScale onPress={() => setTitleQuery('')} hitSlop={10} style={{ marginRight: 12 }}>
                        <Ionicons name="close-circle" size={18} color={colors.text3} />
                      </PressableScale>
                    ) : null}
                  </View>
                </Glass>

                <Glass radius={999} intensity={32} style={styles.inputGlassSecondary}>
                  <View style={styles.inputBoxSecondary}>
                    <Ionicons name="person-outline" size={15} color={colors.text3} style={{ marginLeft: 14 }} />
                    <TextInput
                      style={styles.inputSecondary}
                      placeholder="Исполнитель (необязательно)…"
                      placeholderTextColor={colors.text3}
                      value={artistQuery}
                      onChangeText={setArtistQuery}
                      autoCorrect={false}
                      returnKeyType="search"
                      onSubmitEditing={handleSubmitSearch}
                      selectionColor={colors.text}
                    />
                    {artistQuery.length > 0 && (
                      <PressableScale onPress={() => setArtistQuery('')} hitSlop={10} style={{ marginRight: 12 }}>
                        <Ionicons name="close-circle" size={16} color={colors.text3} />
                      </PressableScale>
                    )}
                  </View>
                </Glass>
              </View>

              {(results.length > 0 || searching) && (
                <View style={styles.metaBar}>
                  <Text style={styles.metaBarText}>
                    {searching ? 'Ищем треки…' : `Найдено: ${results.length}`}
                  </Text>
                </View>
              )}
            </View>

            <View style={styles.dividerWrap} pointerEvents="none">
              <LinearGradient
                start={{ x: 0, y: 0 }}
                end={{ x: 1, y: 0 }}
                colors={['rgba(255,255,255,0)', 'rgba(255,255,255,0.15)', 'rgba(255,255,255,0)']}
                style={styles.divider}
              />
            </View>

            {/* Список результатов */}
            <FlatList
              data={results}
              keyExtractor={(item) => item.id}
              renderItem={renderItem}
              showsVerticalScrollIndicator={false}
              keyboardShouldPersistTaps="handled"
              keyboardDismissMode="on-drag"
              contentContainerStyle={[styles.listContent, { paddingBottom: bottomPad }]}
              ListEmptyComponent={
                <View style={styles.emptyBox}>
                  {!configuredUrl ? (
                    <>
                      <Ionicons name="cloud-offline-outline" size={40} color={colors.text3} />
                      <Text style={styles.emptyTitle}>Сервер не подключён</Text>
                      <Text style={styles.emptySub}>
                        Укажите адрес вашего бэкенда на Render в поле выше или в переменной EXPO_PUBLIC_DOWNLOAD_API_URL.
                      </Text>
                    </>
                  ) : searching ? (
                    <>
                      <ActivityIndicator size="large" color={colors.text2} />
                      <Text style={styles.emptyTitle}>Поиск треков…</Text>
                      <Text style={styles.emptySub}>Запрашиваем результаты с сервера</Text>
                    </>
                  ) : searchError ? (
                    <>
                      <Ionicons name="alert-circle-outline" size={40} color={colors.danger} />
                      <Text style={styles.emptyTitle}>Ошибка поиска</Text>
                      <Text style={styles.emptySub}>{searchError}</Text>
                      <PressableScale onPress={handleSubmitSearch} scaleTo={0.95} style={{ marginTop: 8 }}>
                        <View style={styles.retryPill}>
                          <Ionicons name="refresh" size={15} color={colors.onAccent} />
                          <Text style={styles.retryPillText}>Повторить</Text>
                        </View>
                      </PressableScale>
                    </>
                  ) : hasSearched ? (
                    <>
                      <Ionicons name="search-outline" size={40} color={colors.text3} />
                      <Text style={styles.emptyTitle}>Ничего не найдено</Text>
                      <Text style={styles.emptySub}>
                        Попробуйте уточнить название трека или имя исполнителя
                      </Text>
                    </>
                  ) : (
                    <>
                      <Ionicons name="musical-notes-outline" size={40} color="rgba(255,255,255,0.22)" />
                      <Text style={styles.emptyTitle}>Найдите нужный трек</Text>
                      <Text style={styles.emptySub}>
                        Введите название и при желании исполнителя — результаты появятся автоматически, а скачанные файлы сразу попадут в вашу фонотеку с обложкой и тегами
                      </Text>
                    </>
                  )}
                </View>
              }
            />
          </KeyboardAvoidingView>
        </Animated.View>
      </View>
    </Modal>
  );
};

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.72)',
  },
  sheet: {
    flex: 1,
    borderTopLeftRadius: 32,
    borderTopRightRadius: 32,
    overflow: 'hidden',
    backgroundColor: Platform.OS === 'ios' ? 'rgba(14,14,18,0.84)' : 'rgba(14,14,18,0.97)',
  },
  sheetTint: {
    backgroundColor: 'rgba(8,8,10,0.34)',
  },
  sheetBorder: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: -2,
    borderTopLeftRadius: 32,
    borderTopRightRadius: 32,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.14)',
  },
  header: {
    paddingHorizontal: 18,
    paddingTop: 10,
    paddingBottom: 12,
  },
  dividerWrap: {
    paddingHorizontal: 18,
  },
  divider: {
    height: StyleSheet.hairlineWidth,
    width: '100%',
  },
  grabber: {
    width: 36,
    height: 4,
    borderRadius: 999,
    backgroundColor: 'rgba(255,255,255,0.22)',
    alignSelf: 'center',
    marginBottom: 12,
  },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 14,
  },
  titleWrap: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    flex: 1,
    marginRight: 10,
  },
  titleIcon: {
    width: 38,
    height: 38,
    borderRadius: 999,
    backgroundColor: 'rgba(255,255,255,0.08)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.15)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  title: {
    ...type.headline,
    fontSize: 18,
    color: colors.text,
    fontWeight: '700',
  },
  subtitle: {
    ...type.caption,
    fontSize: 11,
    color: colors.text3,
    marginTop: 1,
  },
  headerActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  iconBtn: {
    width: 36,
    height: 36,
    borderRadius: 999,
    backgroundColor: 'rgba(255,255,255,0.08)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.15)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  iconBtnActive: {
    backgroundColor: colors.accent,
    borderColor: colors.accent,
  },
  statusDot: {
    position: 'absolute',
    top: 5,
    right: 5,
    width: 7,
    height: 7,
    borderRadius: 999,
    borderWidth: 1,
  },
  serverCard: {
    padding: 14,
    marginBottom: 12,
  },
  serverLabel: {
    ...type.caption,
    fontSize: 10,
    fontWeight: '700',
    letterSpacing: 0.6,
    color: colors.text3,
    marginBottom: 8,
    paddingHorizontal: 4,
  },
  serverRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  serverInput: {
    flex: 1,
    height: 40,
    borderRadius: 999,
    paddingHorizontal: 14,
    backgroundColor: 'rgba(255,255,255,0.07)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.13)',
    color: colors.text,
    fontSize: 13,
  },
  serverSaveBtn: {
    height: 40,
    paddingHorizontal: 16,
    borderRadius: 999,
    backgroundColor: colors.accent,
    alignItems: 'center',
    justifyContent: 'center',
    minWidth: 94,
  },
  serverSaveText: {
    color: colors.onAccent,
    fontSize: 13,
    fontWeight: '700',
  },
  serverHint: {
    ...type.caption,
    fontSize: 11,
    color: colors.text3,
    marginTop: 8,
    paddingHorizontal: 4,
    lineHeight: 16,
  },
  inputsStack: {
    gap: 8,
  },
  inputGlass: {
    height: 44,
  },
  inputBox: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
  },
  input: {
    flex: 1,
    ...type.body,
    fontSize: 15,
    color: colors.text,
    paddingHorizontal: 10,
    paddingVertical: 0,
  },
  inputGlassSecondary: {
    height: 40,
  },
  inputBoxSecondary: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
  },
  inputSecondary: {
    flex: 1,
    ...type.body,
    fontSize: 14,
    color: colors.text,
    paddingHorizontal: 10,
    paddingVertical: 0,
  },
  metaBar: {
    marginTop: 10,
    paddingHorizontal: 4,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  metaBarText: {
    ...type.caption,
    fontSize: 12,
    color: colors.text3,
  },
  listContent: {
    paddingHorizontal: 16,
    paddingTop: 12,
  },
  resultItem: {
    marginBottom: 10,
  },
  resultGlass: {
    overflow: 'hidden',
  },
  resultRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 10,
    paddingHorizontal: 12,
    gap: 12,
  },
  resultMeta: {
    flex: 1,
    minWidth: 0,
  },
  resultTitleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  resultTitle: {
    ...type.headline,
    fontSize: 15,
    color: colors.text,
    fontWeight: '700',
    flexShrink: 1,
  },
  explicitBadge: {
    paddingHorizontal: 6,
    paddingVertical: 1.5,
    borderRadius: 999,
    backgroundColor: 'rgba(255,255,255,0.14)',
  },
  explicitText: {
    fontSize: 9,
    fontWeight: '800',
    color: colors.text2,
  },
  resultArtist: {
    ...type.caption,
    fontSize: 13,
    color: colors.text2,
    marginTop: 2,
  },
  badgesRow: {
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: 6,
    marginTop: 5,
  },
  metaText: {
    ...type.mono,
    fontSize: 11,
    color: colors.text3,
  },
  metaPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
    paddingHorizontal: 8,
    paddingVertical: 2.5,
    borderRadius: 999,
    backgroundColor: 'rgba(255,255,255,0.07)',
  },
  inLibPill: {
    backgroundColor: 'rgba(255,255,255,0.12)',
  },
  metaPillText: {
    fontSize: 10,
    fontWeight: '600',
    color: colors.text2,
  },
  errorInline: {
    ...type.caption,
    fontSize: 11,
    color: colors.danger,
    marginTop: 4,
  },
  actionBtn: {
    width: 40,
    height: 40,
    borderRadius: 999,
    backgroundColor: 'rgba(255,255,255,0.08)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.15)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  actionBtnBusy: {
    backgroundColor: 'rgba(255,255,255,0.12)',
    borderColor: 'rgba(255,255,255,0.28)',
  },
  actionBtnDone: {
    backgroundColor: colors.accent,
    borderColor: colors.accent,
  },
  actionBtnError: {
    backgroundColor: 'rgba(255,107,107,0.12)',
    borderColor: 'rgba(255,107,107,0.35)',
  },
  progressPct: {
    ...type.mono,
    fontSize: 10,
    fontWeight: '700',
    color: colors.text,
  },
  progressBgFill: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    left: 0,
    backgroundColor: 'rgba(255,255,255,0.11)',
  },
  emptyBox: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingTop: 72,
    paddingHorizontal: 28,
    gap: 8,
  },
  emptyTitle: {
    ...type.headline,
    fontSize: 17,
    color: colors.text,
    marginTop: 6,
  },
  emptySub: {
    ...type.caption,
    fontSize: 13,
    color: colors.text3,
    textAlign: 'center',
    lineHeight: 19,
  },
  retryPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 18,
    paddingVertical: 10,
    borderRadius: 999,
    backgroundColor: colors.accent,
  },
  retryPillText: {
    fontSize: 13,
    fontWeight: '700',
    color: colors.onAccent,
  },
});
