import { setAudioModeAsync } from 'expo-audio';

let lastConfiguredAt = 0;

/** Фоновое воспроизведение и работа при выключенном беззвучном режиме (iOS Mute switch) */
export async function configureAudioSession(force = false): Promise<void> {
  const now = Date.now();
  if (!force && now - lastConfiguredAt < 1000) return;
  try {
    await setAudioModeAsync({
      playsInSilentMode: true,
      interruptionMode: 'mixWithOthers',
      shouldPlayInBackground: true,
      allowsRecording: false,
    });
    lastConfiguredAt = now;
  } catch (error) {
    console.warn('[audioService] Failed to setAudioModeAsync:', error);
  }
}
