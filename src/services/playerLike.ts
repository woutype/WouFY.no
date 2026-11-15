/**
 * Общий интерфейс плеера. Его реализуют и плеер expo-audio (обычный режим),
 * и FxPlayer (нативный AVAudioEngine с эффектами) — движок работает с обоими одинаково.
 */
export interface PlayerStatus {
  duration: number;
  timeControlStatus: 'playing' | 'paused' | string;
  isLoaded: boolean;
  didJustFinish: boolean;
  isBuffering: boolean;
  error?: unknown;
}

export interface PlayerLike {
  replace(source: { uri: string } | null): void;
  play(): void;
  pause(): void;
  seekTo(seconds: number): Promise<void>;
  setPlaybackRate(rate: number, pitchCorrectionQuality?: 'low' | 'medium' | 'high'): void;
  volume: number;
  muted: boolean;
  readonly currentTime: number;
  readonly duration: number;
  readonly isLoaded: boolean;
  readonly isAudioSamplingSupported: boolean;
  setAudioSamplingEnabled(enabled: boolean): void;
  addListener(event: 'playbackStatusUpdate', cb: (s: PlayerStatus) => void): { remove: () => void };
  addListener(event: 'audioSampleUpdate', cb: (s: { channels?: { frames: ArrayLike<number> }[] }) => void): { remove: () => void };
  setActiveForLockScreen(
    active: boolean,
    metadata?: { title?: string; artist?: string; albumTitle?: string; artworkUrl?: string },
    options?: Record<string, unknown>
  ): void;
  clearLockScreenControls(): void;
  remove(): void;
  /** только у expo-audio: сохранять ли высоту тона при смене скорости */
  shouldCorrectPitch?: boolean;
  /** только у FxPlayer */
  setReverb?(amount: number): void;
  setSpatial?(on: boolean): void;
  setPitchCents?(cents: number): void;
  readonly isFx?: boolean;
}
