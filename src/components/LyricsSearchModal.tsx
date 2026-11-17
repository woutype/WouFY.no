import React, { useMemo, useRef, useState, useEffect } from 'react';
import {
  ActivityIndicator,
  Animated,
  FlatList,
  LayoutAnimation,
  Modal,
  PanResponder,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { BlurView } from 'expo-blur';
import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { TrackFile } from '../types';
import { colors, type } from '../theme';
import { CoverArt, Glass, PressableScale } from './ui';
import { parseLrc } from '../services/lyrics';

interface Props {
  visible: boolean;
  tracks: TrackFile[];
  onSelectTrack: (track: TrackFile, seekTime?: number) => void;
  onClose: () => void;
}

interface LyricsMatch {
  track: TrackFile;
  snippet: string;
  matchedWord: string;
  seekTime?: number;
}

function findLyricMatches(tracks: TrackFile[], query: string): LyricsMatch[] {
  const q = query.trim().toLowerCase();
  if (q.length < 2) return [];

  const results: LyricsMatch[] = [];

  for (const t of tracks) {
    let bestLine = '';
    let seekTime: number | undefined = undefined;

    // 1. Проверяем синхронизированные строки
    if (t.syncedLyrics && t.syncedLyrics.length > 0) {
      for (const line of t.syncedLyrics) {
        if (line.text.toLowerCase().includes(q)) {
          bestLine = line.text;
          seekTime = line.time;
          break;
        }
      }
    }

    // 2. Проверяем сырой текст или LRC тег
    if (!bestLine && t.lyrics) {
      const parsed = parseLrc(t.lyrics);
      if (parsed) {
        for (const line of parsed) {
          if (line.text.toLowerCase().includes(q)) {
            bestLine = line.text;
            seekTime = line.time;
            break;
          }
        }
      } else {
        const rawLines = t.lyrics.split(/\r?\n/);
        for (const line of rawLines) {
          const clean = line.replace(/\[\d{2}:\d{2}(?:\.\d{2,3})?\]/g, '').trim();
          if (clean.toLowerCase().includes(q)) {
            bestLine = clean;
            break;
          }
        }
      }
    }

    if (bestLine) {
      results.push({
        track: t,
        snippet: bestLine.trim(),
        matchedWord: q,
        seekTime,
      });
      if (results.length >= 40) break;
    }
  }

  return results;
}

function HighlightedSnippet({ text, query }: { text: string; query: string }) {
  if (!query) return <Text style={styles.snippetText}>{text}</Text>;

  const lower = text.toLowerCase();
  const q = query.toLowerCase();
  const idx = lower.indexOf(q);
  if (idx < 0) return <Text style={styles.snippetText}>{text}</Text>;

  const before = text.slice(0, idx);
  const match = text.slice(idx, idx + q.length);
  const after = text.slice(idx + q.length);

  return (
    <Text style={styles.snippetText} numberOfLines={2}>
      {before}
      <Text style={styles.snippetHighlight}>{match}</Text>
      {after}
    </Text>
  );
}

export const LyricsSearchModal: React.FC<Props> = ({ visible, tracks, onSelectTrack, onClose }) => {
  const [query, setQuery] = useState('');
  const [searching, setSearching] = useState(false);
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [debouncedQuery, setDebouncedQuery] = useState('');
  const panY = useRef(new Animated.Value(600)).current;

  useEffect(() => {
    if (visible) {
      panY.setValue(600);
      Animated.spring(panY, {
        toValue: 0,
        damping: 24,
        stiffness: 220,
        useNativeDriver: true,
      }).start();
    }
  }, [visible, panY]);

  const handleClose = () => {
    Animated.timing(panY, {
      toValue: 600,
      duration: 180,
      useNativeDriver: true,
    }).start(() => {
      onClose();
      setQuery('');
      setDebouncedQuery('');
    });
  };

  const handleQueryChange = (text: string) => {
    setQuery(text);
    setSearching(true);
    if (searchTimer.current) clearTimeout(searchTimer.current);
    searchTimer.current = setTimeout(() => {
      LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
      setDebouncedQuery(text);
      setSearching(false);
    }, 180);
  };

  const matches = useMemo(() => {
    if (!debouncedQuery.trim()) return [];
    return findLyricMatches(tracks, debouncedQuery);
  }, [tracks, debouncedQuery]);

  const panResponder = useRef(
    PanResponder.create({
      onMoveShouldSetPanResponder: (_, g) => g.dy > 10 && Math.abs(g.dy) > Math.abs(g.dx),
      onPanResponderMove: (_, g) => {
        if (g.dy > 0) panY.setValue(g.dy);
      },
      onPanResponderRelease: (_, g) => {
        if (g.dy > 120 || g.vy > 0.6) {
          handleClose();
        } else {
          Animated.spring(panY, { toValue: 0, useNativeDriver: true, damping: 20 }).start();
        }
      },
    })
  ).current;

  if (!visible) return null;

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={handleClose}>
      <View style={styles.backdrop}>
        <Pressable style={StyleSheet.absoluteFill} onPress={handleClose} />
        <Animated.View style={[styles.sheet, { transform: [{ translateY: panY }] }]}>
          <BlurView intensity={65} tint="dark" style={StyleSheet.absoluteFill} />

          {/* Шапка модалки */}
          <View style={styles.header} {...panResponder.panHandlers}>
            <View style={styles.grabber} />
            <View style={styles.headerRow}>
              <View style={styles.titleWrap}>
                <Ionicons name="document-text" size={20} color={colors.accent} />
                <Text style={styles.title}>Поиск по тексту песни</Text>
              </View>
              <PressableScale onPress={handleClose} scaleTo={0.92} haptic="light">
                <View style={styles.closeBtn}>
                  <Ionicons name="close" size={20} color={colors.text2} />
                </View>
              </PressableScale>
            </View>

            {/* Поле ввода */}
            <View style={styles.searchBar}>
              <Ionicons name="search" size={18} color={colors.text3} style={{ marginLeft: 12 }} />
              <TextInput
                style={styles.input}
                placeholder="Фраза из припева или куплета…"
                placeholderTextColor={colors.text3}
                value={query}
                onChangeText={handleQueryChange}
                autoFocus
                autoCorrect={false}
                clearButtonMode="while-editing"
                returnKeyType="search"
              />
              {searching && (
                <ActivityIndicator size="small" color={colors.accent} style={{ marginRight: 12 }} />
              )}
            </View>
          </View>

          {/* Результаты поиска */}
          <FlatList
            data={matches}
            keyExtractor={(item) => `${item.track.id}_${item.seekTime ?? item.snippet}`}
            showsVerticalScrollIndicator={false}
            contentContainerStyle={styles.listContent}
            keyboardShouldPersistTaps="handled"
            ListEmptyComponent={
              <View style={styles.emptyContainer}>
                {debouncedQuery.trim().length >= 2 ? (
                  <>
                    <Ionicons name="search-outline" size={38} color={colors.text3} />
                    <Text style={styles.emptyTitle}>Ничего не найдено</Text>
                    <Text style={styles.emptySub}>
                      В текстах ваших треков нет совпадений со строкой «{debouncedQuery}»
                    </Text>
                  </>
                ) : (
                  <>
                    <Ionicons name="musical-notes-outline" size={38} color="rgba(255,255,255,0.25)" />
                    <Text style={styles.emptyTitle}>Вспомнили строчку из трека?</Text>
                    <Text style={styles.emptySub}>
                      Введите любое слово или фразу — WouFY мгновенно найдёт песню в вашей фонотеке
                    </Text>
                  </>
                )}
              </View>
            }
            renderItem={({ item }) => (
              <PressableScale
                onPress={() => {
                  Haptics.selectionAsync();
                  onSelectTrack(item.track, item.seekTime);
                  handleClose();
                }}
                scaleTo={0.97}
                haptic="light"
                style={styles.matchItem}
              >
                <Glass radius={26} style={styles.matchGlass}>
                  <View style={styles.matchRow}>
                    <CoverArt uri={item.track.artworkUri} size={50} radius={25} />
                    <View style={styles.matchTextCol}>
                      <Text style={styles.matchTrackTitle} numberOfLines={1}>
                        {item.track.title}
                      </Text>
                      <Text style={styles.matchTrackArtist} numberOfLines={1}>
                        {item.track.artist}
                      </Text>
                      {/* Сниппет строки из песни */}
                      <View style={styles.snippetBubble}>
                        <Ionicons name="chatbubble-ellipses-outline" size={13} color={colors.accent} />
                        <HighlightedSnippet text={item.snippet} query={debouncedQuery} />
                      </View>
                    </View>
                    <Ionicons name="play-circle" size={28} color={colors.accent} style={{ marginLeft: 6 }} />
                  </View>
                </Glass>
              </PressableScale>
            )}
          />
        </Animated.View>
      </View>
    </Modal>
  );
};

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.65)',
    justifyContent: 'flex-end',
  },
  sheet: {
    height: '84%',
    borderTopLeftRadius: 30,
    borderTopRightRadius: 30,
    overflow: 'hidden',
    backgroundColor: 'rgba(18,18,22,0.92)',
  },
  header: {
    paddingHorizontal: 20,
    paddingTop: 10,
    paddingBottom: 14,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: 'rgba(255,255,255,0.08)',
  },
  grabber: {
    width: 36,
    height: 4,
    borderRadius: 2,
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
    gap: 8,
  },
  title: {
    ...type.headline,
    fontSize: 18,
    color: colors.text,
    fontWeight: '700',
  },
  closeBtn: {
    width: 30,
    height: 30,
    borderRadius: 15,
    backgroundColor: 'rgba(255,255,255,0.08)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  searchBar: {
    flexDirection: 'row',
    alignItems: 'center',
    height: 44,
    borderRadius: 22,
    backgroundColor: 'rgba(255,255,255,0.08)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.12)',
  },
  input: {
    flex: 1,
    ...type.body,
    fontSize: 15,
    color: colors.text,
    paddingHorizontal: 10,
  },
  listContent: {
    paddingHorizontal: 16,
    paddingTop: 14,
    paddingBottom: 40,
  },
  matchItem: {
    marginBottom: 10,
  },
  matchGlass: {
    paddingVertical: 10,
    paddingHorizontal: 12,
  },
  matchRow: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  matchTextCol: {
    flex: 1,
    marginLeft: 12,
    marginRight: 6,
  },
  matchTrackTitle: {
    ...type.headline,
    fontSize: 15,
    color: colors.text,
    fontWeight: '700',
  },
  matchTrackArtist: {
    ...type.caption,
    fontSize: 12,
    color: colors.text2,
    marginTop: 1,
  },
  snippetBubble: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    marginTop: 6,
    paddingVertical: 4,
    paddingHorizontal: 9,
    borderRadius: 12,
    backgroundColor: 'rgba(255,255,255,0.06)',
    alignSelf: 'flex-start',
    maxWidth: '100%',
  },
  snippetText: {
    ...type.caption,
    fontSize: 12,
    color: 'rgba(255,255,255,0.78)',
  },
  snippetHighlight: {
    color: colors.accent,
    fontWeight: '800',
  },
  emptyContainer: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingTop: 80,
    paddingHorizontal: 32,
    gap: 8,
  },
  emptyTitle: {
    ...type.headline,
    fontSize: 17,
    color: colors.text,
    marginTop: 8,
  },
  emptySub: {
    ...type.caption,
    fontSize: 13,
    color: colors.text3,
    textAlign: 'center',
    lineHeight: 18,
  },
});
