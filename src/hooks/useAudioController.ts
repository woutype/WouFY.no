import { useEffect, useState, useSyncExternalStore } from 'react';
import { AudioEngine } from '../services/audioEngine';
import { useAppActive } from '../services/appActive';

/** Один движок на всё приложение */
export function useAudioEngine(): AudioEngine {
  const [engine] = useState(() => new AudioEngine());
  useEffect(() => () => engine.dispose(), [engine]);
  return engine;
}

export function useEngineState(engine: AudioEngine) {
  return useSyncExternalStore(engine.subscribe, engine.getState, engine.getState);
}

/**
 * Позиция воспроизведения, читаемая напрямую у плеера с заданным шагом.
 * Изолирована в отдельный хук, чтобы по 10 раз в секунду перерисовывался
 * только компонент, которому позиция действительно нужна.
 */
export function usePosition(engine: AudioEngine, intervalMs = 100, enabled = true): number {
  const [pos, setPos] = useState(() => engine.getPosition());
  const appActive = useAppActive();
  useEffect(() => {
    if (!enabled || !appActive) return;
    setPos(engine.getPosition());
    const id = setInterval(() => {
      const p = engine.getPosition();
      // перерисовка только при заметном изменении (раньше — 10 раз в секунду безусловно)
      setPos((prev) => (Math.abs(prev - p) < 0.04 ? prev : p));
    }, intervalMs);
    return () => clearInterval(id);
  }, [engine, intervalMs, enabled, appActive]);
  return pos;
}
