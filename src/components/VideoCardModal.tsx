import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Animated,
  Dimensions,
  Easing,
  Image,
  LayoutAnimation,
  Modal,
  PanResponder,
  Platform,
  Pressable,
  ScrollView,
  Share,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { BlurView } from 'expo-blur';
import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { AudioEngine } from '../services/audioEngine';
import { LyricLine, activeLineIndex } from '../services/lyrics';
import { TrackFile } from '../types';
import { colors, formatTime, type } from '../theme';
import { CoverArt, Glass, PressableScale } from './ui';
import { WoufyFX } from '../services/fxPlayer';
import { getFullArtwork } from '../services/artwork';
import { resolveTrackUri } from '../services/library';

export type CardCreationMode = 'video' | 'image';
export type ClipStyle = 'glassQuote' | 'inCover' | 'underCover' | 'textOnly';
export type ClipCoverShape = 'vinyl' | 'square';
export type ClipAspect = '9:16' | '1:1' | '16:9' | '4:3' | '3:4';

/** Лимит строк для статичной фото-карточки, чтобы цитата всегда красиво помещалась */
const MAX_IMAGE_LINES = 5;

interface Props {
  visible: boolean;
  mode: CardCreationMode;
  onModeChange?: (mode: CardCreationMode) => void;
  track?: TrackFile;
  lines: LyricLine[];
  duration: number;
  engine: AudioEngine;
  initialLineIndex?: number;
  onClose: () => void;
}

const ASPECT_OPTIONS: { key: ClipAspect; label: string; sub: string; ratio: number }[] = [
  { key: '9:16', label: '9:16', sub: 'Reels / Stories', ratio: 9 / 16 },
  { key: '1:1', label: '1:1', sub: 'Квадрат', ratio: 1 },
  { key: '3:4', label: '3:4', sub: 'Портрет', ratio: 3 / 4 },
  { key: '4:3', label: '4:3', sub: 'Альбом', ratio: 4 / 3 },
  { key: '16:9', label: '16:9', sub: 'Широкий', ratio: 16 / 9 },
];

const VIDEO_STYLE_OPTIONS: { key: ClipStyle; label: string; icon: keyof typeof Ionicons.glyphMap }[] = [
  { key: 'underCover', label: 'Под обложкой', icon: 'albums-outline' },
  { key: 'inCover', label: 'В обложке', icon: 'image-outline' },
  { key: 'textOnly', label: 'Только текст', icon: 'text-outline' },
];

const IMAGE_STYLE_OPTIONS: { key: ClipStyle; label: string; icon: keyof typeof Ionicons.glyphMap }[] = [
  { key: 'glassQuote', label: 'Цитата', icon: 'chatbox-ellipses-outline' },
  { key: 'underCover', label: 'Под обложкой', icon: 'albums-outline' },
  { key: 'inCover', label: 'В обложке', icon: 'image-outline' },
  { key: 'textOnly', label: 'Только текст', icon: 'text-outline' },
];

const SHEET_H = 790;

export const VideoCardModal: React.FC<Props> = ({
  visible,
  mode,
  onModeChange,
  track,
  lines,
  duration,
  engine,
  initialLineIndex = 0,
  onClose,
}) => {
  const [render, setRender] = useState(visible);
  const panY = useRef(new Animated.Value(SHEET_H)).current;
  const fade = useRef(new Animated.Value(0)).current;

  const isImage = mode === 'image';

  const [clipStyle, setClipStyle] = useState<ClipStyle>(isImage ? 'glassQuote' : 'underCover');
  const [coverShape, setCoverShape] = useState<ClipCoverShape>('vinyl');
  const [aspect, setAspect] = useState<ClipAspect>('9:16');

  // Диапазон выбранных строчек (для Видео) и произвольные строки (для Фото); -1 / [] = ничего не выбрано
  const [startIdx, setStartIdx] = useState(-1);
  const [endIdx, setEndIdx] = useState(-1);
  const [selectedImageIndices, setSelectedImageIndices] = useState<number[]>([]);

  // Предпрослуслушивание фрагмента
  const [previewPlaying, setPreviewPlaying] = useState(false);
  const [previewPos, setPreviewPos] = useState(0);
  const wasPlayingBeforeModal = useRef(false);

  // Генерация
  const [generating, setGenerating] = useState(false);
  const [progress, setProgress] = useState(0);

  // Анимация вращения пластинки в живом превью (только для видео)
  const spinAnim = useRef(new Animated.Value(0)).current;

  // При переключении режима Видео <-> Карточка корректируем стиль и форму обложки без сброса строк
  useEffect(() => {
    if (isImage) {
      if (clipStyle === 'underCover' && visible) {
        setClipStyle('glassQuote');
      }
      setCoverShape('square');
    } else {
      if (clipStyle === 'glassQuote') {
        setClipStyle('underCover');
      }
      setCoverShape('vinyl');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isImage]);

  const initTrackRef = useRef<string | null>(null);

  // Инициализация при открытии / смене трека: изначально ни одна строка не выбрана
  useEffect(() => {
    if (!visible) {
      initTrackRef.current = null;
      return;
    }
    const tid = track?.id ?? '__no_track__';
    if (initTrackRef.current !== tid) {
      initTrackRef.current = tid;
      setStartIdx(-1);
      setEndIdx(-1);
      setSelectedImageIndices([]);
      setClipStyle(isImage ? 'glassQuote' : 'underCover');
      setCoverShape(isImage ? 'square' : 'vinyl');
      const fallbackIdx = Math.max(0, Math.min(lines.length - 1, initialLineIndex >= 0 ? initialLineIndex : 0));
      setPreviewPos(lines[fallbackIdx]?.time ?? 0);
      setPreviewPlaying(false);
      setGenerating(false);
      setProgress(0);
    }
  }, [visible, track?.id, lines.length, initialLineIndex, isImage, lines]);

  // Вычисляем границы времени фрагмента (без жёсткого верхнего лимита для видео)
  const { startSec, endSec, clipDuration } = useMemo(() => {
    if (lines.length === 0 || startIdx < 0 || endIdx < 0) {
      const d = Math.min(15, Math.max(5, duration || 15));
      return { startSec: 0, endSec: d, clipDuration: d };
    }
    const sLine = lines[Math.min(startIdx, endIdx)] ?? lines[0];
    const eIdx = Math.max(startIdx, endIdx);
    const nextLine = lines[eIdx + 1];
    const s = Math.max(0, (sLine?.time ?? 0) - 0.25);
    const rawEnd = nextLine ? nextLine.time : Math.min(duration > 0 ? duration : (lines[eIdx]?.time ?? 0) + 5, (lines[eIdx]?.time ?? 0) + 4.5);
    const clampedEnd = Math.max(s + 4, rawEnd);
    return {
      startSec: s,
      endSec: clampedEnd,
      clipDuration: Math.max(4, clampedEnd - s),
    };
  }, [lines, startIdx, endIdx, duration]);

  // Анимация открытия/закрытия модалки
  useEffect(() => {
    if (visible) {
      setRender(true);
      wasPlayingBeforeModal.current = engine.getState().isPlaying;
      panY.setValue(SHEET_H);
      Animated.parallel([
        Animated.spring(panY, { toValue: 0, useNativeDriver: true, damping: 25, stiffness: 230, mass: 0.95 }),
        Animated.timing(fade, { toValue: 1, duration: 220, useNativeDriver: true }),
      ]).start();
    } else if (render) {
      setPreviewPlaying(false);
      Animated.parallel([
        Animated.timing(panY, { toValue: SHEET_H, duration: 220, easing: Easing.in(Easing.cubic), useNativeDriver: true }),
        Animated.timing(fade, { toValue: 0, duration: 200, useNativeDriver: true }),
      ]).start(({ finished }) => {
        if (finished) setRender(false);
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible]);

  // Вращение винила в превью (для видео-карточки)
  useEffect(() => {
    if (!visible || isImage || clipStyle === 'textOnly' || coverShape !== 'vinyl') {
      spinAnim.stopAnimation();
      spinAnim.setValue(0);
      return;
    }
    const loop = Animated.loop(
      Animated.timing(spinAnim, {
        toValue: 1,
        duration: 7500,
        easing: Easing.linear,
        useNativeDriver: true,
      })
    );
    loop.start();
    return () => loop.stop();
  }, [visible, isImage, clipStyle, coverShape, spinAnim]);

  // Таймер предпрослушивания отрывка (зацикливает выбранный фрагмент)
  useEffect(() => {
    if (!visible || !previewPlaying) return;
    const id = setInterval(() => {
      const pos = engine.getPosition();
      if (pos >= endSec - 0.08 || pos < startSec - 0.5) {
        engine.seek(startSec);
        setPreviewPos(startSec);
      } else {
        setPreviewPos(pos);
      }
    }, 80);
    return () => clearInterval(id);
  }, [visible, previewPlaying, startSec, endSec, engine]);

  const togglePreviewPlay = () => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    if (previewPlaying) {
      setPreviewPlaying(false);
      if (engine.getState().isPlaying) engine.togglePlay();
    } else {
      engine.seek(startSec);
      setPreviewPos(startSec);
      if (!engine.getState().isPlaying) engine.togglePlay();
      setPreviewPlaying(true);
    }
  };

  const handleClose = () => {
    if (generating) return;
    if (previewPlaying) {
      setPreviewPlaying(false);
      if (!wasPlayingBeforeModal.current && engine.getState().isPlaying) {
        engine.togglePlay();
      }
    }
    onClose();
  };

  const handleCloseRef = useRef(handleClose);
  handleCloseRef.current = handleClose;

  const panResponder = useRef(
    PanResponder.create({
      onMoveShouldSetPanResponder: (_, g) => g.dy > 10 && Math.abs(g.dy) > Math.abs(g.dx) * 1.3,
      onPanResponderMove: (_, g) => {
        if (g.dy > 0) panY.setValue(g.dy);
      },
      onPanResponderRelease: (_, g) => {
        if (g.dy > 120 || g.vy > 0.55) {
          handleCloseRef.current();
        } else {
          Animated.spring(panY, { toValue: 0, useNativeDriver: true, damping: 22, stiffness: 260 }).start();
        }
      },
    })
  ).current;

  const handleLineTap = (idx: number) => {
    LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);

    if (isImage) {
      // В режиме фото-карточки — выбор любых отдельных строк (до MAX_IMAGE_LINES = 5)
      if (selectedImageIndices.includes(idx)) {
        Haptics.selectionAsync();
        setSelectedImageIndices((prev) => prev.filter((i) => i !== idx));
      } else if (selectedImageIndices.length < MAX_IMAGE_LINES) {
        Haptics.selectionAsync();
        setSelectedImageIndices((prev) => [...prev, idx].sort((a, b) => a - b));
      } else {
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
      }
      return;
    }

    Haptics.selectionAsync();
    // Режим видео — диапазон без ограничения по строкам/длительности
    if (startIdx < 0 || endIdx < 0) {
      setStartIdx(idx);
      setEndIdx(idx);
      const newStart = lines[idx]?.time ?? 0;
      setPreviewPos(newStart);
      if (previewPlaying) engine.seek(Math.max(0, newStart - 0.2));
      return;
    }

    const curS = Math.min(startIdx, endIdx);
    const curE = Math.max(startIdx, endIdx);
    let nextS = curS;

    if (idx < curS) {
      nextS = idx;
      setStartIdx(idx);
      setEndIdx(curE);
    } else if (idx > curE) {
      setStartIdx(curS);
      setEndIdx(idx);
    } else if (curS === curE && idx === curS) {
      setStartIdx(-1);
      setEndIdx(-1);
      return;
    } else if (curS < curE) {
      if (idx === curS) {
        nextS = curS + 1;
        setStartIdx(nextS);
      } else if (idx === curE) {
        setEndIdx(curE - 1);
      } else if (idx - curS <= curE - idx) {
        nextS = idx;
        setStartIdx(idx);
      } else {
        setEndIdx(idx);
      }
    }

    const newStart = lines[nextS]?.time ?? 0;
    setPreviewPos(newStart);
    if (previewPlaying) engine.seek(Math.max(0, newStart - 0.2));
  };

  const resetSelectedLines = () => {
    Haptics.selectionAsync();
    LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
    if (isImage) {
      setSelectedImageIndices([]);
    } else {
      setStartIdx(-1);
      setEndIdx(-1);
      if (previewPlaying) {
        setPreviewPlaying(false);
        if (engine.getState().isPlaying) engine.togglePlay();
      }
    }
  };

  const handleGenerate = async () => {
    if (!track || generating) return;
    const hasChosen = isImage
      ? selectedImageIndices.length > 0
      : startIdx >= 0 && endIdx >= startIdx;
    if (lines.length > 0 && !hasChosen) {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
      Alert.alert('Выберите строки', 'Сначала отметьте нужные строки текста ниже.');
      return;
    }
    if (previewPlaying) {
      setPreviewPlaying(false);
      if (engine.getState().isPlaying) engine.togglePlay();
    }

    const fx = WoufyFX;
    if (isImage) {
      if (!fx || typeof fx.generateImageCard !== 'function') {
        Alert.alert(
          'WouFY Card',
          'Генератор фото-карточек работает в нативной сборке WouFY (.ipa / APK).'
        );
        return;
      }
      setGenerating(true);
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
      try {
        const fullArt = (await getFullArtwork(track).catch(() => null)) ?? track.artworkUri ?? null;
        const audioUri = resolveTrackUri(track.uri || track.id);
        const selectedTexts = selectedImageIndices
          .map((i) => lines[i]?.text)
          .filter((t): t is string => Boolean(t));

        const imgUri = await fx.generateImageCard({
          audioUri,
          artworkUri: fullArt,
          title: track.title,
          artist: track.artist,
          style: clipStyle,
          coverShape,
          aspect,
          lines: selectedTexts.length > 0 ? selectedTexts : [track.title],
        });

        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
        setGenerating(false);

        if (typeof fx.shareFile === 'function') {
          await fx.shareFile(imgUri);
        } else {
          await Share.share(
            Platform.OS === 'ios'
              ? { url: imgUri, title: `${track.artist} — ${track.title} (WouFY Card)` }
              : { message: imgUri, title: `${track.artist} — ${track.title}` }
          );
        }
      } catch (err: any) {
        setGenerating(false);
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
        Alert.alert('Ошибка генерации', err?.message || 'Не удалось создать фото-карточку');
      }
      return;
    }

    if (!fx || typeof fx.generateVideoCard !== 'function') {
      Alert.alert(
        'WouFY Clip',
        'Генератор видео-карточек работает в нативной сборке WouFY (.ipa / APK). В Expo Go кодировщик видео недоступен.'
      );
      return;
    }

    setGenerating(true);
    setProgress(0.02);
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);

    const sub = fx.addListener('onVideoProgress', (e) => {
      if (typeof e.progress === 'number') {
        setProgress(Math.max(0.02, Math.min(1, e.progress)));
      }
    });

    try {
      const fullArt = (await getFullArtwork(track).catch(() => null)) ?? track.artworkUri ?? null;
      const audioUri = resolveTrackUri(track.uri || track.id);
      const s = Math.min(startIdx, endIdx);
      const e = Math.max(startIdx, endIdx);
      const selectedLines = lines.slice(s, e + 1).map((l) => ({
        time: l.time,
        text: l.text,
      }));

      const videoStyle: 'inCover' | 'underCover' | 'textOnly' =
        clipStyle === 'glassQuote' ? 'underCover' : clipStyle;

      const videoUri = await fx.generateVideoCard({
        audioUri,
        artworkUri: fullArt,
        title: track.title,
        artist: track.artist,
        startSec,
        endSec,
        style: videoStyle,
        coverShape,
        aspect,
        lines: selectedLines,
      });

      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      setGenerating(false);

      if (typeof fx.shareFile === 'function') {
        await fx.shareFile(videoUri);
      } else {
        await Share.share(
          Platform.OS === 'ios'
            ? { url: videoUri, title: `${track.artist} — ${track.title} (WouFY Clip)` }
            : { message: videoUri, title: `${track.artist} — ${track.title}` }
        );
      }
    } catch (err: any) {
      setGenerating(false);
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      Alert.alert('Ошибка генерации', err?.message || 'Не удалось создать видео-карточку');
    } finally {
      sub.remove();
    }
  };

  if (!render || !track) return null;

  // Вычисляем размеры окна превью под выбранное соотношение сторон и размер экрана
  const { width: winW, height: winH } = Dimensions.get('window');
  const MAX_PREVIEW_H = Math.min(280, Math.max(190, Math.round(winH * 0.27)));
  const MAX_PREVIEW_W = Math.min(340, Math.round(winW * 0.78));
  const aspectObj = ASPECT_OPTIONS.find((a) => a.key === aspect) ?? ASPECT_OPTIONS[0];
  let previewW = MAX_PREVIEW_H * aspectObj.ratio;
  let previewH = MAX_PREVIEW_H;
  if (previewW > MAX_PREVIEW_W) {
    previewW = MAX_PREVIEW_W;
    previewH = MAX_PREVIEW_W / aspectObj.ratio;
  }
  const isLandscape = aspectObj.ratio > 1.15;
  const isSquare = Math.abs(aspectObj.ratio - 1) < 0.1;

  const hasVideoSelection = startIdx >= 0 && endIdx >= 0;
  const s = hasVideoSelection ? Math.min(startIdx, endIdx) : -1;
  const e = hasVideoSelection ? Math.max(startIdx, endIdx) : -1;
  const imageSet = new Set(selectedImageIndices);
  const clipLines = isImage
    ? selectedImageIndices.map((i) => lines[i]).filter(Boolean)
    : hasVideoSelection
    ? lines.slice(s, e + 1)
    : [];
  const selectedLinesCount = clipLines.length;
  const hasSelection = selectedLinesCount > 0;

  const relIdx = Math.max(0, activeLineIndex(clipLines, previewPos, 0.15));
  const prevLine = clipLines[relIdx - 1]?.text;
  const curLine = clipLines[relIdx]?.text ?? clipLines[0]?.text ?? (lines.length > 0 ? 'Выберите строки ниже' : track.title);
  const nextLine = clipLines[relIdx + 1]?.text;

  const spinDeg = spinAnim.interpolate({
    inputRange: [0, 1],
    outputRange: ['0deg', '360deg'],
  });

  const coverSize =
    clipStyle === 'inCover'
      ? Math.min(previewW * 0.78, previewH * 0.72)
      : isLandscape
      ? previewH * 0.60
      : isSquare
      ? previewH * 0.38
      : previewH * 0.40;

  const coverRadius = coverShape === 'vinyl' ? coverSize / 2 : coverSize * 0.12;
  const styleOptions = isImage ? IMAGE_STYLE_OPTIONS : VIDEO_STYLE_OPTIONS;

  return (
    <Modal visible transparent animationType="none" onRequestClose={handleClose} statusBarTranslucent>
      <View style={styles.overlay}>
        <Animated.View style={[StyleSheet.absoluteFill, { opacity: fade, backgroundColor: 'rgba(0,0,0,0.68)' }]}>
          <Pressable style={StyleSheet.absoluteFill} onPress={handleClose} />
        </Animated.View>

        <Animated.View style={[styles.sheet, { transform: [{ translateY: panY }] }]}>
          <BlurView intensity={80} tint="dark" style={StyleSheet.absoluteFill} />
          <View style={[StyleSheet.absoluteFill, { backgroundColor: 'rgba(16,16,20,0.84)' }]} />

          {/* Шапка */}
          <View style={styles.headerArea} {...panResponder.panHandlers}>
            <View style={styles.grabber} />
            <View style={styles.headerRow}>
              <View style={styles.headerTitleWrap}>
                <View style={styles.sparkleBadge}>
                  <Ionicons name={isImage ? 'image' : 'sparkles'} size={14} color={colors.onAccent} />
                </View>
                <Text style={styles.headerTitle} numberOfLines={1}>
                  {isImage ? 'WouFY Card' : 'WouFY Clip'}
                </Text>
              </View>

              <PressableScale onPress={handleClose} hitSlop={12} disabled={generating}>
                <View style={styles.closeBtn}>
                  <Ionicons name="close" size={18} color={colors.text2} />
                </View>
              </PressableScale>
            </View>

            <View style={styles.headerSubRow}>
              <View style={styles.durationPill}>
                <Text style={styles.durationPillText}>
                  {isImage ? `${selectedLinesCount} / ${MAX_IMAGE_LINES} стр.` : `${Math.round(clipDuration)} сек`}
                </Text>
              </View>

              {/* Переключатель режима прямо в шапке: Видео <-> Карточка */}
              {onModeChange && (
                <View style={styles.modeSwitchPill}>
                  <PressableScale
                    onPress={() => {
                      if (isImage) {
                        Haptics.selectionAsync();
                        LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
                        onModeChange('video');
                      }
                    }}
                    scaleTo={0.95}
                  >
                    <View style={[styles.modeSwitchBtn, !isImage && styles.modeSwitchBtnActive]}>
                      <Ionicons name="film-outline" size={12} color={!isImage ? colors.onAccent : colors.text2} />
                      <Text style={[styles.modeSwitchText, !isImage && styles.modeSwitchTextActive]}>Видео</Text>
                    </View>
                  </PressableScale>
                  <PressableScale
                    onPress={() => {
                      if (!isImage) {
                        Haptics.selectionAsync();
                        LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
                        onModeChange('image');
                      }
                    }}
                    scaleTo={0.95}
                  >
                    <View style={[styles.modeSwitchBtn, isImage && styles.modeSwitchBtnActive]}>
                      <Ionicons name="image-outline" size={12} color={isImage ? colors.onAccent : colors.text2} />
                      <Text style={[styles.modeSwitchText, isImage && styles.modeSwitchTextActive]}>Фото</Text>
                    </View>
                  </PressableScale>
                </View>
              )}
            </View>
          </View>

          <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={styles.scrollContent}>
            {/* 1. ЖИВОЕ ПРЕВЬЮ КАРТОЧКИ */}
            <View style={styles.previewStage}>
              <View style={[styles.previewCard, { width: previewW, height: previewH }]}>
                {/* Размытый фон из обложки трека */}
                {track.artworkUri ? (
                  <Image
                    source={{ uri: track.artworkUri }}
                    blurRadius={18}
                    resizeMode="cover"
                    style={[StyleSheet.absoluteFill, { transform: [{ scale: 1.25 }] }]}
                  />
                ) : (
                  <View style={[StyleSheet.absoluteFill, { backgroundColor: '#1c1c22' }]} />
                )}
                <View style={[StyleSheet.absoluteFill, { backgroundColor: 'rgba(8,8,10,0.52)' }]} />

                {/* Стеклянная карточка цитаты (для WouFY Card) */}
                {clipStyle === 'glassQuote' ? (
                  <View style={styles.previewGlassQuoteBox}>
                    <View style={styles.previewGlassQuoteHeader}>
                      <CoverArt
                        uri={track.artworkUri}
                        size={22}
                        radius={coverShape === 'vinyl' ? 11 : 6}
                      />
                      <View style={{ flex: 1 }}>
                        <Text style={styles.previewQuoteTitle} numberOfLines={1}>
                          {track.title}
                        </Text>
                        <Text style={styles.previewQuoteArtist} numberOfLines={1}>
                          {track.artist}
                        </Text>
                      </View>
                    </View>
                    <View style={styles.previewQuoteDivider} />
                    <View style={{ gap: 3 }}>
                      {clipLines.slice(0, MAX_IMAGE_LINES).map((l, i) => (
                        <Text
                          key={i}
                          style={[
                            styles.previewQuoteLine,
                            clipLines.length > 3 && { fontSize: 8.5, lineHeight: 11 },
                          ]}
                          numberOfLines={2}
                        >
                          {l.text}
                        </Text>
                      ))}
                    </View>
                  </View>
                ) : clipStyle === 'textOnly' ? (
                  <View style={styles.previewTextOnlyWrap}>
                    <View style={styles.previewHeaderPill}>
                      <CoverArt uri={track.artworkUri} size={18} radius={9} />
                      <Text style={styles.previewHeaderPillText} numberOfLines={1}>
                        {track.title} · {track.artist}
                      </Text>
                    </View>
                    {isImage ? (
                      <View style={styles.previewStaticLinesCol}>
                        {clipLines.slice(0, MAX_IMAGE_LINES).map((l, i) => (
                          <Text
                            key={i}
                            style={[
                              styles.previewStaticLineText,
                              clipLines.length > 3 && { fontSize: 9 },
                            ]}
                            numberOfLines={2}
                          >
                            {l.text}
                          </Text>
                        ))}
                      </View>
                    ) : (
                      <View style={styles.previewKaraokeCol}>
                        {prevLine ? (
                          <Text style={styles.previewLineDim} numberOfLines={1}>
                            {prevLine}
                          </Text>
                        ) : null}
                        <Text style={styles.previewLineActive} numberOfLines={2}>
                          {curLine}
                        </Text>
                        {nextLine ? (
                          <Text style={styles.previewLineDim} numberOfLines={1}>
                            {nextLine}
                          </Text>
                        ) : null}
                      </View>
                    )}
                  </View>
                ) : clipStyle === 'inCover' ? (
                  <View style={styles.previewInCoverWrap}>
                    <View
                      style={{
                        width: coverSize,
                        height: coverSize,
                        borderRadius: coverRadius,
                        overflow: 'hidden',
                        alignItems: 'center',
                        justifyContent: 'center',
                        borderWidth: 1,
                        borderColor: 'rgba(255,255,255,0.25)',
                      }}
                    >
                      <Animated.View
                        style={[
                          StyleSheet.absoluteFill,
                          !isImage && coverShape === 'vinyl' && { transform: [{ rotate: spinDeg }] },
                        ]}
                      >
                        <CoverArt uri={track.artworkUri} size={coverSize} radius={0} />
                      </Animated.View>
                      <View style={[StyleSheet.absoluteFill, { backgroundColor: 'rgba(8,8,10,0.58)' }]} />
                      {isImage ? (
                        <View style={{ paddingHorizontal: 10, alignItems: 'center', gap: 2 }}>
                          {clipLines.slice(0, MAX_IMAGE_LINES).map((l, i) => (
                            <Text
                              key={i}
                              style={[
                                styles.previewStaticLineText,
                                { fontSize: clipLines.length > 3 ? 7.5 : 9 },
                              ]}
                              numberOfLines={2}
                            >
                              {l.text}
                            </Text>
                          ))}
                        </View>
                      ) : (
                        <View style={{ paddingHorizontal: 10, alignItems: 'center', gap: 2 }}>
                          {prevLine ? (
                            <Text style={[styles.previewLineDim, { fontSize: 8 }]} numberOfLines={1}>
                              {prevLine}
                            </Text>
                          ) : null}
                          <Text style={[styles.previewLineActive, { fontSize: 11 }]} numberOfLines={2}>
                            {curLine}
                          </Text>
                          {nextLine ? (
                            <Text style={[styles.previewLineDim, { fontSize: 8 }]} numberOfLines={1}>
                              {nextLine}
                            </Text>
                          ) : null}
                        </View>
                      )}
                    </View>
                    <Text style={styles.previewMetaTitle} numberOfLines={1}>
                      {track.title}
                    </Text>
                    <Text style={styles.previewMetaArtist} numberOfLines={1}>
                      {track.artist}
                    </Text>
                  </View>
                ) : isLandscape ? (
                  <View style={styles.previewLandscapeRow}>
                    <View style={{ alignItems: 'center', width: coverSize + 10 }}>
                      <Animated.View
                        style={[
                          {
                            width: coverSize,
                            height: coverSize,
                            borderRadius: coverRadius,
                            overflow: 'hidden',
                            borderWidth: 1,
                            borderColor: 'rgba(255,255,255,0.22)',
                          },
                          !isImage && coverShape === 'vinyl' && { transform: [{ rotate: spinDeg }] },
                        ]}
                      >
                        <CoverArt uri={track.artworkUri} size={coverSize} radius={0} />
                      </Animated.View>
                      <Text style={[styles.previewMetaTitle, { marginTop: 4 }]} numberOfLines={1}>
                        {track.title}
                      </Text>
                      <Text style={styles.previewMetaArtist} numberOfLines={1}>
                        {track.artist}
                      </Text>
                    </View>
                    {isImage ? (
                      <View style={[styles.previewStaticLinesCol, { flex: 1, alignItems: 'flex-start', paddingLeft: 10 }]}>
                        {clipLines.slice(0, MAX_IMAGE_LINES).map((l, i) => (
                          <Text
                            key={i}
                            style={[
                              styles.previewStaticLineText,
                              { textAlign: 'left', fontSize: clipLines.length > 3 ? 8 : 9.5 },
                            ]}
                            numberOfLines={2}
                          >
                            {l.text}
                          </Text>
                        ))}
                      </View>
                    ) : (
                      <View style={[styles.previewKaraokeCol, { flex: 1, alignItems: 'flex-start', paddingLeft: 10 }]}>
                        {prevLine ? (
                          <Text style={[styles.previewLineDim, { textAlign: 'left' }]} numberOfLines={1}>
                            {prevLine}
                          </Text>
                        ) : null}
                        <Text style={[styles.previewLineActive, { textAlign: 'left' }]} numberOfLines={2}>
                          {curLine}
                        </Text>
                        {nextLine ? (
                          <Text style={[styles.previewLineDim, { textAlign: 'left' }]} numberOfLines={1}>
                            {nextLine}
                          </Text>
                        ) : null}
                      </View>
                    )}
                  </View>
                ) : (
                  <View style={styles.previewPortraitCol}>
                    <Animated.View
                      style={[
                        {
                          width: coverSize,
                          height: coverSize,
                          borderRadius: coverRadius,
                          overflow: 'hidden',
                          borderWidth: 1,
                          borderColor: 'rgba(255,255,255,0.22)',
                        },
                        !isImage && coverShape === 'vinyl' && { transform: [{ rotate: spinDeg }] },
                      ]}
                    >
                      <CoverArt uri={track.artworkUri} size={coverSize} radius={0} />
                    </Animated.View>
                    <Text style={[styles.previewMetaTitle, { marginTop: 4 }]} numberOfLines={1}>
                      {track.title}
                    </Text>
                    <Text style={styles.previewMetaArtist} numberOfLines={1}>
                      {track.artist}
                    </Text>
                    {isImage ? (
                      <View style={[styles.previewStaticLinesCol, { marginTop: 4 }]}>
                        {clipLines.slice(0, MAX_IMAGE_LINES).map((l, i) => (
                          <Text
                            key={i}
                            style={[
                              styles.previewStaticLineText,
                              { fontSize: clipLines.length > 3 ? 8 : 9.5 },
                            ]}
                            numberOfLines={2}
                          >
                            {l.text}
                          </Text>
                        ))}
                      </View>
                    ) : (
                      <View style={[styles.previewKaraokeCol, { marginTop: 4 }]}>
                        {prevLine ? (
                          <Text style={styles.previewLineDim} numberOfLines={1}>
                            {prevLine}
                          </Text>
                        ) : null}
                        <Text style={styles.previewLineActive} numberOfLines={2}>
                          {curLine}
                        </Text>
                        {nextLine ? (
                          <Text style={styles.previewLineDim} numberOfLines={1}>
                            {nextLine}
                          </Text>
                        ) : null}
                      </View>
                    )}
                  </View>
                )}

                {/* Водяной знак снизу */}
                <View style={styles.previewWatermark}>
                  <Text style={styles.previewWatermarkText}>{isImage ? 'WouFY Card' : 'WouFY Clip'}</Text>
                </View>
              </View>

              {/* Кнопка предпрослушивания отрывка (для видео) */}
              {!isImage && (
                <PressableScale onPress={togglePreviewPlay} scaleTo={0.95} haptic="light" style={{ marginTop: 12 }}>
                  <Glass radius={999} style={styles.previewPlayPill}>
                    <View style={styles.previewPlayInner}>
                      <Ionicons name={previewPlaying ? 'pause' : 'play'} size={15} color={colors.accent} />
                      <Text style={styles.previewPlayText}>
                        {previewPlaying
                          ? `Играет отрывок (${formatTime(previewPos)})`
                          : `Прослушать отрывок (${formatTime(startSec)} – ${formatTime(endSec)})`}
                      </Text>
                    </View>
                  </Glass>
                </PressableScale>
              )}
            </View>

            {/* 2. СТИЛЬ ОФОРМЛЕНИЯ */}
            <Text style={styles.sectionLabel}>Стиль оформления</Text>
            <Glass radius={22} style={styles.segmentedGlass}>
              <ScrollView
                horizontal
                showsHorizontalScrollIndicator={false}
                contentContainerStyle={styles.segmentedScrollRow}
              >
                {styleOptions.map((opt) => {
                  const active = clipStyle === opt.key;
                  return (
                    <PressableScale
                      key={opt.key}
                      onPress={() => {
                        Haptics.selectionAsync();
                        LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
                        setClipStyle(opt.key);
                      }}
                      scaleTo={0.96}
                      style={{ flexGrow: 1 }}
                    >
                      <View style={[styles.segmentBtn, styles.segmentBtnAuto, active && styles.segmentBtnActive]}>
                        <Ionicons name={opt.icon} size={14} color={active ? colors.onAccent : colors.text2} />
                        <Text style={[styles.segmentBtnText, active && styles.segmentBtnTextActive]} numberOfLines={1}>
                          {opt.label}
                        </Text>
                      </View>
                    </PressableScale>
                  );
                })}
              </ScrollView>
            </Glass>

            {/* 3. ВИД ОБЛОЖКИ (только если стиль с обложкой) */}
            {clipStyle !== 'textOnly' && (
              <>
                <Text style={styles.sectionLabel}>Форма обложки</Text>
                <Glass radius={22} style={styles.segmentedGlass}>
                  <View style={styles.segmentedRow}>
                    {(
                      [
                        {
                          key: 'vinyl',
                          label: isImage ? 'Круглая пластинка' : 'Крутится (Пластинка)',
                          icon: 'disc-outline',
                        },
                        {
                          key: 'square',
                          label: isImage ? 'Классический квадрат' : 'Статичная обложка',
                          icon: 'square-outline',
                        },
                      ] as const
                    ).map((opt) => {
                      const active = coverShape === opt.key;
                      return (
                        <PressableScale
                          key={opt.key}
                          onPress={() => {
                            Haptics.selectionAsync();
                            setCoverShape(opt.key);
                          }}
                          scaleTo={0.96}
                          style={{ flex: 1, minWidth: 0 }}
                        >
                          <View style={[styles.segmentBtn, active && styles.segmentBtnActive]}>
                            <Ionicons name={opt.icon} size={16} color={active ? colors.onAccent : colors.text2} />
                            <Text style={[styles.segmentBtnText, active && styles.segmentBtnTextActive]} numberOfLines={1}>
                              {opt.label}
                            </Text>
                          </View>
                        </PressableScale>
                      );
                    })}
                  </View>
                </Glass>
              </>
            )}

            {/* 4. СООТНОШЕНИЕ СТОРОН */}
            <Text style={styles.sectionLabel}>Соотношение сторон</Text>
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.aspectRow}>
              {ASPECT_OPTIONS.map((opt) => {
                const active = aspect === opt.key;
                return (
                  <PressableScale
                    key={opt.key}
                    onPress={() => {
                      Haptics.selectionAsync();
                      LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
                      setAspect(opt.key);
                    }}
                    scaleTo={0.94}
                  >
                    <View style={[styles.aspectPill, active && styles.aspectPillActive]}>
                      <Text style={[styles.aspectLabel, active && styles.aspectLabelActive]}>{opt.label}</Text>
                      <Text style={[styles.aspectSub, active && styles.aspectSubActive]}>{opt.sub}</Text>
                    </View>
                  </PressableScale>
                );
              })}
            </ScrollView>

            {/* 5. ВЫБОР СТРОК ПЕСНИ */}
            <View style={styles.fragmentHeaderRow}>
              <Text style={styles.sectionLabel}>
                {isImage
                  ? `Строки для карточки — любые до ${MAX_IMAGE_LINES} (выбрано ${selectedLinesCount} / ${MAX_IMAGE_LINES})`
                  : `Фрагмент текста (${selectedLinesCount} стр. · ${Math.round(clipDuration)} сек)`}
              </Text>
            </View>
            <Glass radius={24} style={styles.linesPickerGlass}>
              <ScrollView nestedScrollEnabled style={{ maxHeight: 190 }} contentContainerStyle={{ padding: 8, gap: 4 }}>
                {lines.map((l, idx) => {
                  const selected = isImage ? imageSet.has(idx) : hasVideoSelection && idx >= s && idx <= e;
                  const isEdge = isImage ? selected : hasVideoSelection && (idx === s || idx === e);
                  return (
                    <PressableScale key={idx} onPress={() => handleLineTap(idx)} scaleTo={0.98}>
                      <View
                        style={[
                          styles.pickerLineRow,
                          selected && styles.pickerLineRowSelected,
                          isEdge && styles.pickerLineRowEdge,
                        ]}
                      >
                        <Text style={[styles.pickerLineTime, selected && { color: colors.text }]}>
                          {formatTime(l.time)}
                        </Text>
                        <Text
                          style={[styles.pickerLineText, selected && styles.pickerLineTextSelected]}
                          numberOfLines={1}
                        >
                          {l.text}
                        </Text>
                        {selected && (
                          <Ionicons
                            name={isEdge ? 'checkmark-circle' : 'ellipse'}
                            size={isEdge ? 16 : 8}
                            color={colors.accent}
                          />
                        )}
                      </View>
                    </PressableScale>
                  );
                })}
              </ScrollView>
            </Glass>

            {hasSelection && (
              <View style={styles.resetLinesWrap}>
                <PressableScale onPress={resetSelectedLines} scaleTo={0.96} haptic="light">
                  <View style={styles.resetLinesPill}>
                    <Ionicons name="refresh-outline" size={14} color={colors.text} />
                    <Text style={styles.resetLinesText}>Сбросить выбранный текст</Text>
                  </View>
                </PressableScale>
              </View>
            )}

            {/* 6. КНОПКА ГЕНЕРАЦИИ И СОХРАНЕНИЯ */}
            <View style={{ marginTop: 18, marginBottom: 30 }}>
              <PressableScale onPress={handleGenerate} disabled={generating} scaleTo={0.97} haptic="medium">
                <View style={[styles.generateBtn, generating && { opacity: 0.85 }]}>
                  {generating ? (
                    <View style={styles.generateBtnInner}>
                      <ActivityIndicator size="small" color={colors.onAccent} />
                      <Text style={styles.generateBtnText}>
                        {isImage
                          ? 'Создаём WouFY Card…'
                          : `Создаём WouFY Clip… ${Math.round(progress * 100)}%`}
                      </Text>
                    </View>
                  ) : (
                    <View style={styles.generateBtnInner}>
                      <Ionicons name={isImage ? 'image-outline' : 'film-outline'} size={20} color={colors.onAccent} />
                      <Text style={styles.generateBtnText}>
                        {isImage ? 'Сохранить и поделиться карточкой' : 'Сгенерировать и сохранить видео'}
                      </Text>
                    </View>
                  )}
                </View>
              </PressableScale>
            </View>
          </ScrollView>
        </Animated.View>
      </View>
    </Modal>
  );
};

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    justifyContent: 'flex-end',
  },
  sheet: {
    height: '91%',
    borderTopLeftRadius: 32,
    borderTopRightRadius: 32,
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.12)',
  },
  headerArea: {
    paddingTop: 10,
    paddingHorizontal: 20,
    paddingBottom: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: 'rgba(255,255,255,0.1)',
  },
  grabber: {
    alignSelf: 'center',
    width: 36,
    height: 4,
    borderRadius: 2,
    backgroundColor: 'rgba(255,255,255,0.22)',
    marginBottom: 10,
  },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
  },
  headerSubRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
    marginTop: 10,
  },
  headerTitleWrap: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 7,
    flex: 1,
    minWidth: 0,
  },
  sparkleBadge: {
    width: 26,
    height: 26,
    borderRadius: 13,
    backgroundColor: colors.accent,
    alignItems: 'center',
    justifyContent: 'center',
  },
  headerTitle: {
    ...type.title,
    fontSize: 19,
    color: colors.text,
  },
  durationPill: {
    paddingHorizontal: 9,
    paddingVertical: 3,
    borderRadius: 999,
    backgroundColor: 'rgba(255,255,255,0.12)',
  },
  durationPillText: {
    ...type.mono,
    fontSize: 10,
    color: colors.text,
    fontWeight: '700',
  },
  modeSwitchPill: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: 'rgba(255,255,255,0.08)',
    borderRadius: 999,
    padding: 2,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.14)',
  },
  modeSwitchBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 9,
    paddingVertical: 4,
    borderRadius: 999,
  },
  modeSwitchBtnActive: {
    backgroundColor: colors.accent,
  },
  modeSwitchText: {
    ...type.caption,
    fontSize: 11,
    color: colors.text2,
    fontWeight: '700',
  },
  modeSwitchTextActive: {
    color: colors.onAccent,
  },
  closeBtn: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: 'rgba(255,255,255,0.08)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.15)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  scrollContent: {
    paddingHorizontal: 20,
    paddingTop: 14,
    paddingBottom: 40,
  },
  previewStage: {
    alignItems: 'center',
    marginBottom: 14,
  },
  previewCard: {
    borderRadius: 22,
    overflow: 'hidden',
    borderWidth: 1.5,
    borderColor: 'rgba(255,255,255,0.22)',
    backgroundColor: '#101014',
    justifyContent: 'center',
    alignItems: 'center',
    padding: 12,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 10 },
    shadowOpacity: 0.5,
    shadowRadius: 18,
    elevation: 12,
  },
  previewGlassQuoteBox: {
    width: '88%',
    backgroundColor: 'rgba(18,18,22,0.68)',
    borderRadius: 16,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.22)',
    padding: 10,
    gap: 6,
  },
  previewGlassQuoteHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 7,
  },
  previewQuoteTitle: {
    ...type.headline,
    fontSize: 9.5,
    color: colors.text,
    fontWeight: '800',
  },
  previewQuoteArtist: {
    ...type.caption,
    fontSize: 8,
    color: 'rgba(255,255,255,0.62)',
  },
  previewQuoteDivider: {
    height: 1,
    backgroundColor: 'rgba(255,255,255,0.12)',
  },
  previewQuoteLine: {
    ...type.headline,
    fontSize: 10,
    lineHeight: 13,
    color: '#FFFFFF',
    fontWeight: '800',
  },
  previewStaticLinesCol: {
    alignItems: 'center',
    justifyContent: 'center',
    gap: 4,
    paddingHorizontal: 6,
  },
  previewStaticLineText: {
    ...type.headline,
    fontSize: 10.5,
    color: '#FFFFFF',
    fontWeight: '800',
    textAlign: 'center',
  },
  previewTextOnlyWrap: {
    flex: 1,
    width: '100%',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 6,
  },
  previewHeaderPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 9,
    paddingVertical: 4,
    borderRadius: 999,
    backgroundColor: 'rgba(255,255,255,0.12)',
    maxWidth: '92%',
    overflow: 'hidden',
  },
  previewHeaderPillText: {
    ...type.caption,
    fontSize: 9,
    color: colors.text,
    fontWeight: '700',
    flexShrink: 1,
    minWidth: 0,
  },
  previewInCoverWrap: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  previewLandscapeRow: {
    flex: 1,
    width: '100%',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 4,
  },
  previewPortraitCol: {
    flex: 1,
    width: '100%',
    alignItems: 'center',
    justifyContent: 'center',
  },
  previewMetaTitle: {
    ...type.headline,
    fontSize: 10,
    color: colors.text,
    fontWeight: '800',
    marginTop: 4,
    textAlign: 'center',
  },
  previewMetaArtist: {
    ...type.caption,
    fontSize: 8,
    color: 'rgba(255,255,255,0.65)',
    textAlign: 'center',
  },
  previewKaraokeCol: {
    alignItems: 'center',
    justifyContent: 'center',
    gap: 2,
    paddingHorizontal: 6,
  },
  previewLineDim: {
    ...type.caption,
    fontSize: 9,
    color: 'rgba(255,255,255,0.38)',
    fontWeight: '700',
    textAlign: 'center',
  },
  previewLineActive: {
    ...type.headline,
    fontSize: 12,
    color: '#FFFFFF',
    fontWeight: '800',
    textAlign: 'center',
  },
  previewWatermark: {
    position: 'absolute',
    bottom: 5,
    paddingHorizontal: 7,
    paddingVertical: 2,
    borderRadius: 999,
    backgroundColor: 'rgba(255,255,255,0.12)',
  },
  previewWatermarkText: {
    fontSize: 7,
    fontWeight: '800',
    color: 'rgba(255,255,255,0.75)',
  },
  previewPlayPill: {
    paddingHorizontal: 16,
    paddingVertical: 8,
  },
  previewPlayInner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 7,
  },
  previewPlayText: {
    ...type.caption,
    fontSize: 12,
    color: colors.text,
    fontWeight: '700',
  },
  sectionLabel: {
    ...type.caption,
    fontSize: 11,
    color: colors.text3,
    fontWeight: '700',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginTop: 12,
    marginBottom: 7,
    paddingHorizontal: 4,
  },
  segmentedGlass: {
    padding: 3,
  },
  segmentedRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  segmentedScrollRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    minWidth: '100%',
  },
  segmentBtn: {
    height: 38,
    borderRadius: 19,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 5,
    paddingHorizontal: 10,
    overflow: 'hidden',
  },
  segmentBtnAuto: {
    paddingHorizontal: 13,
  },
  segmentBtnActive: {
    backgroundColor: colors.accent,
  },
  segmentBtnText: {
    ...type.caption,
    fontSize: 11,
    color: colors.text2,
    fontWeight: '600',
    flexShrink: 1,
    minWidth: 0,
  },
  segmentBtnTextActive: {
    color: colors.onAccent,
    fontWeight: '800',
  },
  aspectRow: {
    flexDirection: 'row',
    gap: 8,
    paddingVertical: 2,
  },
  aspectPill: {
    paddingHorizontal: 16,
    paddingVertical: 9,
    borderRadius: 999,
    backgroundColor: 'rgba(255,255,255,0.08)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.14)',
    alignItems: 'center',
    minWidth: 74,
  },
  aspectPillActive: {
    backgroundColor: colors.accent,
    borderColor: colors.accent,
  },
  aspectLabel: {
    ...type.mono,
    fontSize: 13,
    color: colors.text,
    fontWeight: '800',
  },
  aspectLabelActive: {
    color: colors.onAccent,
  },
  aspectSub: {
    ...type.caption,
    fontSize: 10,
    color: colors.text3,
    marginTop: 1,
  },
  aspectSubActive: {
    color: 'rgba(8,8,8,0.65)',
    fontWeight: '600',
  },
  fragmentHeaderRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  linesPickerGlass: {
    overflow: 'hidden',
  },
  resetLinesWrap: {
    alignItems: 'center',
    marginTop: 10,
  },
  resetLinesPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 999,
    backgroundColor: 'rgba(255,255,255,0.10)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.18)',
  },
  resetLinesText: {
    ...type.caption,
    fontSize: 12,
    color: colors.text,
    fontWeight: '700',
  },
  pickerLineRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 9,
    paddingHorizontal: 14,
    borderRadius: 999,
    gap: 10,
  },
  pickerLineRowSelected: {
    backgroundColor: 'rgba(255,255,255,0.12)',
  },
  pickerLineRowEdge: {
    backgroundColor: 'rgba(255,255,255,0.20)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.32)',
  },
  pickerLineTime: {
    ...type.mono,
    fontSize: 11,
    color: colors.text3,
    width: 36,
  },
  pickerLineText: {
    ...type.body,
    fontSize: 13,
    color: colors.text2,
    flex: 1,
  },
  pickerLineTextSelected: {
    color: colors.text,
    fontWeight: '700',
  },
  generateBtn: {
    height: 52,
    borderRadius: 26,
    backgroundColor: colors.accent,
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: '#FFF',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.2,
    shadowRadius: 12,
    elevation: 8,
  },
  generateBtnInner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  generateBtnText: {
    ...type.headline,
    fontSize: 15,
    color: colors.onAccent,
    fontWeight: '800',
  },
});
