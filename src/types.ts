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
  year?: number;
  genre?: string;
  /** file:// из кэша обложек (лёгкий для памяти) */
  artworkUri?: string;
  /** миниатюра обложки уже сформирована (или обложки в файле нет) — повторно не читаем */
  thumbDone?: boolean;
  lyrics?: string;
  syncedLyrics?: SyncedLyricLine[];
  /** Путь к .lrc рядом с треком, если есть */
  lrcUri?: string;
  /** BPM из тега TBPM */
  bpmTag?: number;
  size?: number;
  mtime?: number;
  trackNumber?: number;
  /** номер диска (для многодисковых альбомов) */
  discNumber?: number;
  extension: AudioExtension;
  /** теги уже прочитаны из файла (false — трек показан по имени файла, теги дочитываются в фоне) */
  tagged?: boolean;
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

/** Звуковые эффекты (реверберация, 8D, Slowed, Speed Up) */
export interface FxSettings {
  /** общий тумблер «Включить звуковые эффекты» */
  enabled: boolean;
  reverb: boolean;
  /** 0–100: доля обработанного сигнала */
  reverbAmount: number;
  spatial8d: boolean;
  slowed: boolean;
  /** реверберация, привязанная к Slowed */
  slowedReverb: boolean;
  slowedReverbAmount: number;
  speedUp: boolean;
}

export const DEFAULT_FX: FxSettings = {
  enabled: false,
  reverb: false,
  reverbAmount: 35,
  spatial8d: false,
  slowed: false,
  slowedReverb: true,
  slowedReverbAmount: 40,
  speedUp: false,
};

/** Скорость/высота тона для Slowed и Speed Up (как в «slowed + reverb» и nightcore: темп и тон меняются вместе) */
export const SLOWED_RATE = 0.85;
export const SPEEDUP_RATE = 1.25;
