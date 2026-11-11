import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
  StyleSheet,
  View,
  SafeAreaView,
  ActivityIndicator,
  Text,
  Animated,
  Dimensions,
} from 'react-native';
import { StatusBar } from 'expo-status-bar';
import * as Haptics from 'expo-haptics';
import { scanAudioFiles, TrackFile } from './src/services/fileScanner';
import { useAudioController } from './src/hooks/useAudioController';
import { PlayerView } from './src/components/PlayerView';
import { QueueView } from './src/components/QueueView';
import { LyricsView } from './src/components/LyricsView';
import { SettingsModal, DJSettings } from './src/components/SettingsModal';

const { height: SCREEN_HEIGHT } = Dimensions.get('window');

export default function App() {
  const [tracks, setTracks] = useState<TrackFile[]>([]);
  const [loading, setLoading] = useState(true);

  // Active view: 'player' | 'queue' | 'lyrics'
  const [activeSheet, setActiveSheet] = useState<'none' | 'queue' | 'lyrics'>('none');
  const [searchQuery, setSearchQuery] = useState('');
  const [showSettings, setShowSettings] = useState(false);

  // DJ Mix / Crossfade settings
  const [djSettings, setDjSettings] = useState<DJSettings>({
    crossfadeEnabled: false,
    crossfadeDuration: 5,
    bpmTransitionEnabled: false,
    fadeVolumeEnabled: true,
  });

  const {
    player,
    currentTrack,
    currentIndex,
    isPlaying,
    currentTime,
    duration,
    volume,
    setVolume,
    playTrack,
    togglePlayPause,
    playNext,
    playPrevious,
    seek,
  } = useAudioController(tracks);

  // Smooth in-tree Sheet Slide Animation (0 = closed, 1 = open)
  const sheetAnim = useRef(new Animated.Value(0)).current;

  const openSheet = useCallback(
    (sheet: 'queue' | 'lyrics') => {
      setActiveSheet(sheet);
      Animated.spring(sheetAnim, {
        toValue: 1,
        friction: 8,
        tension: 65,
        useNativeDriver: true,
      }).start();
    },
    [sheetAnim]
  );

  const closeSheet = useCallback(() => {
    Animated.timing(sheetAnim, {
      toValue: 0,
      duration: 220,
      useNativeDriver: true,
    }).start(() => {
      setActiveSheet('none');
    });
  }, [sheetAnim]);

  // Load local tracks
  const loadTracks = useCallback(async () => {
    setLoading(true);
    try {
      const found = await scanAudioFiles();
      setTracks(found);
    } catch (e) {
      console.error('Scan error:', e);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadTracks();
  }, [loadTracks]);

  // DJ Crossfade Engine: Volume fading & tempo adaptation
  useEffect(() => {
    if (!djSettings.crossfadeEnabled || !isPlaying || duration <= 0) return;

    const remaining = duration - currentTime;
    if (remaining <= djSettings.crossfadeDuration && remaining > 0) {
      if (djSettings.fadeVolumeEnabled) {
        // Linear fade out towards track end
        const fadeRatio = Math.max(0.1, remaining / djSettings.crossfadeDuration);
        setVolume(fadeRatio);
      }
      if (djSettings.bpmTransitionEnabled && player) {
        // Smooth tempo blend
        try {
          player.playbackRate = 1.04;
        } catch (e) {}
      }
    } else if (remaining > djSettings.crossfadeDuration) {
      // Restore normal volume & rate
      if (volume < 1.0) setVolume(1.0);
      if (player && player.playbackRate !== 1.0) {
        try {
          player.playbackRate = 1.0;
        } catch (e) {}
      }
    }
  }, [currentTime, duration, djSettings, isPlaying, player, setVolume, volume]);

  // Point 7: Filter queue by artist
  const handleArtistPress = useCallback(
    (artist: string) => {
      setSearchQuery(artist);
      openSheet('queue');
    },
    [openSheet]
  );

  if (loading) {
    return (
      <SafeAreaView style={styles.loadingContainer}>
        <StatusBar style="light" />
        <ActivityIndicator size="large" color="#c084fc" />
        <Text style={styles.loadingText}>Загрузка woufy...</Text>
      </SafeAreaView>
    );
  }

  // Calculate slide translation for the sheet
  const sheetTranslateY = sheetAnim.interpolate({
    inputRange: [0, 1],
    outputRange: [SCREEN_HEIGHT, 0],
  });

  // Smooth card stack transformation: player scales down & dims when sheet is open
  const playerScale = sheetAnim.interpolate({
    inputRange: [0, 1],
    outputRange: [1, 0.94],
  });
  const playerOpacity = sheetAnim.interpolate({
    inputRange: [0, 1],
    outputRange: [1, 0.55],
  });

  return (
    <SafeAreaView style={styles.safeArea}>
      <StatusBar style="light" />
      <View style={styles.container}>
        {/* Main Persistent Player with Card Stack Animation */}
        <Animated.View
          style={[
            styles.playerWrapper,
            {
              transform: [{ scale: playerScale }],
              opacity: playerOpacity,
            },
          ]}
        >
          <PlayerView
            player={player}
            currentTrack={currentTrack}
            isPlaying={isPlaying}
            currentTime={currentTime}
            duration={duration}
            volume={volume}
            onVolumeChange={setVolume}
            onTogglePlayPause={togglePlayPause}
            onNext={playNext}
            onPrevious={playPrevious}
            onSeek={seek}
            onOpenQueue={() => openSheet('queue')}
            onOpenLyrics={() => openSheet('lyrics')}
            onOpenSettings={() => setShowSettings(true)}
            onArtistPress={handleArtistPress}
          />
        </Animated.View>

        {/* Smooth 1:1 In-Tree Sliding Sheet for Queue or Lyrics (No modal fighting) */}
        {activeSheet !== 'none' && (
          <Animated.View
            style={[
              styles.sheetOverlay,
              {
                transform: [{ translateY: sheetTranslateY }],
              },
            ]}
          >
            {activeSheet === 'queue' && (
              <QueueView
                tracks={tracks}
                currentTrack={currentTrack}
                currentIndex={currentIndex}
                searchQuery={searchQuery}
                onSearchChange={setSearchQuery}
                isPlaying={isPlaying}
                currentTime={currentTime}
                duration={duration}
                onSelectTrack={(idx) => {
                  playTrack(idx);
                }}
                onTogglePlayPause={togglePlayPause}
                onNext={playNext}
                onPrevious={playPrevious}
                onClose={closeSheet}
              />
            )}

            {activeSheet === 'lyrics' && (
              <LyricsView
                currentTrack={currentTrack}
                isPlaying={isPlaying}
                currentTime={currentTime}
                duration={duration}
                onTogglePlayPause={togglePlayPause}
                onNext={playNext}
                onPrevious={playPrevious}
                onSeek={seek}
                onClose={closeSheet}
              />
            )}
          </Animated.View>
        )}

        {/* DJ Mix / Crossfade Settings Modal */}
        <SettingsModal
          visible={showSettings}
          settings={djSettings}
          onUpdateSettings={setDjSettings}
          onClose={() => setShowSettings(false)}
        />
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: '#0a0612',
  },
  container: {
    flex: 1,
    backgroundColor: '#0a0612',
  },
  playerWrapper: {
    flex: 1,
  },
  loadingContainer: {
    flex: 1,
    backgroundColor: '#0a0612',
    justifyContent: 'center',
    alignItems: 'center',
  },
  loadingText: {
    color: '#c084fc',
    marginTop: 14,
    fontSize: 15,
    fontWeight: '600',
  },
  sheetOverlay: {
    ...StyleSheet.absoluteFill,
    backgroundColor: '#0e0717',
    zIndex: 50,
  },
});
