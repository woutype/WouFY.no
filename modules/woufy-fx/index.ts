import { requireOptionalNativeModule } from 'expo';

/** Нативный модуль эффектов (реверберация, 8D, темп/тон на AVAudioEngine). null — если модуль не собран (Expo Go, Android). */
export interface WoufyFXNative {
  isAvailable(): boolean;
  create(id: string): void;
  destroy(id: string): void;
  load(id: string, uri: string): Promise<number>;
  play(id: string): Promise<void>;
  pause(id: string): Promise<void>;
  seek(id: string, seconds: number): Promise<void>;
  getTime(id: string): number;
  getDuration(id: string): number;
  isPlaying(id: string): boolean;
  isLoaded(id: string): boolean;
  setVolume(id: string, v: number): void;
  setRate(id: string, r: number): void;
  setPitchCents(id: string, c: number): void;
  setReverb(id: string, amount: number): void;
  setSpatial(id: string, on: boolean): void;
  setTempoProcessing(id: string, on: boolean): void;
  setSampling(id: string, on: boolean): void;
  analyzeWindow(uri: string, start: number, len: number): Promise<{ energies: number[]; lows: number[]; sr: number; c: number; duration: number }>;
  recognizeSpeech(uri: string, locale: string): Promise<{ text: string; start: number; dur: number }[]>;
  hapticsSupported(): boolean;
  hapticsStart(): void;
  hapticsStop(): void;
  hapticTransient(intensity: number, sharpness: number): void;
  hapticThump(intensity: number): void;
  hapticChannel(channel: number, level: number, sharpness: number): void;
  activateSession(): Promise<void>;
  setNowPlaying(title: string, artist: string, album: string, artworkPath: string | null, duration: number): void;
  updateNowPlaying(position: number, rate: number): void;
  clearNowPlaying(): void;
  enableRemote(on: boolean): void;
  pickImage(): Promise<string | null>;
  nativeScanDirectory(directoryUri: string): Promise<
    {
      id: string;
      uri: string;
      filename: string;
      extension: string;
      size: number;
      mtime: number;
      lrcUri?: string;
    }[]
  >;
  nativeExtractMetadata(
    items: { id: string; uri: string }[],
    coversDirUri: string
  ): Promise<
    {
      id: string;
      title?: string;
      artist?: string;
      album?: string;
      artworkUri?: string;
      bpmTag?: number;
      trackNumber?: number;
      discNumber?: number;
      lyrics?: string;
      tagged: boolean;
    }[]
  >;
  /** Миниатюры обложек (JPEG, maxPixel по длинной стороне); имя файла — хэш содержимого. Нет в старых сборках. */
  nativeExtractThumbnails?(
    items: { id: string; uri: string }[],
    coversDirUri: string,
    maxPixel: number
  ): Promise<{ id: string; artworkUri: string }[]>;
  /** Оригинал обложки из тега (без перекодирования) в кэш cacheDirUri; null — обложки нет. Нет в старых сборках. */
  nativeExtractArtwork?(uri: string, cacheDirUri: string): Promise<string | null>;
  startDirectoryWatcher(directoryUri: string): void;
  stopDirectoryWatcher(): void;
  installApk?(fileUri: string): Promise<boolean>;
  generateVideoCard?(params: {
    audioUri: string;
    artworkUri?: string | null;
    title: string;
    artist: string;
    startSec: number;
    endSec: number;
    style: 'inCover' | 'underCover' | 'textOnly';
    coverShape: 'vinyl' | 'square';
    aspect: '16:9' | '9:16' | '1:1' | '4:3' | '3:4';
    lines: { time: number; text: string }[];
  }): Promise<string>;
  generateImageCard?(params: {
    audioUri: string;
    artworkUri?: string | null;
    title: string;
    artist: string;
    style: 'glassQuote' | 'inCover' | 'underCover' | 'textOnly';
    coverShape: 'vinyl' | 'square';
    aspect: '16:9' | '9:16' | '1:1' | '4:3' | '3:4';
    lines: string[];
  }): Promise<string>;
  exportTrackWithFx?(params: {
    uri: string;
    title: string;
    speed: number;
    reverbAmount: number;
    spatial8d: boolean;
  }): Promise<string>;
  shareFile?(fileUri: string): Promise<boolean>;
  addListener(event: 'onEnded', cb: (e: { id: string }) => void): { remove: () => void };
  addListener(event: 'onSamples', cb: (e: { id: string; frames: number[] }) => void): { remove: () => void };
  addListener(event: 'onRemote', cb: (e: { command: string; position?: number }) => void): { remove: () => void };
  addListener(event: 'onLibraryChanged', cb: () => void): { remove: () => void };
  addListener(event: 'onVideoProgress', cb: (e: { progress: number }) => void): { remove: () => void };
}

export const WoufyFX: WoufyFXNative | null = requireOptionalNativeModule<WoufyFXNative>('WoufyFX');
