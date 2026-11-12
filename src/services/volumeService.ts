import { VolumeManager } from 'react-native-volume-manager';

let currentVolume = 0.8;
type Listener = (volume: number) => void;
const listeners = new Set<Listener>();

let nativeListenerActive = false;
let removeNativeListener: (() => void) | null = null;

function setupNativeListener() {
  if (nativeListenerActive) return;
  try {
    const sub = VolumeManager.addVolumeListener((result: { volume: number }) => {
      if (typeof result?.volume === 'number') {
        currentVolume = Math.max(0, Math.min(1, result.volume));
        listeners.forEach((fn) => fn(currentVolume));
      }
    });
    removeNativeListener = () => {
      try {
        if (typeof sub?.remove === 'function') sub.remove();
        else if (typeof sub === 'function') (sub as () => void)();
      } catch {
        /* ignore */
      }
    };
    nativeListenerActive = true;
  } catch (e) {
    console.warn('[volumeService] native listener setup failed:', e);
  }
}

export const volumeService = {
  /** Получить реальный текущий уровень громкости устройства (0.0 .. 1.0) */
  async getVolume(): Promise<number> {
    try {
      const res = await VolumeManager.getVolume();
      const v = typeof res === 'number' ? res : res?.volume;
      if (typeof v === 'number') {
        currentVolume = Math.max(0, Math.min(1, v));
        return currentVolume;
      }
    } catch (e) {
      console.warn('[volumeService] getVolume failed:', e);
    }
    return currentVolume;
  },

  /** Установить системную громкость телефона (кнопки и слайдер iPhone) */
  async setVolume(volume: number) {
    const v = Math.max(0, Math.min(1, volume));
    currentVolume = v;
    listeners.forEach((fn) => fn(v));

    try {
      await VolumeManager.setVolume(v, { showUI: false });
    } catch (e) {
      console.warn('[volumeService] setVolume failed:', e);
    }
  },

  addListener(fn: Listener): () => void {
    listeners.add(fn);
    setupNativeListener();
    fn(currentVolume);

    // Сразу опрашиваем физический уровень громкости телефона
    this.getVolume().then((v) => {
      fn(v);
    });

    return () => {
      listeners.delete(fn);
      if (listeners.size === 0 && removeNativeListener) {
        removeNativeListener();
        removeNativeListener = null;
        nativeListenerActive = false;
      }
    };
  },
};
