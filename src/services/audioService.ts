import { setAudioModeAsync } from 'expo-audio';

let isAudioConfigured = false;

/**
 * Configures the iOS audio session for background playback and silent mode overriding.
 */
export async function configureAudioSession(): Promise<void> {
  if (isAudioConfigured) return;

  try {
    await setAudioModeAsync({
      playsInSilentMode: true,
      interruptionMode: 'doNotMixPersistent',
      shouldPlayInBackground: true,
      allowsRecording: false,
    });
    isAudioConfigured = true;
  } catch (error) {
    console.warn('[audioService] Failed to setAudioModeAsync:', error);
  }
}
