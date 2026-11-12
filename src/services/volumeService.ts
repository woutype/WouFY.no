let VolumeManager: any = null;
try {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const vm = require('react-native-volume-manager');
  VolumeManager = vm?.VolumeManager ?? vm?.default ?? vm;
} catch {
  VolumeManager = null;
}

let currentVolume = 0.8;
type Listener = (volume: number) => void;
const listeners = new Set<Listener>();

let nativeListenerActive = false;
let removeNativeListener: (() => void) | null = null;

function setupNativeListener() {
  if (nativeListenerActive || !VolumeManager?.addVolumeListener) return;
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
  } catch {
    /* native volume listener not supported in current environment */
  }
}

export const volumeService = {
  async getVolume(): Promise<number> {
    if (VolumeManager?.getVolume) {
      try {
        const res = await VolumeManager.getVolume();
        const v = typeof res === 'number' ? res : res?.volume;
        if (typeof v === 'number') {
          currentVolume = Math.max(0, Math.min(1, v));
          return currentVolume;
        }
      } catch {
        /* ignore */
      }
    }
    return currentVolume;
  },

  async setVolume(volume: number) {
    const v = Math.max(0, Math.min(1, volume));
    currentVolume = v;
    listeners.forEach((fn) => fn(v));

    if (VolumeManager?.setVolume) {
      try {
        await VolumeManager.setVolume(v);
      } catch {
        /* ignore */
      }
    }
  },

  addListener(fn: Listener): () => void {
    listeners.add(fn);
    setupNativeListener();
    // немедленно сообщаем текущий уровень
    fn(currentVolume);

    // синхронизируем с реальным системным уровнем
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
