import React, { useState, useRef } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  Image,
  Dimensions,
  PanResponder,
  Animated,
} from 'react-native';
import Slider from '@react-native-community/slider';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import type { AudioPlayer } from 'expo-audio';
import { TrackFile } from '../services/fileScanner';
import { WaveformVisualizer } from './WaveformVisualizer';
import { SwipeSwitcher } from './SwipeSwitcher';

const { width: SCREEN_WIDTH } = Dimensions.get('window');
const ARTWORK_SIZE = Math.min(SCREEN_WIDTH - 64, 340);

interface PlayerViewProps {
  player: AudioPlayer | null;
  currentTrack: TrackFile | null;
  isPlaying: boolean;
  currentTime: number;
  duration: number;
  volume: number;
  onVolumeChange: (val: number) => void;
  onTogglePlayPause: () => void;
  onNext: () => void;
  onPrevious: () => void;
  onSeek: (seconds: number) => void;
  onOpenQueue: () => void;
  onOpenLyrics: () => void;
  onOpenSettings: () => void;
  onArtistPress: (artist: string) => void;
}

function formatTime(seconds: number): string {
  if (!seconds || isNaN(seconds) || seconds < 0) return '0:00';
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins}:${secs < 10 ? '0' : ''}${secs}`;
}

export const PlayerView: React.FC<PlayerViewProps> = ({
  player,
  currentTrack,
  isPlaying,
  currentTime,
  duration,
  volume,
  onVolumeChange,
  onTogglePlayPause,
  onNext,
  onPrevious,
  onSeek,
  onOpenQueue,
  onOpenLyrics,
  onOpenSettings,
  onArtistPress,
}) => {
  const [showWaveform, setShowWaveform] = useState(false);
  const [isSeeking, setIsSeeking] = useState(false);
  const [seekValue, setSeekValue] = useState(0);
  const [isShuffle, setIsShuffle] = useState(false);
  const [isRepeat, setIsRepeat] = useState(false);

  const displayTime = isSeeking ? seekValue : currentTime;

  // Screen gestures:
  // - Swipe Down from center -> Open Queue
  // - Swipe Right -> Open Queue
  // - Swipe Left -> Open Lyrics
  const screenPanResponder = useRef(
    PanResponder.create({
      onMoveShouldSetPanResponder: (_, gestureState) => {
        return Math.abs(gestureState.dx) > 20 || gestureState.dy > 25;
      },
      onPanResponderRelease: (_, gestureState) => {
        if (gestureState.dy > 50 && Math.abs(gestureState.dx) < 80) {
          // Swiped down from center / artwork -> Queue
          Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
          onOpenQueue();
        } else if (gestureState.dx > 50) {
          // Swiped right -> Queue
          Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
          onOpenQueue();
        } else if (gestureState.dx < -50) {
          // Swiped left -> Lyrics
          Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
          onOpenLyrics();
        }
      },
    })
  ).current;

  return (
    <LinearGradient
      colors={['#0e0717', '#1a0c28', '#0b0612']}
      style={styles.container}
      {...screenPanResponder.panHandlers}
    >
      {/* Top Bar */}
      <View style={styles.topBar}>
        <View style={styles.topBarSpacer} />
        <TouchableOpacity
          activeOpacity={0.7}
          onPress={() => {
            Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
            onOpenSettings();
          }}
          style={styles.settingsBtn}
        >
          <Ionicons name="settings-outline" size={20} color="#e2e8f0" />
        </TouchableOpacity>
      </View>

      {/* Main Glass Artwork Card with Ambient Glow */}
      <View style={styles.artworkSection}>
        {/* Soft Ambient Glow Layer behind Artwork */}
        <View style={[styles.ambientGlow, { width: ARTWORK_SIZE * 0.85, height: ARTWORK_SIZE * 0.85 }]} />

        <View style={[styles.artworkCard, { width: ARTWORK_SIZE, height: ARTWORK_SIZE }]}>
          {currentTrack?.artworkUri ? (
            <Image source={{ uri: currentTrack.artworkUri }} style={styles.artworkImage} />
          ) : (
            <View style={styles.vinylPlaceholder}>
              <View style={styles.vinylGroove1}>
                <View style={styles.vinylGroove2}>
                  <View style={styles.vinylCenter}>
                    <Text style={styles.vinylLogo}>ty</Text>
                  </View>
                </View>
              </View>
            </View>
          )}

          {/* Real Audio Frequency Wave Mask */}
          {showWaveform && (
            <WaveformVisualizer player={player} isPlaying={isPlaying} barCount={30} />
          )}
        </View>

        {/* Waveform Toggle Button */}
        <TouchableOpacity
          activeOpacity={0.8}
          onPress={() => {
            Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
            setShowWaveform((prev) => !prev);
          }}
          style={[styles.waveBtn, showWaveform && styles.waveBtnActive]}
        >
          <Ionicons
            name="pulse"
            size={18}
            color={showWaveform ? '#c084fc' : 'rgba(255, 255, 255, 0.65)'}
          />
        </TouchableOpacity>
      </View>

      {/* Track Info (Artist is clickable for filtering) */}
      <View style={styles.trackInfoSection}>
        <Text style={styles.title} numberOfLines={1}>
          {currentTrack?.title || 'Выберите трек'}
        </Text>
        <TouchableOpacity
          activeOpacity={0.7}
          onPress={() => {
            if (currentTrack?.artist) {
              Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
              onArtistPress(currentTrack.artist);
            }
          }}
        >
          <Text style={styles.artist} numberOfLines={1}>
            {currentTrack?.artist || 'NEXTIME'}
          </Text>
        </TouchableOpacity>
      </View>

      {/* Scrubber Timeline */}
      <View style={styles.timelineSection}>
        <Slider
          style={styles.slider}
          minimumValue={0}
          maximumValue={duration > 0 ? duration : 1}
          value={displayTime}
          onValueChange={(val) => {
            setIsSeeking(true);
            setSeekValue(val);
            Haptics.selectionAsync();
          }}
          onSlidingComplete={(val) => {
            setIsSeeking(false);
            onSeek(val);
          }}
          minimumTrackTintColor="#ffffff"
          maximumTrackTintColor="rgba(255, 255, 255, 0.2)"
          thumbTintColor="#ffffff"
        />
        <View style={styles.timeLabels}>
          <Text style={styles.timeText}>{formatTime(displayTime)}</Text>
          <Text style={styles.timeText}>{formatTime(duration)}</Text>
        </View>
      </View>

      {/* Playback Controls */}
      <View style={styles.controlsRow}>
        <TouchableOpacity
          onPress={() => {
            Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
            setIsShuffle((prev) => !prev);
          }}
          style={styles.auxBtn}
        >
          <Ionicons
            name="shuffle"
            size={22}
            color={isShuffle ? '#c084fc' : '#94a3b8'}
          />
        </TouchableOpacity>

        <TouchableOpacity
          onPress={() => {
            Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
            onPrevious();
          }}
          style={styles.mainControlBtn}
        >
          <Ionicons name="play-skip-back" size={30} color="#f8fafc" />
        </TouchableOpacity>

        <TouchableOpacity
          activeOpacity={0.85}
          onPress={() => {
            Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
            onTogglePlayPause();
          }}
          style={styles.playPauseCircle}
        >
          <Ionicons
            name={isPlaying ? 'pause' : 'play'}
            size={28}
            color="#0e0717"
            style={{ marginLeft: isPlaying ? 0 : 3 }}
          />
        </TouchableOpacity>

        <TouchableOpacity
          onPress={() => {
            Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
            onNext();
          }}
          style={styles.mainControlBtn}
        >
          <Ionicons name="play-skip-forward" size={30} color="#f8fafc" />
        </TouchableOpacity>

        <TouchableOpacity
          onPress={() => {
            Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
            setIsRepeat((prev) => !prev);
          }}
          style={styles.auxBtn}
        >
          <Ionicons
            name="repeat"
            size={22}
            color={isRepeat ? '#c084fc' : '#94a3b8'}
          />
        </TouchableOpacity>
      </View>

      {/* Volume Slider Row */}
      <View style={styles.volumeRow}>
        <Ionicons name="volume-low" size={18} color="#94a3b8" style={{ marginHorizontal: 6 }} />
        <Slider
          style={styles.volumeSlider}
          minimumValue={0}
          maximumValue={1}
          value={volume}
          onValueChange={onVolumeChange}
          minimumTrackTintColor="#ffffff"
          maximumTrackTintColor="rgba(255, 255, 255, 0.2)"
          thumbTintColor="#ffffff"
        />
        <Ionicons name="volume-high" size={18} color="#94a3b8" style={{ marginHorizontal: 6 }} />
      </View>

      {/* Bottom Interactive Rotary Swipe Switcher */}
      <SwipeSwitcher
        onOpenQueue={onOpenQueue}
        onOpenLyrics={onOpenLyrics}
      />
    </LinearGradient>
  );
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
    paddingHorizontal: 24,
    paddingTop: 8,
    justifyContent: 'space-between',
    paddingBottom: 22,
  },
  topBar: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    alignItems: 'center',
    height: 42,
  },
  topBarSpacer: {
    flex: 1,
  },
  settingsBtn: {
    width: 38,
    height: 38,
    borderRadius: 19,
    backgroundColor: 'rgba(255, 255, 255, 0.08)',
    justifyContent: 'center',
    alignItems: 'center',
  },

  /* Artwork with Ambient Glow */
  artworkSection: {
    alignItems: 'center',
    marginVertical: 4,
    position: 'relative',
  },
  ambientGlow: {
    position: 'absolute',
    top: 15,
    borderRadius: 999,
    backgroundColor: 'rgba(168, 85, 247, 0.35)',
    shadowColor: '#a855f7',
    shadowOffset: { width: 0, height: 18 },
    shadowOpacity: 0.85,
    shadowRadius: 36,
  },
  artworkCard: {
    borderRadius: 26,
    backgroundColor: 'rgba(255, 255, 255, 0.04)',
    borderWidth: 1.2,
    borderColor: 'rgba(255, 255, 255, 0.14)',
    overflow: 'hidden',
    shadowColor: '#000000',
    shadowOffset: { width: 0, height: 14 },
    shadowOpacity: 0.5,
    shadowRadius: 20,
    elevation: 12,
  },
  artworkImage: {
    width: '100%',
    height: '100%',
    borderRadius: 24,
  },
  vinylPlaceholder: {
    flex: 1,
    backgroundColor: '#110a1b',
    justifyContent: 'center',
    alignItems: 'center',
  },
  vinylGroove1: {
    width: '84%',
    height: '84%',
    borderRadius: 999,
    borderWidth: 2,
    borderColor: 'rgba(192, 132, 252, 0.15)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  vinylGroove2: {
    width: '65%',
    height: '65%',
    borderRadius: 999,
    borderWidth: 2,
    borderColor: 'rgba(192, 132, 252, 0.25)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  vinylCenter: {
    width: 60,
    height: 60,
    borderRadius: 30,
    backgroundColor: '#7e22ce',
    justifyContent: 'center',
    alignItems: 'center',
    borderWidth: 2,
    borderColor: '#d8b4fe',
  },
  vinylLogo: {
    color: '#ffffff',
    fontWeight: '800',
    fontSize: 16,
  },
  waveBtn: {
    marginTop: 14,
    paddingHorizontal: 16,
    paddingVertical: 6,
    borderRadius: 999,
    backgroundColor: 'rgba(255, 255, 255, 0.06)',
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.12)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  waveBtnActive: {
    backgroundColor: 'rgba(168, 85, 247, 0.35)',
    borderColor: '#c084fc',
  },

  /* Track Info */
  trackInfoSection: {
    alignItems: 'center',
    marginVertical: 4,
  },
  title: {
    fontSize: 26,
    fontWeight: '800',
    color: '#ffffff',
    letterSpacing: -0.4,
    textAlign: 'center',
  },
  artist: {
    fontSize: 16,
    fontWeight: '500',
    color: '#a78bfa',
    marginTop: 6,
    textAlign: 'center',
  },

  /* Scrubber */
  timelineSection: {
    marginVertical: 4,
  },
  slider: {
    width: '100%',
    height: 32,
  },
  timeLabels: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingHorizontal: 4,
    marginTop: -4,
  },
  timeText: {
    fontSize: 12,
    color: '#94a3b8',
    fontVariant: ['tabular-nums'],
  },

  /* Controls */
  controlsRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 8,
    marginVertical: 4,
  },
  auxBtn: {
    padding: 10,
  },
  mainControlBtn: {
    padding: 10,
  },
  playPauseCircle: {
    width: 68,
    height: 68,
    borderRadius: 34,
    backgroundColor: '#ffffff',
    justifyContent: 'center',
    alignItems: 'center',
    shadowColor: '#ffffff',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.3,
    shadowRadius: 12,
  },

  /* Volume */
  volumeRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 6,
    marginVertical: 4,
  },
  volumeSlider: {
    flex: 1,
    height: 24,
  },
});
