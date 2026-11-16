import React, { useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { Animated, FlatList, LayoutAnimation, PanResponder, Pressable, StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { statsService, StatsPeriod, TrackStatsSummary, ArtistStatsSummary } from '../services/statsService';
import { TrackFile } from '../types';
import { colors, type } from '../theme';
import { CoverArt, Glass, PressableScale } from './ui';
import { ArtistAvatar } from './ArtistAvatar';

interface Props {
  tracks: TrackFile[];
  onPlayTopTracks: (topTracks: TrackFile[], index: number) => void;
  onArtistPress: (artist: string) => void;
  bottomPad: number;
  visible?: boolean;
}

const PERIODS: { key: StatsPeriod; label: string }[] = [
  { key: '3days', label: '3 дня' },
  { key: 'week', label: 'Неделя' },
  { key: 'month', label: 'Месяц' },
];

function fmtHours(seconds: number): string {
  if (seconds < 60) return `${seconds} сек`;
  const m = Math.floor(seconds / 60);
  if (m < 60) return `${m} мин`;
  const h = (seconds / 3600).toFixed(1);
  return `${h.replace('.0', '')} ч`;
}

function fmtTrackTime(seconds: number): string {
  if (seconds < 60) return `${seconds} сек`;
  const m = Math.floor(seconds / 60);
  if (m < 60) return `${m} мин`;
  const h = Math.floor(m / 60);
  const remM = m % 60;
  return remM > 0 ? `${h} ч ${remM} мин` : `${h} ч`;
}

function pluralPlays(n: number): string {
  const a = n % 10;
  const b = n % 100;
  if (a === 1 && b !== 11) return 'прослушивание';
  if (a >= 2 && a <= 4 && (b < 12 || b > 14)) return 'прослушивания';
  return 'прослушиваний';
}

function RankBadge({ rank }: { rank: number }) {
  return (
    <View style={styles.rankBox}>
      <Text style={[styles.rankNum, rank <= 3 && styles.rankTopNum]}>{rank}</Text>
    </View>
  );
}

const SwipeableStatsRow: React.FC<{
  onReset: () => void;
  onPress: () => void;
  children: React.ReactNode;
}> = ({ onReset, onPress, children }) => {
  const panX = useRef(new Animated.Value(0)).current;
  const isOpen = useRef(false);

  const close = () => {
    isOpen.current = false;
    Animated.spring(panX, { toValue: 0, useNativeDriver: true, damping: 22, stiffness: 280, mass: 0.9 }).start();
  };

  const open = () => {
    isOpen.current = true;
    Animated.spring(panX, { toValue: -82, useNativeDriver: true, damping: 22, stiffness: 280, mass: 0.9 }).start();
  };

  const responder = useRef(
    PanResponder.create({
      onMoveShouldSetPanResponderCapture: (_, g) => {
        if (isOpen.current) {
          return Math.abs(g.dx) > 4;
        }
        return g.dx < -8 && Math.abs(g.dx) > Math.abs(g.dy) * 1.2;
      },
      onMoveShouldSetPanResponder: (_, g) => {
        if (isOpen.current) {
          return Math.abs(g.dx) > 4;
        }
        return g.dx < -8 && Math.abs(g.dx) > Math.abs(g.dy) * 1.2;
      },
      onPanResponderTerminationRequest: () => false,
      onPanResponderGrant: () => {
        panX.stopAnimation();
      },
      onPanResponderMove: (_, g) => {
        const base = isOpen.current ? -82 : 0;
        const v = Math.min(0, Math.max(-100, base + g.dx));
        panX.setValue(v);
      },
      onPanResponderRelease: (_, g) => {
        if (isOpen.current) {
          if (g.dx > 18 || g.vx > 0.25) {
            close();
          } else {
            open();
          }
        } else {
          if (g.dx < -32 || g.vx < -0.3) {
            open();
            Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
          } else {
            close();
          }
        }
      },
      onPanResponderTerminate: close,
    })
  ).current;

  const handleRowPress = () => {
    if (isOpen.current) {
      close();
    } else {
      onPress();
    }
  };

  const handleResetPress = () => {
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
    close();
    onReset();
  };

  // Кнопка удаления абсолютно невидима до начала свайпа (не просвечивает сквозь стекло)
  const btnOpacity = panX.interpolate({
    inputRange: [-82, -20, 0],
    outputRange: [1, 0.4, 0],
    extrapolate: 'clamp',
  });

  const btnScale = panX.interpolate({
    inputRange: [-82, 0],
    outputRange: [1, 0.75],
    extrapolate: 'clamp',
  });

  return (
    <View style={styles.swipeRowWrapper}>
      <Animated.View
        style={[
          styles.resetBackdrop,
          {
            opacity: btnOpacity,
            transform: [{ scale: btnScale }],
          },
        ]}
      >
        <Pressable onPress={handleResetPress} style={styles.resetBtnAction}>
          <Ionicons name="trash-outline" size={20} color="#FFFFFF" />
          <Text style={styles.resetBtnText}>Сброс</Text>
        </Pressable>
      </Animated.View>
      <Animated.View style={{ transform: [{ translateX: panX }] }} {...responder.panHandlers}>
        <PressableScale onPress={handleRowPress} scaleTo={0.98} haptic="none">
          {children}
        </PressableScale>
      </Animated.View>
    </View>
  );
};

export const StatsView: React.FC<Props> = ({
  tracks,
  onPlayTopTracks,
  onArtistPress,
  bottomPad,
}) => {
  const { width: screenWidth } = useWindowDimensions();
  const [period, setPeriod] = useState<StatsPeriod>('3days');
  const [activeTab, setActiveTab] = useState<'tracks' | 'artists'>('tracks');

  const PERIOD_INDEX: Record<StatsPeriod, number> = { '3days': 0, week: 1, month: 2 };
  const [periodInnerWidth, setPeriodInnerWidth] = useState(250);
  const periodAnim = useRef(new Animated.Value(0)).current;

  const [subTabWidth, setSubTabWidth] = useState(screenWidth - 46);
  const tabAnim = useRef(new Animated.Value(activeTab === 'tracks' ? 0 : 1)).current;

  const handlePeriodSwitch = (target: StatsPeriod) => {
    if (target === period) return;
    Haptics.selectionAsync();
    LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
    setPeriod(target);
    Animated.spring(periodAnim, {
      toValue: PERIOD_INDEX[target],
      damping: 24,
      stiffness: 280,
      mass: 0.8,
      useNativeDriver: false,
    }).start();
  };

  const handleTabSwitch = (target: 'tracks' | 'artists') => {
    if (target === activeTab) return;
    Haptics.selectionAsync();
    setActiveTab(target);
    Animated.spring(tabAnim, {
      toValue: target === 'tracks' ? 0 : 1,
      damping: 24,
      stiffness: 280,
      mass: 0.8,
      useNativeDriver: false,
    }).start();
  };

  // Реактивная подписка на обновления статистики в реальном времени
  useSyncExternalStore(statsService.subscribe.bind(statsService), () => statsService.version);

  const trackMap = useMemo(() => new Map(tracks.map((t) => [t.id, t])), [tracks]);

  const rawTopTracks = useMemo(() => statsService.getTopTracks(period, 10), [period, statsService.version]);
  const rawTopArtists = useMemo(() => statsService.getTopArtists(period, 10), [period, statsService.version]);

  // Разрешаем объекты треков для воспроизведения
  const resolvedTopTracks = useMemo(() => {
    const list: TrackFile[] = [];
    for (const item of rawTopTracks) {
      const found = trackMap.get(item.trackId);
      if (found) {
        list.push(found);
      } else {
        list.push({
          id: item.trackId,
          uri: '',
          filename: item.title,
          title: item.title,
          artist: item.artist,
          artworkUri: item.artworkUri,
          extension: 'mp3',
        });
      }
    }
    return list;
  }, [rawTopTracks, trackMap]);

  const handlePlayAllTop = () => {
    if (resolvedTopTracks.length > 0) {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
      onPlayTopTracks(resolvedTopTracks, 0);
    }
  };

  const periodItemW = Math.max(60, periodInnerWidth / 3);
  const subTabSlotW = Math.max(100, (subTabWidth - 4) / 2);

  return (
    <View style={styles.container}>
      {/* 1. Селектор периода: 3 дня / Неделя / Месяц */}
      <View style={styles.periodRow}>
        <Glass radius={18} style={styles.periodGlass}>
          <View
            style={styles.periodInner}
            onLayout={(e) => setPeriodInnerWidth(e.nativeEvent.layout.width)}
          >
            {/* Плавно скользящий бегунок периода */}
            <Animated.View
              pointerEvents="none"
              style={[
                styles.periodSlidingPill,
                {
                  width: periodItemW,
                  transform: [
                    {
                      translateX: periodAnim.interpolate({
                        inputRange: [0, 1, 2],
                        outputRange: [0, periodItemW, periodItemW * 2],
                      }),
                    },
                  ],
                },
              ]}
            />
            {PERIODS.map((p) => {
              const active = period === p.key;
              return (
                <PressableScale
                  key={p.key}
                  onPress={() => handlePeriodSwitch(p.key)}
                  style={styles.periodBtn}
                  scaleTo={0.95}
                  haptic="selection"
                >
                  <Text style={[styles.periodBtnText, active && styles.periodBtnTextActive]}>
                    {p.label}
                  </Text>
                </PressableScale>
              );
            })}
          </View>
        </Glass>
      </View>

      {/* 2. Переключатель: Трек / Артист (Сегментированная стеклянная плашка) */}
      <View style={styles.subTabRow}>
        <Glass radius={16} style={styles.subTabGlass}>
          <View
            style={styles.subTabInner}
            onLayout={(e) => setSubTabWidth(e.nativeEvent.layout.width)}
          >
            {/* Плавно скользящая белая плашка под вкладками */}
            <Animated.View
              pointerEvents="none"
              style={[
                styles.subTabSlidingPill,
                {
                  width: subTabSlotW,
                  transform: [
                    {
                      translateX: tabAnim.interpolate({
                        inputRange: [0, 1],
                        outputRange: [0, subTabSlotW + 4],
                      }),
                    },
                  ],
                },
              ]}
            />
            <PressableScale
              onPress={() => handleTabSwitch('tracks')}
              style={styles.subTabPressable}
              scaleTo={0.96}
              haptic="selection"
            >
              <View style={styles.subTabBtn}>
                <Ionicons
                  name="musical-notes"
                  size={16}
                  color={activeTab === 'tracks' ? colors.onAccent : colors.text2}
                />
                <Text style={[styles.subTabBtnText, activeTab === 'tracks' && styles.subTabBtnTextActive]}>
                  Трек
                </Text>
              </View>
            </PressableScale>

            <PressableScale
              onPress={() => handleTabSwitch('artists')}
              style={styles.subTabPressable}
              scaleTo={0.96}
              haptic="selection"
            >
              <View style={styles.subTabBtn}>
                <Ionicons
                  name="person"
                  size={16}
                  color={activeTab === 'artists' ? colors.onAccent : colors.text2}
                />
                <Text style={[styles.subTabBtnText, activeTab === 'artists' && styles.subTabBtnTextActive]}>
                  Артист
                </Text>
              </View>
            </PressableScale>
          </View>
        </Glass>
      </View>

      {/* 3. Список треков и артистов с плавной анимацией скольжения и растворения */}
      <View style={{ flex: 1, position: 'relative' }}>
        <Animated.View
          pointerEvents={activeTab === 'tracks' ? 'auto' : 'none'}
          style={[
            StyleSheet.absoluteFill,
            {
              opacity: tabAnim.interpolate({ inputRange: [0, 0.65, 1], outputRange: [1, 0, 0] }),
              transform: [
                {
                  translateX: tabAnim.interpolate({
                    inputRange: [0, 1],
                    outputRange: [0, -screenWidth * 0.22],
                  }),
                },
              ],
            },
          ]}
        >
          <FlatList
            data={rawTopTracks}
            keyExtractor={(item) => item.trackId}
            style={{ flex: 1 }}
            contentContainerStyle={[styles.listContent, { paddingBottom: bottomPad + 30, flexGrow: 1 }]}
            showsVerticalScrollIndicator={false}
            ListHeaderComponent={
              rawTopTracks.length > 0 ? (
                <View style={styles.topActionHeader}>
                  <PressableScale onPress={handlePlayAllTop} scaleTo={0.96} haptic="medium">
                    <Glass radius={14} style={styles.playAllGlass}>
                      <View style={styles.playAllInner}>
                        <Ionicons name="play" size={15} color={colors.accent} />
                        <Text style={styles.playAllText}>Слушать весь топ ({rawTopTracks.length})</Text>
                      </View>
                    </Glass>
                  </PressableScale>
                </View>
              ) : undefined
            }
            ListEmptyComponent={
              <View style={styles.emptyWrap}>
                <Ionicons name="stats-chart-outline" size={42} color={colors.text3} />
                <Text style={styles.emptyTitle}>
                  {period === '3days' ? 'Нет прослушиваний за 3 дня' : period === 'week' ? 'Нет прослушиваний за неделю' : 'Нет прослушиваний за месяц'}
                </Text>
                <Text style={styles.emptySub}>
                  Включите любой трек — уже через 2 секунды он появится на 1-м месте в вашем Топе
                </Text>

                {tracks.length > 0 && (
                  <View style={styles.suggestBox}>
                    <Text style={styles.suggestHeading}>Включить из библиотеки:</Text>
                    {tracks.slice(0, 4).map((t, idx) => (
                      <PressableScale
                        key={t.id}
                        onPress={() => {
                          Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                          onPlayTopTracks([t], 0);
                        }}
                        scaleTo={0.97}
                        haptic="light"
                        style={styles.cardMargin}
                      >
                        <Glass radius={14} style={styles.cardGlass}>
                          <View style={styles.trackRow}>
                            <RankBadge rank={idx + 1} />
                            <CoverArt uri={t.artworkUri} size={42} radius={9} style={styles.cover} />
                            <View style={styles.trackInfo}>
                              <Text style={styles.trackTitle} numberOfLines={1}>{t.title}</Text>
                              <Text style={styles.trackArtist} numberOfLines={1}>{t.artist}</Text>
                            </View>
                            <Ionicons name="play-circle" size={26} color={colors.accent} style={{ marginLeft: 8 }} />
                          </View>
                        </Glass>
                      </PressableScale>
                    ))}
                  </View>
                )}
              </View>
            }
            renderItem={({ item, index }) => (
              <SwipeableStatsRow
                onPress={() => {
                  Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                  onPlayTopTracks(resolvedTopTracks, index);
                }}
                onReset={() => {
                  statsService.resetTrackStats(item.trackId);
                }}
              >
                <Glass radius={16} style={styles.cardGlass}>
                  <View style={styles.trackRow}>
                    <RankBadge rank={index + 1} />
                    <CoverArt uri={item.artworkUri} size={48} radius={11} style={styles.cover} />
                    <View style={styles.trackInfo}>
                      <Text style={styles.trackTitle} numberOfLines={1}>
                        {item.title}
                      </Text>
                      <Text style={styles.trackArtist} numberOfLines={1}>
                        {item.artist}
                      </Text>
                    </View>
                    <View style={styles.statCol}>
                      <Text style={styles.statPlays}>
                        {item.playCount} {pluralPlays(item.playCount)}
                      </Text>
                      <Text style={styles.statTime}>{fmtTrackTime(item.totalDuration)}</Text>
                    </View>
                    <Ionicons name="play-circle" size={26} color={colors.accent} style={{ marginLeft: 8 }} />
                  </View>
                </Glass>
              </SwipeableStatsRow>
            )}
          />
        </Animated.View>

        <Animated.View
          pointerEvents={activeTab === 'artists' ? 'auto' : 'none'}
          style={[
            StyleSheet.absoluteFill,
            {
              opacity: tabAnim.interpolate({ inputRange: [0, 0.35, 1], outputRange: [0, 0, 1] }),
              transform: [
                {
                  translateX: tabAnim.interpolate({
                    inputRange: [0, 1],
                    outputRange: [screenWidth * 0.22, 0],
                  }),
                },
              ],
            },
          ]}
        >
          <FlatList
            data={rawTopArtists}
            keyExtractor={(item) => item.artist}
            style={{ flex: 1 }}
            contentContainerStyle={[styles.listContent, { paddingBottom: bottomPad + 30, flexGrow: 1 }]}
            showsVerticalScrollIndicator={false}
            ListEmptyComponent={
              <View style={styles.emptyWrap}>
                <Ionicons name="people-outline" size={42} color={colors.text3} />
                <Text style={styles.emptyTitle}>Нет данных по артистам</Text>
                <Text style={styles.emptySub}>
                  Здесь будут ваши самые прослушиваемые артисты с точным количеством часов и прослушиваний
                </Text>
              </View>
            }
            renderItem={({ item, index }) => (
              <SwipeableStatsRow
                onPress={() => {
                  Haptics.selectionAsync();
                  onArtistPress(item.artist);
                }}
                onReset={() => {
                  statsService.resetArtistStats(item.artist);
                }}
              >
                <Glass radius={16} style={styles.cardGlass}>
                  <View style={styles.trackRow}>
                    <RankBadge rank={index + 1} />
                    <ArtistAvatar artist={item.artist} tracks={tracks} size={44} />
                    <View style={styles.trackInfo}>
                      <Text style={styles.artistName} numberOfLines={1}>
                        {item.artist}
                      </Text>
                      <Text style={styles.artistSub} numberOfLines={1}>
                        {item.trackCount} {item.trackCount === 1 ? 'трек' : 'треков'} · {item.playCount} {pluralPlays(item.playCount)}
                      </Text>
                    </View>
                    <View style={styles.statCol}>
                      <Text style={styles.artistHoursBig}>{fmtHours(item.totalDuration)}</Text>
                      <Text style={styles.artistHoursLabel}>всего времени</Text>
                    </View>
                    <Ionicons name="chevron-forward" size={18} color={colors.text3} style={{ marginLeft: 4 }} />
                  </View>
                </Glass>
              </SwipeableStatsRow>
            )}
          />
        </Animated.View>
      </View>
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
    paddingTop: 8,
  },
  periodRow: {
    paddingHorizontal: 20,
    marginBottom: 8,
    alignItems: 'center',
  },
  periodGlass: {
    height: 38,
    padding: 3,
    justifyContent: 'center',
  },
  periodInner: {
    flexDirection: 'row',
    alignItems: 'center',
    position: 'relative',
    height: 32,
  },
  periodBtn: {
    paddingHorizontal: 16,
    height: 32,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 13,
  },
  periodSlidingPill: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    left: 0,
    height: 32,
    borderRadius: 13,
    backgroundColor: 'rgba(255, 255, 255, 0.18)',
  },
  periodBtnText: {
    ...type.caption,
    fontSize: 13,
    color: colors.text2,
    fontWeight: '600',
  },
  periodBtnTextActive: {
    color: colors.text,
    fontWeight: '700',
  },
  subTabRow: {
    paddingHorizontal: 20,
    marginBottom: 10,
  },
  subTabGlass: {
    height: 44,
    padding: 3,
    justifyContent: 'center',
  },
  subTabInner: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    position: 'relative',
    height: 38,
  },
  subTabPressable: {
    flex: 1,
    height: 38,
    justifyContent: 'center',
  },
  subTabSlidingPill: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    left: 0,
    height: 38,
    borderRadius: 13,
    backgroundColor: colors.accent,
  },
  subTabBtn: {
    flex: 1,
    height: 38,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 7,
    borderRadius: 13,
    backgroundColor: 'transparent',
  },
  subTabBtnText: {
    ...type.caption,
    fontSize: 14,
    color: colors.text2,
    fontWeight: '600',
  },
  subTabBtnTextActive: {
    color: colors.onAccent,
    fontWeight: '700',
  },
  topActionHeader: {
    marginBottom: 10,
    alignItems: 'flex-start',
  },
  playAllGlass: {
    paddingHorizontal: 14,
    paddingVertical: 6,
  },
  playAllInner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  playAllText: {
    ...type.caption,
    fontSize: 12,
    color: colors.text,
    fontWeight: '700',
  },
  listContent: {
    paddingHorizontal: 20,
    paddingTop: 4,
  },
  cardMargin: {
    marginBottom: 8,
  },
  cardGlass: {
    padding: 10,
  },
  trackRow: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  rankBox: {
    width: 26,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 6,
  },
  rankGold: {},
  rankSilver: {},
  rankBronze: {},
  rankMedal: {
    fontSize: 18,
  },
  rankNum: {
    ...type.mono,
    fontSize: 14,
    color: colors.text3,
    fontWeight: '700',
  },
  rankTopNum: {
    color: colors.text,
    fontSize: 15,
    fontWeight: '800',
  },
  cover: {
    marginRight: 10,
  },

  trackInfo: {
    flex: 1,
    justifyContent: 'center',
  },
  trackTitle: {
    ...type.headline,
    fontSize: 14,
    color: colors.text,
    fontWeight: '700',
  },
  trackArtist: {
    ...type.caption,
    fontSize: 12,
    color: colors.text2,
    marginTop: 2,
  },
  artistName: {
    ...type.headline,
    fontSize: 15,
    color: colors.text,
    fontWeight: '700',
  },
  artistSub: {
    ...type.caption,
    fontSize: 11,
    color: colors.text2,
    marginTop: 2,
  },
  statCol: {
    alignItems: 'flex-end',
    justifyContent: 'center',
  },
  statPlays: {
    ...type.mono,
    fontSize: 12,
    color: colors.accent,
    fontWeight: '700',
  },
  statTime: {
    ...type.caption,
    fontSize: 11,
    color: colors.text3,
    marginTop: 2,
  },
  artistHoursBig: {
    ...type.mono,
    fontSize: 15,
    color: colors.accent,
    fontWeight: '800',
  },
  artistHoursLabel: {
    ...type.caption,
    fontSize: 10,
    color: colors.text3,
    marginTop: 1,
  },
  emptyWrap: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingTop: 36,
    paddingHorizontal: 20,
    gap: 8,
  },
  emptyTitle: {
    ...type.headline,
    fontSize: 16,
    color: colors.text,
    marginTop: 6,
  },
  emptySub: {
    ...type.caption,
    fontSize: 12,
    color: colors.text3,
    textAlign: 'center',
    lineHeight: 17,
    maxWidth: 290,
  },
  suggestBox: {
    width: '100%',
    marginTop: 24,
  },
  suggestHeading: {
    ...type.caption,
    fontSize: 11,
    fontWeight: '700',
    color: colors.text3,
    textTransform: 'uppercase',
    letterSpacing: 0.6,
    marginBottom: 10,
    paddingHorizontal: 4,
  },
  swipeRowWrapper: {
    position: 'relative',
    marginBottom: 8,
  },
  resetBackdrop: {
    position: 'absolute',
    right: 0,
    top: 0,
    bottom: 0,
    width: 82,
    justifyContent: 'center',
    alignItems: 'center',
    zIndex: 0,
  },
  resetBtnAction: {
    width: 76,
    height: '100%',
    backgroundColor: '#FF3B30',
    borderRadius: 16,
    justifyContent: 'center',
    alignItems: 'center',
    gap: 3,
  },
  resetBtnText: {
    ...type.caption,
    fontSize: 11,
    color: '#FFFFFF',
    fontWeight: '700',
  },
});
