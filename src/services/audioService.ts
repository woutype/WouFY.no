import { setAudioModeAsync } from 'expo-audio';

let isAudioConfigured = false;

/** Фоновое воспроизведение и работа при выключенном беззвучном режиме */
export async function configureAudioSession(): Promise<void> {
  if (isAudioConfigured) return;
  try {
    await setAudioModeAsync({
      playsInSilentMode: true,
      interruptionMode: 'doNotMix',
      shouldPlayInBackground: true,
      allowsRecording: false,
    });
    isAudioConfigured = true;
  } catch (error) {
    console.warn('[audioService] Failed to setAudioModeAsync:', error);
  }
}
