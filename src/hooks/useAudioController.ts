import { useEffect, useState, useSyncExternalStore } from 'react';
import { AudioEngine } from '../services/audioEngine';

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
export function usePosition(engine: AudioEngine, intervalMs = 100): number {
  const [pos, setPos] = useState(() => engine.getPosition());
  useEffect(() => {
    const id = setInterval(() => setPos(engine.getPosition()), intervalMs);
    return () => clearInterval(id);
  }, [engine, intervalMs]);
  return pos;
}
