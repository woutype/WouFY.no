import { useEffect, useState, useCallback, useRef } from 'react';
import { useAudioPlayer, useAudioPlayerStatus } from 'expo-audio';
import { TrackFile } from '../services/fileScanner';
import { configureAudioSession } from '../services/audioService';

export function useAudioController(tracks: TrackFile[]) {
  const [currentIndex, setCurrentIndex] = useState<number | null>(null);
  const tracksRef = useRef(tracks);
  tracksRef.current = tracks;

  const currentTrack = currentIndex !== null ? tracks[currentIndex] : null;

  // Managed player instance from expo-audio
  const player = useAudioPlayer(null, { updateInterval: 250 });
  const status = useAudioPlayerStatus(player);

  // 1. Initialize iOS background audio mode
  useEffect(() => {
    configureAudioSession();
    try {
      player.setAudioSamplingEnabled(true);
    } catch (e) {
      // Audio sampling may not be supported on all runtimes
    }
  }, [player]);

  const updateLockScreen = useCallback(
    (target: TrackFile) => {
      try {
        player.setActiveForLockScreen(
          true,
          {
            title: target.title,
            artist: target.artist || 'NEXTIME',
            albumTitle: target.album || 'woufy',
            artworkUrl: target.artworkFileUri || target.artworkUri,
          },
          {
            showNextTrack: true,
            showPreviousTrack: true,
            showSeekForward: false, // Disables +10s on iOS Lock Screen
            showSeekBackward: false, // Disables -10s on iOS Lock Screen
            isLiveStream: false,
          }
        );
      } catch (e) {
        console.warn('[useAudioController] LockScreen update failed:', e);
      }
    },
    [player]
  );

  // 2. Play a specific track by index
  const playTrack = useCallback(
    (index: number) => {
      const list = tracksRef.current;
      if (index < 0 || index >= list.length) return;
      const target = list[index];
      setCurrentIndex(index);

      player.replace({ uri: target.uri });
      player.play();
      updateLockScreen(target);
    },
    [player, updateLockScreen]
  );

  // 3. Play next track (for continuous playback and user control)
  const playNext = useCallback(() => {
    const list = tracksRef.current;
    if (list.length === 0) return;
    setCurrentIndex((prev) => {
      const nextIndex = prev !== null ? (prev + 1) % list.length : 0;
      const target = list[nextIndex];
      player.replace({ uri: target.uri });
      player.play();
      updateLockScreen(target);
      return nextIndex;
    });
  }, [player, updateLockScreen]);

  // 4. Play previous track: if > 1.5s into song, restart from 0, else switch track
  const playPrevious = useCallback(() => {
    const list = tracksRef.current;
    if (list.length === 0) return;

    if (status.currentTime > 1.5) {
      player.seekTo(0);
      player.play();
      return;
    }

    setCurrentIndex((prev) => {
      const prevIndex = prev !== null ? (prev - 1 + list.length) % list.length : 0;
      const target = list[prevIndex];
      player.replace({ uri: target.uri });
      player.play();
      updateLockScreen(target);
      return prevIndex;
    });
  }, [player, status.currentTime, updateLockScreen]);

  // 5. Toggle Play / Pause
  const togglePlayPause = useCallback(() => {
    const list = tracksRef.current;
    if (currentIndex === null && list.length > 0) {
      playTrack(0);
      return;
    }
    if (status.playing) {
      player.pause();
    } else {
      player.play();
    }
  }, [currentIndex, status.playing, player, playTrack]);

  // 6. Continuous playback: Auto-advance when track finishes
  useEffect(() => {
    if (status.didJustFinish) {
      playNext();
    }
  }, [status.didJustFinish, playNext]);

  // 7. Seek position in seconds
  const seek = useCallback(
    (seconds: number) => {
      player.seekTo(seconds);
    },
    [player]
  );

  // 8. Volume control
  const [volume, setVolumeState] = useState(1.0);
  const setVolume = useCallback(
    (val: number) => {
      setVolumeState(val);
      try {
        player.volume = val;
      } catch (e) {
        console.warn('[useAudioController] Failed to set volume:', e);
      }
    },
    [player]
  );

  return {
    player,
    currentTrack,
    currentIndex,
    status,
    isPlaying: status.playing,
    currentTime: status.currentTime,
    duration: status.duration,
    volume,
    setVolume,
    playTrack,
    togglePlayPause,
    playNext,
    playPrevious,
    seek,
  };
}
