import * as FileSystem from 'expo-file-system/legacy';
import { WoufyFX } from '../../modules/woufy-fx';
import { DATA_DIR } from './library';
import { TrackFile } from '../types';

/** Размер миниатюры (px по длинной стороне): хватает для строк очереди/статистики на 3x-экранах */
export const THUMB_PX = 192;

const COVERS_DIR = `${DATA_DIR}covers/`;
/** Оригиналы обложек для главного экрана: временный кэш (iOS может его чистить, хранится не более 16 файлов) */
const originalsDir = () => `${FileSystem.cacheDirectory ?? ''}artwork/`;

/** Обложка выбрана пользователем (онлайн/галерея) — её нельзя подменять обложкой из тегов */
export function isUserCover(uri?: string): boolean {
  if (!uri) return false;
  const name = uri.split('/').pop() ?? '';
  return name.startsWith('online_') || !uri.startsWith(COVERS_DIR);
}

/** Нужно ли сформировать миниатюру (теги прочитаны, но миниатюры ещё нет, либо это старая полноразмерная копия) */
export function needsThumb(t: TrackFile): boolean {
  return t.tagged === true && !t.thumbDone && !isUserCover(t.artworkUri);
}

const memo = new Map<string, string | null>();
const MEMO_MAX = 8;

/**
 * Оригинал обложки без сжатия: байты берутся прямо из тега аудиофайла (нативно, без base64 через JS).
 * null — оригинала нет (в этом случае UI остаётся на миниатюре).
 */
export async function getFullArtwork(t: TrackFile): Promise<string | null> {
  if (!WoufyFX?.nativeExtractArtwork || isUserCover(t.artworkUri)) return t.artworkUri ?? null;
  const key = t.id;
  const hit = memo.get(key);
  if (hit) {
    const info = await FileSystem.getInfoAsync(hit).catch(() => null);
    if (info?.exists) {
      memo.delete(key);
      memo.set(key, hit);
      return hit;
    }
    memo.delete(key);
  } else if (hit === null) {
    return null;
  }
  try {
    const uri = await WoufyFX.nativeExtractArtwork(t.uri, originalsDir());
    memo.set(key, uri);
    if (memo.size > MEMO_MAX) memo.delete(memo.keys().next().value as string);
    return uri;
  } catch (e) {
    console.warn('[artwork] nativeExtractArtwork failed:', e);
    return null;
  }
}
