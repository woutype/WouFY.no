import { NativeModules } from 'react-native';

type Listener = (volume: number) => void;
const listeners = new Set<Listener>();

let currentVolume = 0.8;
let nativeListenerActive = false;
let removeNativeListener: (() => void) | null = null;

interface NativeVolumeManagerModule {
  addVolumeListener: (cb: (res: { volume: number }) => void) => { remove: () => void } | (() => void);
  getVolume: () => Promise<number | { volume: number }>;
  setVolume: (val: number, options?: { showUI?: boolean }) => Promise<void>;
}

function getNativeVolumeManager(): NativeVolumeManagerModule | null {
  try {
    // В Expo Go нативный модуль отсутствует (NativeModules.VolumeManager == null).
    // Если вызвать require('react-native-volume-manager') без наличия нативного модуля,
    // библиотека выбросит исключение при инициализации. Поэтому проверяем заранее:
    if (typeof NativeModules !== 'undefined' && NativeModules?.VolumeManager) {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const mod = require('react-native-volume-manager');
      return (mod?.VolumeManager ?? mod?.default?.VolumeManager ?? mod?.default ?? null) as NativeVolumeManagerModule;
    }
  } catch {
    // Expo Go или среда без слинкованного модуля
  }
  return null;
}

function setupNativeListener() {
  if (nativeListenerActive) return;
  const VM = getNativeVolumeManager();
  if (!VM) return;

  try {
    const sub = VM.addVolumeListener((result: { volume: number }) => {
      if (typeof result?.volume === 'number') {
        currentVolume = Math.max(0, Math.min(1, result.volume));
        listeners.forEach((fn) => fn(currentVolume));
      }
    });
    removeNativeListener = () => {
      try {
        if (sub && typeof (sub as any).remove === 'function') (sub as any).remove();
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
  /** Доступен ли нативный менеджер системной громкости телефона (true в dev build / standalone, false в Expo Go) */
  isAvailable(): boolean {
    return Boolean(getNativeVolumeManager());
  },

  /** Получить реальный текущий уровень громкости устройства (0.0 .. 1.0) */
  async getVolume(): Promise<number> {
    const VM = getNativeVolumeManager();
    if (VM) {
      try {
        const res = await VM.getVolume();
        const v = typeof res === 'number' ? res : res?.volume;
        if (typeof v === 'number') {
          currentVolume = Math.max(0, Math.min(1, v));
          return currentVolume;
        }
      } catch (e) {
        console.warn('[volumeService] getVolume failed:', e);
      }
    }
    return currentVolume;
  },

  /** Установить системную громкость телефона (кнопки и слайдер iPhone), либо внутреннюю в Expo Go */
  async setVolume(volume: number) {
    const v = Math.max(0, Math.min(1, volume));
    currentVolume = v;
    listeners.forEach((fn) => fn(v));

    const VM = getNativeVolumeManager();
    if (VM) {
      try {
        await VM.setVolume(v, { showUI: false });
      } catch (e) {
        console.warn('[volumeService] setVolume failed:', e);
      }
    }
  },

  addListener(fn: Listener): () => void {
    listeners.add(fn);
    setupNativeListener();
    fn(currentVolume);

    if (this.isAvailable()) {
      this.getVolume().then((v) => {
        fn(v);
      });
    }

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
