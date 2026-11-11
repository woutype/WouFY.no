import React, { useRef, useEffect, useMemo } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  PanResponder,
  Animated,
} from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import * as Haptics from 'expo-haptics';
import { TrackFile } from '../services/fileScanner';
import { MiniPlayer } from './MiniPlayer';

interface LyricsViewProps {
  currentTrack: TrackFile | null;
  isPlaying: boolean;
  currentTime: number;
  duration: number;
  onTogglePlayPause: () => void;
  onNext: () => void;
  onPrevious: () => void;
  onSeek: (seconds: number) => void;
  onClose: () => void;
}

const LINE_HEIGHT = 44;

interface TimedLine {
  text: string;
  isSection: boolean;
  startTime: number;
  endTime: number;
}

export const LyricsView: React.FC<LyricsViewProps> = ({
  currentTrack,
  isPlaying,
  currentTime,
  duration,
  onTogglePlayPause,
  onNext,
  onPrevious,
  onSeek,
  onClose,
}) => {
  const scrollRef = useRef<any>(null);

  // Smooth 1:1 pull down gesture to dismiss lyrics without sticking
  const panY = useRef(new Animated.Value(0)).current;
  const panResponder = useRef(
    PanResponder.create({
      onMoveShouldSetPanResponder: (_, gestureState) => {
        return gestureState.dy > 8 && Math.abs(gestureState.dx) < 25;
      },
      onPanResponderMove: (_, gestureState) => {
        if (gestureState.dy > 0) {
          panY.setValue(gestureState.dy);
        }
      },
      onPanResponderRelease: (_, gestureState) => {
        if (gestureState.dy > 70 || gestureState.vy > 0.5) {
          Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
          Animated.timing(panY, {
            toValue: 700,
            duration: 200,
            useNativeDriver: true,
          }).start(() => {
            onClose();
            panY.setValue(0);
          });
        } else {
          Animated.spring(panY, {
            toValue: 0,
            friction: 7,
            tension: 60,
            useNativeDriver: true,
          }).start();
        }
      },
    })
  ).current;

  // Build accurate timeline for lines
  const timedLines: TimedLine[] = useMemo(() => {
    if (!currentTrack?.lyrics) {
      return [
        {
          text: 'Текст песни не найден в метаданных ID3.',
          isSection: false,
          startTime: 0,
          endTime: duration || 120,
        },
      ];
    }

    const rawLines = currentTrack.lyrics
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.length > 0);

    const validDuration = duration > 0 ? duration : 119;

    // Check for standard LRC timestamps [mm:ss.xx]
    const lrcRegex = /^\[(\d{1,2}):(\d{2}(?:\.\d{1,3})?)\](.*)$/;
    const hasLrc = rawLines.some((l) => lrcRegex.test(l));

    if (hasLrc) {
      const parsed: TimedLine[] = [];
      for (let i = 0; i < rawLines.length; i++) {
        const m = rawLines[i].match(lrcRegex);
        if (m) {
          const mins = parseInt(m[1], 10);
          const secs = parseFloat(m[2]);
          const start = mins * 60 + secs;
          const text = m[3].trim();
          parsed.push({
            text: text || '...',
            isSection: text.startsWith('(') && text.endsWith(')'),
            startTime: start,
            endTime: start + 2.5,
          });
        }
      }
      for (let i = 0; i < parsed.length - 1; i++) {
        parsed[i].endTime = parsed[i + 1].startTime;
      }
      if (parsed.length > 0) {
        parsed[parsed.length - 1].endTime = validDuration;
        return parsed;
      }
    }

    // Heuristic alignment for USLT (unsynced ID3 lyrics):
    // 1. Songs start with instrumental intro (~6.5 seconds)
    // 2. Section markers (Интро/Куплет/Припев) give natural breathing pauses
    // 3. Short ad-libs ("Ай", "Бля") take ~1.2s, verses take proportional time
    const weights: number[] = rawLines.map((line, idx) => {
      const isSec = line.startsWith('(') && line.endsWith(')');
      if (idx === 0 && isSec) {
        // Intro musical opening
        return 6.5;
      }
      if (isSec) {
        // Verse/Chorus transitions
        return 2.2;
      }
      if (line.length <= 6) {
        return 1.3; // Short ad-libs
      }
      return Math.min(3.6, Math.max(1.6, line.length * 0.11 + 1.2));
    });

    const totalWeight = weights.reduce((acc, w) => acc + w, 0);
    let accumTime = 0;

    return rawLines.map((line, idx) => {
      const lineDuration = (weights[idx] / totalWeight) * validDuration;
      const start = accumTime;
      const end = accumTime + lineDuration;
      accumTime = end;

      return {
        text: line,
        isSection: line.startsWith('(') && line.endsWith(')'),
        startTime: start,
        endTime: end,
      };
    });
  }, [currentTrack?.lyrics, duration]);

  // Find line currently playing: probe slightly ahead to prevent falling into previous line
  const activeLineIndex = useMemo(() => {
    if (timedLines.length <= 1) return 0;
    const probe = currentTime + 0.12;
    const found = timedLines.findIndex(
      (item) => probe >= item.startTime && probe < item.endTime
    );
    if (found !== -1) return found;
    return currentTime >= (timedLines[timedLines.length - 1]?.endTime || 0)
      ? timedLines.length - 1
      : 0;
  }, [currentTime, timedLines]);

  // Smooth auto-scroll to active line
  useEffect(() => {
    if (isPlaying && scrollRef.current && activeLineIndex >= 0) {
      scrollRef.current.scrollTo({
        y: Math.max(0, activeLineIndex * LINE_HEIGHT - 120),
        animated: true,
      });
    }
  }, [activeLineIndex, isPlaying]);

  // Tap line to seek: seek slightly inside the line (+0.2s) so it cleanly highlights THIS line, never the one above!
  const handleLinePress = (line: TimedLine) => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    const targetSeek = Math.min(duration || 999, line.startTime + 0.2);
    onSeek(targetSeek);
  };

  return (
    <Animated.View style={[styles.wrapper, { transform: [{ translateY: panY }] }]}>
      <LinearGradient colors={['#0e0717', '#1a0c28', '#0b0612']} style={styles.container}>
        {/* Top Grabber with 1:1 gesture tracking */}
        <View {...panResponder.panHandlers} style={styles.grabberSection}>
          <View style={styles.grabber} />
        </View>

        {/* Header */}
        <View style={styles.header}>
          <View style={{ flex: 1, marginRight: 12 }}>
            <Text style={styles.headerTitle}>Текст песни</Text>
            <Text style={styles.headerSubtitle} numberOfLines={1}>
              {currentTrack?.title || 'Без названия'} — {currentTrack?.artist || 'NEXTIME'}
            </Text>
          </View>

          <TouchableOpacity
            onPress={() => {
              Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
              onClose();
            }}
            style={styles.closeBtn}
          >
            <Text style={styles.closeBtnText}>Готово</Text>
          </TouchableOpacity>
        </View>

        {/* Karaoke Synchronized Lyrics Scroll */}
        <ScrollView
          ref={scrollRef}
          contentContainerStyle={styles.scrollContent}
          showsVerticalScrollIndicator={false}
        >
          {timedLines.map((lineItem, idx) => {
            const isActive = idx === activeLineIndex;

            return (
              <TouchableOpacity
                key={idx}
                activeOpacity={0.75}
                onPress={() => handleLinePress(lineItem)}
                style={styles.lineTouch}
              >
                <Text
                  style={[
                    styles.lineText,
                    lineItem.isSection && styles.sectionText,
                    isActive && styles.activeLineText,
                  ]}
                >
                  {lineItem.text}
                </Text>
              </TouchableOpacity>
            );
          })}
        </ScrollView>

        {/* Bottom MiniPlayer Capsule: Tap or pull up smoothly returns to Player */}
        {currentTrack && (
          <MiniPlayer
            track={currentTrack}
            isPlaying={isPlaying}
            currentTime={currentTime}
            duration={duration}
            onPress={onClose}
            onTogglePlayPause={onTogglePlayPause}
            onNext={onNext}
            onPrevious={onPrevious}
          />
        )}
      </LinearGradient>
    </Animated.View>
  );
};

const styles = StyleSheet.create({
  wrapper: {
    flex: 1,
  },
  container: {
    flex: 1,
    paddingTop: 8,
  },
  grabberSection: {
    alignItems: 'center',
    paddingVertical: 10,
    width: '100%',
  },
  grabber: {
    width: 38,
    height: 5,
    borderRadius: 3,
    backgroundColor: 'rgba(255, 255, 255, 0.28)',
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 24,
    paddingBottom: 16,
  },
  headerTitle: {
    fontSize: 28,
    fontWeight: '800',
    color: '#ffffff',
    letterSpacing: -0.5,
  },
  headerSubtitle: {
    fontSize: 14,
    color: '#94a3b8',
    marginTop: 2,
  },
  closeBtn: {
    paddingHorizontal: 16,
    paddingVertical: 6,
    borderRadius: 999,
    backgroundColor: 'rgba(255, 255, 255, 0.08)',
  },
  closeBtnText: {
    color: '#c084fc',
    fontSize: 14,
    fontWeight: '600',
  },
  scrollContent: {
    paddingHorizontal: 24,
    paddingTop: 16,
    paddingBottom: 130,
  },
  lineTouch: {
    minHeight: LINE_HEIGHT,
    justifyContent: 'center',
    marginVertical: 4,
  },
  lineText: {
    fontSize: 22,
    fontWeight: '600',
    color: 'rgba(255, 255, 255, 0.35)',
    letterSpacing: -0.3,
  },
  activeLineText: {
    fontSize: 26,
    fontWeight: '800',
    color: '#ffffff',
    textShadowColor: 'rgba(192, 132, 252, 0.65)',
    textShadowOffset: { width: 0, height: 2 },
    textShadowRadius: 10,
  },
  sectionText: {
    fontSize: 15,
    fontWeight: '700',
    color: '#a855f7',
    marginTop: 12,
    marginBottom: 4,
    textTransform: 'uppercase',
    letterSpacing: 1.2,
  },
});
