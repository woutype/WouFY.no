export type AudioExtension = 'mp3' | 'm4a' | 'aac' | 'wav' | 'flac' | 'aiff';

export interface SyncedLyricLine {
  time: number; // секунды
  text: string;
}

export interface TrackFile {
  /** Стабильный id: путь относительно Documents (не меняется при переустановке) */
  id: string;
  uri: string;
  filename: string;
  title: string;
  artist: string;
  album?: string;
  /** file:// из кэша обложек (лёгкий для памяти) */
  artworkUri?: string;
  lyrics?: string;
  syncedLyrics?: SyncedLyricLine[];
  /** Путь к .lrc рядом с треком, если есть */
  lrcUri?: string;
  /** BPM из тега TBPM */
  bpmTag?: number;
  size?: number;
  mtime?: number;
  trackNumber?: number;
  extension: AudioExtension;
}

export interface DJSettings {
  crossfadeEnabled: boolean;
  /** секунды: 1–15 */
  crossfadeDuration: number;
  /** подгон темпа (beatmatch) */
  bpmTransitionEnabled: boolean;
  /** плавная S-кривая громкости (иначе — линейный фейдер на всю длительность) */
  fadeVolumeEnabled: boolean;
}

export type RepeatMode = 'off' | 'all' | 'one';

export const DEFAULT_DJ: DJSettings = {
  crossfadeEnabled: false,
  crossfadeDuration: 5,
  bpmTransitionEnabled: true,
  fadeVolumeEnabled: true,
};
