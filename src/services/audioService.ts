import { setAudioModeAsync } from 'expo-audio';

let lastConfiguredAt = 0;
let inflight: Promise<void> | null = null;

/**
 * Аудио-сессия iOS: фоновое воспроизведение, звук при выключенном «беззвучном» режиме.
 *
 * ВАЖНО: interruptionMode = 'doNotMix'. Режим 'mixWithOthers' делает приложение «фоновым гостем»:
 * iOS не показывает для него плашку Now Playing на экране блокировки, в Dynamic Island и в Центре управления,
 * а при некоторых маршрутах звук вообще не стартует. 'doNotMix' — поведение обычного музыкального плеера.
 */
export function configureAudioSession(force = false): Promise<void> {
  const now = Date.now();
  if (!force && now - lastConfiguredAt < 1000) return inflight ?? Promise.resolve();
  inflight = (async () => {
    try {
      await setAudioModeAsync({
        playsInSilentMode: true,
        interruptionMode: 'doNotMix',
        shouldPlayInBackground: true,
        allowsRecording: false,
        shouldRouteThroughEarpiece: false,
      });
      lastConfiguredAt = Date.now();
    } catch (error) {
      console.warn('[audioService] Failed to setAudioModeAsync:', error);
    }
  })();
  return inflight;
}
