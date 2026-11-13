import * as FileSystem from 'expo-file-system/legacy';
import { DJSettings, RepeatMode } from '../types';

/**
 * Небольшое JSON-хранилище в Documents/.woufy/state.json
 * (скрытая папка: Files её не показывает, сканер её пропускает).
 */
/** Сетка битов трека: биты стоят в моменты phase + k·60/bpm (секунды от начала файла) */
export interface BeatGridRecord {
  bpm: number;
  phase: number;
}

export interface BpmRecord {
  value: number;
  source: 'auto' | 'manual';
  /** точная сетка битов (для наложения битов друг на друга при DJ-склейке) */
  grid?: BeatGridRecord;
}

export interface PersistedState {
  dj?: DJSettings;
  bpm?: Record<string, BpmRecord>;
  order?: string[];
  shuffle?: boolean;
  repeat?: RepeatMode;
  volume?: number;
  lastTrackId?: string;
  samplesSeeded?: boolean;
}

const DIR = `${FileSystem.documentDirectory ?? ''}.woufy/`;
const FILE = `${DIR}state.json`;

let cache: PersistedState = {};
let loaded = false;
let writeTimer: ReturnType<typeof setTimeout> | null = null;

export async function loadState(): Promise<PersistedState> {
  if (loaded) return cache;
  try {
    const info = await FileSystem.getInfoAsync(FILE);
    if (info.exists) {
      const raw = await FileSystem.readAsStringAsync(FILE);
      cache = JSON.parse(raw) as PersistedState;
    }
  } catch (e) {
    console.warn('[library] state load failed', e);
    cache = {};
  }
  loaded = true;
  return cache;
}

export function getState(): PersistedState {
  return cache;
}

export function patchState(patch: Partial<PersistedState>) {
  cache = { ...cache, ...patch };
  if (writeTimer) clearTimeout(writeTimer);
  writeTimer = setTimeout(flushState, 600);
}

export async function flushState() {
  if (writeTimer) {
    clearTimeout(writeTimer);
    writeTimer = null;
  }
  try {
    const info = await FileSystem.getInfoAsync(DIR);
    if (!info.exists) await FileSystem.makeDirectoryAsync(DIR, { intermediates: true });
    await FileSystem.writeAsStringAsync(FILE, JSON.stringify(cache));
  } catch (e) {
    console.warn('[library] state save failed', e);
  }
}
