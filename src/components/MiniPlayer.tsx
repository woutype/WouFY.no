import React, { useRef } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  Image,
  PanResponder,
  Animated,
} from 'react-native';
import { BlurView } from 'expo-blur';
import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { TrackFile } from '../services/fileScanner';

interface MiniPlayerProps {
  track: TrackFile;
  isPlaying: boolean;
  currentTime: number;
  duration: number;
  onPress: () => void;
  onTogglePlayPause: () => void;
  onNext: () => void;
  onPrevious: () => void;
}

function formatTime(seconds: number): string {
  if (!seconds || isNaN(seconds) || seconds < 0) return '0:00';
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins}:${secs < 10 ? '0' : ''}${secs}`;
}

export const MiniPlayer: React.FC<MiniPlayerProps> = ({
  track,
  isPlaying,
  currentTime,
  duration,
  onPress,
  onTogglePlayPause,
  onNext,
  onPrevious,
}) => {
  const progressPercent = duration > 0 ? Math.min(100, (currentTime / duration) * 100) : 0;

  const dragY = useRef(new Animated.Value(0)).current;

  // Gesture: Follow finger 1:1 when pulling up to expand to full player
  const panResponder = useRef(
    PanResponder.create({
      onMoveShouldSetPanResponder: (_, gestureState) => {
        return gestureState.dy < -6 && Math.abs(gestureState.dx) < 20;
      },
      onPanResponderMove: (_, gestureState) => {
        if (gestureState.dy < 0) {
          dragY.setValue(Math.max(-50, gestureState.dy));
        }
      },
      onPanResponderRelease: (_, gestureState) => {
        if (gestureState.dy < -20 || gestureState.vy < -0.4) {
          Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
          Animated.timing(dragY, {
            toValue: -80,
            duration: 150,
            useNativeDriver: true,
          }).start(() => {
            dragY.setValue(0);
            onPress(); // Smoothly reveals full player
          });
        } else {
          Animated.spring(dragY, {
            toValue: 0,
            friction: 7,
            tension: 60,
            useNativeDriver: true,
          }).start();
        }
      },
    })
  ).current;

  return (
    <Animated.View
      style={[styles.container, { transform: [{ translateY: dragY }] }]}
      {...panResponder.panHandlers}
    >
      <TouchableOpacity activeOpacity={0.92} onPress={onPress}>
        <BlurView intensity={80} tint="dark" style={styles.blurCard}>
          {/* Progress bar line on top edge */}
          <View style={styles.progressTrack}>
            <View style={[styles.progressBar, { width: `${progressPercent}%` }]} />
          </View>

          <View style={styles.content}>
            {/* Mini Album Artwork */}
            {track.artworkUri ? (
              <Image source={{ uri: track.artworkUri }} style={styles.thumbImage} />
            ) : (
              <View style={styles.thumbFallback}>
                <Ionicons name="musical-notes" size={20} color="#c084fc" />
              </View>
            )}

            {/* Info */}
            <View style={styles.info}>
              <Text style={styles.title} numberOfLines={1}>
                {track.title}
              </Text>
              <Text style={styles.subtitle} numberOfLines={1}>
                {track.artist || 'NEXTIME'} • {formatTime(currentTime)} / {formatTime(duration)}
              </Text>
            </View>

            {/* Controls */}
            <View style={styles.controls}>
              <TouchableOpacity
                hitSlop={{ top: 12, bottom: 12, left: 10, right: 10 }}
                onPress={onPrevious}
                style={styles.iconBtn}
              >
                <Ionicons name="play-skip-back" size={20} color="#cbd5e1" />
              </TouchableOpacity>

              <TouchableOpacity
                hitSlop={{ top: 12, bottom: 12, left: 10, right: 10 }}
                onPress={onTogglePlayPause}
                style={styles.playPauseBtn}
              >
                <Ionicons
                  name={isPlaying ? 'pause' : 'play'}
                  size={18}
                  color="#ffffff"
                  style={{ marginLeft: isPlaying ? 0 : 2 }}
                />
              </TouchableOpacity>

              <TouchableOpacity
                hitSlop={{ top: 12, bottom: 12, left: 10, right: 10 }}
                onPress={onNext}
                style={styles.iconBtn}
              >
                <Ionicons name="play-skip-forward" size={20} color="#cbd5e1" />
              </TouchableOpacity>
            </View>
          </View>
        </BlurView>
      </TouchableOpacity>
    </Animated.View>
  );
};

const styles = StyleSheet.create({
  container: {
    position: 'absolute',
    bottom: 24,
    left: 16,
    right: 16,
    zIndex: 100,
    shadowColor: '#a855f7',
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.35,
    shadowRadius: 18,
    elevation: 10,
  },
  blurCard: {
    borderRadius: 999, // Photo 5: Completely rounded capsule
    borderWidth: 1,
    borderColor: 'rgba(192, 132, 252, 0.32)',
    overflow: 'hidden',
    backgroundColor: 'rgba(28, 14, 42, 0.85)',
  },
  progressTrack: {
    height: 2.5,
    backgroundColor: 'rgba(255, 255, 255, 0.08)',
    width: '100%',
  },
  progressBar: {
    height: '100%',
    backgroundColor: '#c084fc',
  },
  content: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 8,
    paddingHorizontal: 12,
  },
  thumbImage: {
    width: 44,
    height: 44,
    borderRadius: 22,
    marginRight: 12,
    backgroundColor: 'rgba(255, 255, 255, 0.05)',
  },
  thumbFallback: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: 'rgba(168, 85, 247, 0.25)',
    borderWidth: 1,
    borderColor: 'rgba(192, 132, 252, 0.4)',
    justifyContent: 'center',
    alignItems: 'center',
    marginRight: 12,
  },
  info: {
    flex: 1,
    marginRight: 8,
  },
  title: {
    fontSize: 15,
    fontWeight: '700',
    color: '#ffffff',
  },
  subtitle: {
    fontSize: 12,
    color: '#c084fc',
    marginTop: 2,
    fontVariant: ['tabular-nums'],
  },
  controls: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingRight: 4,
  },
  iconBtn: {
    padding: 6,
  },
  playPauseBtn: {
    width: 38,
    height: 38,
    borderRadius: 19,
    backgroundColor: '#9333ea',
    justifyContent: 'center',
    alignItems: 'center',
    shadowColor: '#a855f7',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.5,
    shadowRadius: 6,
  },
});
