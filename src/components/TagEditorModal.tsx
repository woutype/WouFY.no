import React, { useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Animated,
  Image,
  LayoutAnimation,
  Linking,
  Modal,
  PanResponder,
  Pressable,
  ScrollView,
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
import { downloadCoverToCache, OnlineCoverResult, searchOnlineCovers } from '../services/onlineArtwork';
import { splitArtists } from '../services/queueOrder';
import { parseLrc, saveLrc } from '../services/lyrics';
import { WoufyFX } from '../services/fxPlayer';

interface Props {
  visible: boolean;
  track?: TrackFile;
  onSave: (updated: TrackFile) => void;
  onClose: () => void;
}

const SHEET_H = 740;

export const TagEditorModal: React.FC<Props> = ({ visible, track, onSave, onClose }) => {
  const [title, setTitle] = useState('');
  const [artist, setArtist] = useState('');
  const [album, setAlbum] = useState('');
  const [year, setYear] = useState('');
  const [genre, setGenre] = useState('');
  const [trackNumber, setTrackNumber] = useState('');
  const [lyrics, setLyrics] = useState('');
  const [artworkUri, setArtworkUri] = useState<string | undefined>(undefined);

  const [searching, setSearching] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [fetchingLyrics, setFetchingLyrics] = useState(false);
  const [onlineCovers, setOnlineCovers] = useState<OnlineCoverResult[]>([]);
  const [searchError, setSearchError] = useState<string | null>(null);

  const panY = useState(() => new Animated.Value(SHEET_H))[0];

  useEffect(() => {
    if (track) {
      setTitle(track.title || '');
      setArtist(track.artist || '');
      setAlbum(track.album || '');
      setYear(track.year ? String(track.year) : '');
      setGenre(track.genre || '');
      setTrackNumber(track.trackNumber ? String(track.trackNumber) : '');
      setLyrics(track.lyrics || '');
      setArtworkUri(track.artworkUri);
      setOnlineCovers([]);
      setSearchError(null);
    }
  }, [track, visible]);

  useEffect(() => {
    if (visible) {
      panY.setValue(SHEET_H);
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
      toValue: SHEET_H,
      duration: 200,
      useNativeDriver: true,
    }).start(() => onClose());
  };

  const panResponder = useState(() =>
    PanResponder.create({
      onMoveShouldSetPanResponder: (_, g) => g.dy > 12 && Math.abs(g.dy) > Math.abs(g.dx) * 1.5,
      onPanResponderMove: (_, g) => {
        if (g.dy > 0) panY.setValue(g.dy);
      },
      onPanResponderRelease: (_, g) => {
        if (g.dy > 140 || g.vy > 0.6) {
          handleClose();
        } else {
          Animated.spring(panY, { toValue: 0, useNativeDriver: true, damping: 20 }).start();
        }
      },
    })
  )[0];

  // Выбор фото из медиатеки устройства
  const handlePickDeviceImage = async () => {
    const fx = WoufyFX;
    if (!fx || typeof fx.pickImage !== 'function') {
      Alert.alert('Галерея', 'Выбор фото доступен на реальном iOS устройстве.');
      return;
    }
    try {
      Haptics.selectionAsync();
      const localUri = await fx.pickImage();
      if (localUri) {
        setArtworkUri(localUri);
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      }
    } catch (e) {
      console.warn('pickImage error:', e);
    }
  };

  // Поиск HD обложек в Apple iTunes API
  const handleSearchOnlineCovers = async () => {
    if (!title && !artist) return;
    setSearching(true);
    setSearchError(null);
    try {
      Haptics.selectionAsync();
      const results = await searchOnlineCovers(artist, title);
      LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
      setOnlineCovers(results);
      if (results.length === 0) {
        setSearchError('Обложки не найдены в iTunes');
      }
    } catch {
      LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
      setSearchError('Ошибка поиска в сети');
    } finally {
      setSearching(false);
    }
  };

  const handleSelectOnlineCover = async (cover: OnlineCoverResult) => {
    if (!track) return;
    setDownloading(true);
    try {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
      const localUri = await downloadCoverToCache(cover.highResUrl, track.id);
      LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
      setArtworkUri(localUri);
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    } catch (e) {
      console.warn('Failed to download cover:', e);
    } finally {
      setDownloading(false);
    }
  };

  // Открыть поиск текста в Genius
  const handleOpenGenius = () => {
    const query = `${artist} ${title}`.trim();
    const url = `https://genius.com/search?q=${encodeURIComponent(query)}`;
    Linking.openURL(url).catch(() => {});
  };

  // Автоматический поиск текста в LRCLIB
  const handleFetchOnlineLyrics = async () => {
    if (!title || !artist) {
      Alert.alert('Текст', 'Укажите название и артиста для поиска текста.');
      return;
    }
    setFetchingLyrics(true);
    try {
      Haptics.selectionAsync();
      const query = `artist_name=${encodeURIComponent(artist)}&track_name=${encodeURIComponent(title)}`;
      const res = await fetch(`https://lrclib.net/api/get?${query}`);
      if (res.ok) {
        const data = await res.json();
        const found = data.syncedLyrics || data.plainLyrics;
        if (found) {
          LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
          setLyrics(found);
          Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
          Alert.alert('Успех', 'Текст песни найден и вставлен в редактор!');
          return;
        }
      }
      Alert.alert('Не найдено', 'Текст не найден в базе LRCLIB. Вы можете открыть Genius или вставить вручную.');
    } catch {
      Alert.alert('Ошибка', 'Не удалось связаться с сервером текстов.');
    } finally {
      setFetchingLyrics(false);
    }
  };

  const handleSave = () => {
    if (!track) return;
    const trimmedTitle = title.trim() || track.filename;
    const trimmedArtist = artist.trim() || 'Неизвестный исполнитель';
    const parsedYear = parseInt(year.trim(), 10);
    const parsedTrackNo = parseInt(trackNumber.trim(), 10);

    const updated: TrackFile = {
      ...track,
      title: trimmedTitle,
      artist: trimmedArtist,
      album: album.trim() || undefined,
      year: !isNaN(parsedYear) && parsedYear > 1900 && parsedYear < 2100 ? parsedYear : undefined,
      genre: genre.trim() || undefined,
      trackNumber: !isNaN(parsedTrackNo) && parsedTrackNo > 0 ? parsedTrackNo : undefined,
      artworkUri: artworkUri || track.artworkUri,
      lyrics: lyrics.trim() || undefined,
    };

    // Если введен текст, также сохраняем в кэш текстов для синхронизации с LyricsView
    if (updated.lyrics) {
      const parsedLines = parseLrc(updated.lyrics);
      if (parsedLines && parsedLines.length > 0) {
        saveLrc(updated, parsedLines).catch(() => {});
      }
    }

    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    onSave(updated);
    handleClose();
  };

  const parsedArtists = splitArtists(artist);
  const showArtistHint = parsedArtists.length > 1;

  if (!visible && !track) return null;

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={handleClose}>
      <View style={styles.backdrop}>
        <Pressable style={StyleSheet.absoluteFill} onPress={handleClose} />
        <Animated.View style={[styles.sheet, { transform: [{ translateY: panY }] }]}>
          <BlurView intensity={55} tint="dark" style={StyleSheet.absoluteFill} />
          <View style={styles.sheetContent}>
            {/* Grabber */}
            <View style={styles.headerArea} {...panResponder.panHandlers}>
              <View style={styles.grabber} />
              <View style={styles.headerRow}>
                <Text style={styles.sheetTitle}>Тег-редактор WouFY</Text>
                <PressableScale onPress={handleSave} haptic="medium" scaleTo={0.94}>
                  <View style={styles.saveBtn}>
                    <Text style={styles.saveBtnText}>Готово</Text>
                  </View>
                </PressableScale>
              </View>
            </View>

            <ScrollView
              showsVerticalScrollIndicator={false}
              contentContainerStyle={styles.scrollBody}
              keyboardShouldPersistTaps="handled"
            >
              {/* Обложка */}
              <View style={styles.coverSection}>
                <CoverArt uri={artworkUri} size={110} radius={18} style={styles.coverPreview} />
                <View style={styles.coverActions}>
                  {/* Выбрать из галереи */}
                  <PressableScale onPress={handlePickDeviceImage} scaleTo={0.96} haptic="light">
                    <Glass radius={14} style={styles.actionGlass}>
                      <View style={styles.actionBtnInner}>
                        <Ionicons name="images-outline" size={17} color={colors.accent} />
                        <Text style={styles.actionBtnText}>Выбрать из галереи</Text>
                      </View>
                    </Glass>
                  </PressableScale>

                  {/* Найти в iTunes */}
                  <PressableScale
                    onPress={handleSearchOnlineCovers}
                    scaleTo={0.96}
                    haptic="light"
                    disabled={searching || downloading}
                  >
                    <Glass radius={14} style={styles.actionGlass}>
                      <View style={styles.actionBtnInner}>
                        {searching ? (
                          <ActivityIndicator size="small" color={colors.accent} />
                        ) : (
                          <Ionicons name="globe-outline" size={17} color={colors.accent} />
                        )}
                        <Text style={styles.actionBtnText}>
                          {searching ? 'Поиск в iTunes…' : 'Найти в сети (HD)'}
                        </Text>
                      </View>
                    </Glass>
                  </PressableScale>

                  {artworkUri && (
                    <PressableScale
                      onPress={() => setArtworkUri(undefined)}
                      scaleTo={0.96}
                      haptic="light"
                    >
                      <View style={styles.removeCoverBtn}>
                        <Ionicons name="trash-outline" size={14} color={colors.text3} />
                        <Text style={styles.removeCoverText}>Сбросить обложку</Text>
                      </View>
                    </PressableScale>
                  )}
                </View>
              </View>

              {/* Результаты поиска обложек онлайн */}
              {searchError && <Text style={styles.errorText}>{searchError}</Text>}

              {onlineCovers.length > 0 && (
                <View style={styles.onlineResultsBox}>
                  <Text style={styles.sectionLabel}>Найдено в iTunes (1000×1000 HD):</Text>
                  <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.coversScroll}>
                    {onlineCovers.map((c, i) => (
                      <PressableScale
                        key={i}
                        onPress={() => handleSelectOnlineCover(c)}
                        scaleTo={0.94}
                        haptic="medium"
                        style={styles.onlineThumbWrap}
                      >
                        <Image source={{ uri: c.thumbnailUrl }} style={styles.onlineThumb} />
                        <Text style={styles.onlineThumbAlbum} numberOfLines={1}>
                          {c.albumName}
                        </Text>
                      </PressableScale>
                    ))}
                  </ScrollView>
                </View>
              )}

              {/* Поля ввода метаданных */}
              <View style={styles.fieldsSection}>
                {/* Название */}
                <View style={styles.fieldBlock}>
                  <Text style={styles.fieldLabel}>Название трека</Text>
                  <Glass radius={14} style={styles.inputGlass}>
                    <View style={styles.inputRow}>
                      <TextInput
                        style={styles.input}
                        value={title}
                        onChangeText={setTitle}
                        placeholder="Название песни"
                        placeholderTextColor={colors.text3}
                        selectionColor={colors.text}
                      />
                      {title.length > 0 && (
                        <PressableScale onPress={() => setTitle('')} hitSlop={8}>
                          <Ionicons name="close-circle" size={18} color={colors.text3} />
                        </PressableScale>
                      )}
                    </View>
                  </Glass>
                </View>

                {/* Артист */}
                <View style={styles.fieldBlock}>
                  <Text style={styles.fieldLabel}>Артист / Исполнители</Text>
                  <Glass radius={14} style={styles.inputGlass}>
                    <View style={styles.inputRow}>
                      <TextInput
                        style={styles.input}
                        value={artist}
                        onChangeText={setArtist}
                        placeholder="Артист 1 / Артист 2"
                        placeholderTextColor={colors.text3}
                        selectionColor={colors.text}
                      />
                      {artist.length > 0 && (
                        <PressableScale onPress={() => setArtist('')} hitSlop={8}>
                          <Ionicons name="close-circle" size={18} color={colors.text3} />
                        </PressableScale>
                      )}
                    </View>
                  </Glass>
                  {showArtistHint && (
                    <View style={styles.artistHintRow}>
                      <Ionicons name="people-outline" size={14} color={colors.accent} />
                      <Text style={styles.artistHintText}>
                        Раздельно в фильтрах: {parsedArtists.join(' · ')}
                      </Text>
                    </View>
                  )}
                </View>

                {/* Альбом */}
                <View style={styles.fieldBlock}>
                  <Text style={styles.fieldLabel}>Альбом</Text>
                  <Glass radius={14} style={styles.inputGlass}>
                    <View style={styles.inputRow}>
                      <TextInput
                        style={styles.input}
                        value={album}
                        onChangeText={setAlbum}
                        placeholder="Название альбома или сингла"
                        placeholderTextColor={colors.text3}
                        selectionColor={colors.text}
                      />
                      {album.length > 0 && (
                        <PressableScale onPress={() => setAlbum('')} hitSlop={8}>
                          <Ionicons name="close-circle" size={18} color={colors.text3} />
                        </PressableScale>
                      )}
                    </View>
                  </Glass>
                </View>

                {/* Год и Жанр в одну строку */}
                <View style={styles.rowTwoCols}>
                  <View style={[styles.fieldBlock, { flex: 1 }]}>
                    <Text style={styles.fieldLabel}>Год выпуска</Text>
                    <Glass radius={14} style={styles.inputGlass}>
                      <TextInput
                        style={styles.input}
                        value={year}
                        onChangeText={setYear}
                        placeholder="Напр. 2024"
                        placeholderTextColor={colors.text3}
                        keyboardType="numeric"
                        maxLength={4}
                      />
                    </Glass>
                  </View>

                  <View style={[styles.fieldBlock, { flex: 1.4 }]}>
                    <Text style={styles.fieldLabel}>Жанр</Text>
                    <Glass radius={14} style={styles.inputGlass}>
                      <TextInput
                        style={styles.input}
                        value={genre}
                        onChangeText={setGenre}
                        placeholder="Хип-хоп, Рок…"
                        placeholderTextColor={colors.text3}
                      />
                    </Glass>
                  </View>
                </View>

                {/* Номер дорожки */}
                <View style={styles.fieldBlock}>
                  <Text style={styles.fieldLabel}>Номер дорожки в альбоме</Text>
                  <Glass radius={14} style={styles.inputGlass}>
                    <TextInput
                      style={styles.input}
                      value={trackNumber}
                      onChangeText={setTrackNumber}
                      placeholder="1, 2, 3…"
                      placeholderTextColor={colors.text3}
                      keyboardType="numeric"
                      maxLength={3}
                    />
                  </Glass>
                </View>

                {/* Текст песни (Lyrics) */}
                <View style={styles.fieldBlock}>
                  <View style={styles.lyricsHeaderRow}>
                    <Text style={styles.fieldLabel}>Текст песни (Lyrics)</Text>
                    <View style={styles.lyricsActions}>
                      <PressableScale onPress={handleOpenGenius} scaleTo={0.92} haptic="light">
                        <View style={styles.lyricsChip}>
                          <Ionicons name="search" size={12} color={colors.accent} />
                          <Text style={styles.lyricsChipText}>Genius</Text>
                        </View>
                      </PressableScale>
                      <PressableScale
                        onPress={handleFetchOnlineLyrics}
                        scaleTo={0.92}
                        haptic="light"
                        disabled={fetchingLyrics}
                      >
                        <View style={styles.lyricsChip}>
                          {fetchingLyrics ? (
                            <ActivityIndicator size="small" color={colors.accent} />
                          ) : (
                            <Ionicons name="cloud-download-outline" size={12} color={colors.accent} />
                          )}
                          <Text style={styles.lyricsChipText}>Найти LRCLIB</Text>
                        </View>
                      </PressableScale>
                      {lyrics.length > 0 && (
                        <PressableScale onPress={() => setLyrics('')} scaleTo={0.92} hitSlop={8}>
                          <View style={styles.lyricsChip}>
                            <Ionicons name="trash-outline" size={12} color={colors.text3} />
                          </View>
                        </PressableScale>
                      )}
                    </View>
                  </View>
                  <Glass radius={16} style={styles.lyricsGlass}>
                    <TextInput
                      style={styles.lyricsInput}
                      value={lyrics}
                      onChangeText={setLyrics}
                      placeholder="Вставьте слова песни или скопируйте из Genius/LRC…"
                      placeholderTextColor={colors.text3}
                      multiline
                      scrollEnabled={false}
                      textAlignVertical="top"
                    />
                  </Glass>
                </View>
              </View>

              <View style={{ height: 60 }} />
            </ScrollView>
          </View>
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
    height: '92%',
    borderTopLeftRadius: 30,
    borderTopRightRadius: 30,
    overflow: 'hidden',
    backgroundColor: 'rgba(18,18,22,0.95)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.1)',
  },
  sheetContent: {
    flex: 1,
  },
  headerArea: {
    paddingTop: 8,
    paddingHorizontal: 20,
    paddingBottom: 12,
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(255,255,255,0.08)',
  },
  grabber: {
    alignSelf: 'center',
    width: 38,
    height: 5,
    borderRadius: 3,
    backgroundColor: 'rgba(255,255,255,0.22)',
    marginBottom: 10,
  },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  sheetTitle: {
    ...type.headline,
    fontSize: 18,
    color: colors.text,
    fontWeight: '700',
  },
  saveBtn: {
    backgroundColor: colors.accent,
    paddingHorizontal: 16,
    paddingVertical: 7,
    borderRadius: 16,
  },
  saveBtnText: {
    ...type.headline,
    fontSize: 14,
    color: colors.onAccent,
    fontWeight: '700',
  },
  scrollBody: {
    paddingHorizontal: 20,
    paddingTop: 18,
    paddingBottom: 40,
  },
  coverSection: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 16,
    marginBottom: 16,
  },
  coverPreview: {
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.15)',
  },
  coverActions: {
    flex: 1,
    gap: 8,
  },
  actionGlass: {
    height: 38,
  },
  actionBtnInner: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    paddingHorizontal: 10,
  },
  actionBtnText: {
    ...type.headline,
    fontSize: 13,
    color: colors.text,
    fontWeight: '600',
  },
  removeCoverBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    paddingVertical: 4,
    paddingHorizontal: 6,
  },
  removeCoverText: {
    ...type.caption,
    fontSize: 12,
    color: colors.text3,
  },
  errorText: {
    ...type.caption,
    color: '#ff6b6b',
    marginBottom: 10,
  },
  onlineResultsBox: {
    marginBottom: 16,
  },
  sectionLabel: {
    ...type.caption,
    fontSize: 12,
    color: colors.text2,
    marginBottom: 8,
    fontWeight: '600',
  },
  coversScroll: {
    flexDirection: 'row',
  },
  onlineThumbWrap: {
    width: 84,
    marginRight: 10,
    alignItems: 'center',
  },
  onlineThumb: {
    width: 84,
    height: 84,
    borderRadius: 12,
    backgroundColor: 'rgba(255,255,255,0.08)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.12)',
  },
  onlineThumbAlbum: {
    ...type.caption,
    fontSize: 10,
    color: colors.text2,
    marginTop: 4,
    textAlign: 'center',
  },
  fieldsSection: {
    gap: 14,
  },
  fieldBlock: {
    gap: 6,
  },
  fieldLabel: {
    ...type.caption,
    fontSize: 12,
    color: colors.text3,
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  inputGlass: {
    minHeight: 46,
    justifyContent: 'center',
  },
  inputRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 14,
  },
  input: {
    flex: 1,
    ...type.body,
    fontSize: 15,
    color: colors.text,
    paddingHorizontal: 14,
    paddingVertical: 10,
  },
  rowTwoCols: {
    flexDirection: 'row',
    gap: 12,
  },
  artistHintRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 4,
    marginTop: 2,
  },
  artistHintText: {
    ...type.caption,
    fontSize: 11,
    color: colors.accent,
  },
  lyricsHeaderRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  lyricsActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  lyricsChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 10,
    backgroundColor: 'rgba(255,255,255,0.08)',
  },
  lyricsChipText: {
    ...type.caption,
    fontSize: 11,
    color: colors.text,
    fontWeight: '600',
  },
  lyricsGlass: {
    minHeight: 140,
    padding: 12,
  },
  lyricsInput: {
    ...type.body,
    fontSize: 14,
    color: colors.text,
    lineHeight: 22,
    minHeight: 120,
  },
});
