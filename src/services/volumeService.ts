
/**
 * Синхронизация с системной громкостью телефона (кнопки, Центр управления).
 *
 * Раньше модуль искали как NativeModules.VolumeManager, а библиотека регистрируется под другим именем —
 * поэтому нативный менеджер «не находился» и слайдер не двигался от кнопок. Теперь модуль
 * подключается через сам пакет, а его работоспособность проверяется пробным вызовом.
 */

import { NativeModules } from 'react-native';
import { configureAudioSession } from './audioService';

type Listener = (volume: number) => void;
const listeners = new Set<Listener>();

let currentVolume = 0.8;
let removeNativeListener: (() => void) | null = null;
let nativeListenerActive = false;

interface NativeVolumeManager {
  addVolumeListener: (cb: (res: { volume: number }) => void) => { remove?: () => void } | (() => void);
  getVolume: () => Promise<number | { volume: number }>;
  setVolume: (val: number, options?: { showUI?: boolean }) => Promise<void>;
  enable?: (enabled: boolean, async?: boolean) => Promise<void> | void;
  enableInSilenceMode?: (enabled?: boolean) => Promise<void> | void;
  setCategory?: (value: string, mixWithOthers?: boolean) => Promise<void> | void;
}

let vm: NativeVolumeManager | null | undefined; // undefined — ещё не искали
let broken = false; // пробный вызов не удался (например Expo Go без нативного модуля)

function getVM(): NativeVolumeManager | null {
  if (broken) return null;
  if (vm !== undefined) return vm;
  vm = null;

  // Критично: проверяем наличие нативного модуля ДО require('react-native-volume-manager').
  // Иначе библиотека на верхнем уровне создаёт new NativeEventEmitter(Proxy) и моментально
  // крашит приложение с фатальным экраном ошибки (RedBox / LINKING_ERROR) в Expo Go!
  if (!NativeModules?.VolumeManager) {
    broken = true;
    return null;
  }

  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const mod = require('react-native-volume-manager');
    const cand = (mod?.VolumeManager ?? mod?.default?.VolumeManager ?? mod?.default ?? null) as NativeVolumeManager | null;
    if (cand && typeof cand.getVolume === 'function' && typeof cand.addVolumeListener === 'function') vm = cand;
  } catch {
    vm = null; // Expo Go или среда без слинкованного модуля
    broken = true;
  }
  if (vm) {
    // пробный вызов: если нативной части нет — библиотека бросит ошибку, и мы переходим на внутренний режим
    try {
      Promise.resolve(vm.getVolume()).then(
        (res) => {
          const v = typeof res === 'number' ? res : res?.volume;
          if (typeof v === 'number') {
            currentVolume = clamp(v);
            listeners.forEach((fn) => fn(currentVolume));
          }
        },
        () => markBroken()
      );
      try {
        // Устанавливаем режим Playback (чтобы звук играл при аппаратном беззвучном переключателе)
        Promise.resolve(vm.enableInSilenceMode?.(true)).catch(() => {});
        // категорию сессии задаёт только audioService (doNotMix) — иначе пропадает экран блокировки/Dynamic Island
        configureAudioSession(true);
      } catch {
        /* необязательно */
      }
    } catch {
      markBroken();
    }
  }
  return vm;
}

function markBroken() {
  broken = true;
  vm = null;
  if (removeNativeListener) {
    removeNativeListener();
    removeNativeListener = null;
  }
  nativeListenerActive = false;
}

const clamp = (v: number) => Math.max(0, Math.min(1, v));

function setupNativeListener() {
  if (nativeListenerActive) return;
  const VM = getVM();
  if (!VM) return;
  try {
    const sub = VM.addVolumeListener((result: { volume: number }) => {
      if (typeof result?.volume === 'number') {
        currentVolume = clamp(result.volume);
        listeners.forEach((fn) => fn(currentVolume));
      }
    });
    // addVolumeListener в нативном коде iOS переопределяет категорию на Ambient;
    // сразу возвращаем категорию Playback и активную сессию
    Promise.resolve(VM.enableInSilenceMode?.(true)).catch(() => {});
    // addVolumeListener на iOS переключает категорию на Ambient — возвращаем «Playback / doNotMix».
    // Делаем это дважды (сразу и чуть позже), чтобы гарантированно перебить нативный вызов библиотеки.
    configureAudioSession(true);
    setTimeout(() => configureAudioSession(true), 400);

    removeNativeListener = () => {
      try {
        if (typeof sub === 'function') sub();
        else sub?.remove?.();
      } catch {
        /* ignore */
      }
    };
    nativeListenerActive = true;
  } catch (e) {
    console.warn('[volumeService] native listener setup failed:', e);
    markBroken();
  }
}

// ── троттлинг записи в системную громкость: не чаще ~25 раз в секунду, последнее значение всегда доходит ──
let pending: number | null = null;
let sendTimer: ReturnType<typeof setTimeout> | null = null;
let lastSent = 0;
const SEND_EVERY_MS = 40;

function flushToNative() {
  sendTimer = null;
  if (pending === null) return;
  const v = pending;
  pending = null;
  lastSent = Date.now();
  const VM = getVM();
  if (!VM) return;
  try {
    Promise.resolve(VM.setVolume(v, { showUI: false })).catch((e) => console.warn('[volumeService] setVolume failed:', e));
  } catch (e) {
    console.warn('[volumeService] setVolume threw:', e);
  }
}

export const volumeService = {
  /** Доступен ли нативный менеджер системной громкости (true в dev-билде / standalone, false в Expo Go) */
  isAvailable(): boolean {
    return Boolean(getVM());
  },

  /** Реальный текущий уровень громкости устройства (0…1) */
  async getVolume(): Promise<number> {
    const VM = getVM();
    if (VM) {
      try {
        const res = await VM.getVolume();
        const v = typeof res === 'number' ? res : res?.volume;
        if (typeof v === 'number') currentVolume = clamp(v);
      } catch (e) {
        console.warn('[volumeService] getVolume failed:', e);
        markBroken();
      }
    }
    return currentVolume;
  },

  /** Установить системную громкость (кнопки и слайдер iPhone) либо внутреннюю в Expo Go */
  setVolume(volume: number) {
    const v = clamp(volume);
    currentVolume = v;
    listeners.forEach((fn) => fn(v));
    if (!getVM()) return;
    pending = v;
    const since = Date.now() - lastSent;
    if (since >= SEND_EVERY_MS && !sendTimer) flushToNative();
    else if (!sendTimer) sendTimer = setTimeout(flushToNative, Math.max(0, SEND_EVERY_MS - since));
  },

  addListener(fn: Listener): () => void {
    listeners.add(fn);
    setupNativeListener();
    fn(currentVolume);
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

