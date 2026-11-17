import * as FileSystem from 'expo-file-system/legacy';
import { DATA_DIR } from './library';

export interface StorageInfo {
  coversBytes: number;
  coversCount: number;
  trashBytes: number;
  trashCount: number;
  cacheBytes: number;
  totalBytes: number;
  formattedTotal: string;
}

export function formatBytes(bytes: number): string {
  if (bytes <= 0) return '0 Б';
  const units = ['Б', 'КБ', 'МБ', 'ГБ', 'ТБ'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  const num = bytes / Math.pow(1024, i);
  return `${num.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

const docDir = () => FileSystem.documentDirectory ?? '';
const coversDir = () => `${DATA_DIR}covers/`;

/**
 * Подсчитывает размер файлов в директории
 */
async function getDirectorySize(dirUri: string): Promise<{ bytes: number; count: number }> {
  try {
    const info = await FileSystem.getInfoAsync(dirUri);
    if (!info.exists || !info.isDirectory) return { bytes: 0, count: 0 };
    const items = await FileSystem.readDirectoryAsync(dirUri);
    let bytes = 0;
    let count = 0;
    for (const name of items) {
      try {
        const itemUri = `${dirUri}${name}`;
        const itemInfo = await FileSystem.getInfoAsync(itemUri);
        if (itemInfo.exists) {
          if (itemInfo.isDirectory) {
            const sub = await getDirectorySize(`${itemUri}/`);
            bytes += sub.bytes;
            count += sub.count;
          } else {
            bytes += itemInfo.size ?? 0;
            count += 1;
          }
        }
      } catch {
        /* ignore single item error */
      }
    }
    return { bytes, count };
  } catch {
    return { bytes: 0, count: 0 };
  }
}

/**
 * Получить полную статистику занятого места приложением
 */
export async function getStorageStats(): Promise<StorageInfo> {
  const covers = await getDirectorySize(coversDir());

  // iOS Files app корзины: .Trash в Documents и рядом
  let trashBytes = 0;
  let trashCount = 0;
  const trashPaths = [
    `${docDir()}.Trash/`,
    `${docDir()}../.Trash/`,
    `${docDir()}Music/.Trash/`,
  ];
  for (const tp of trashPaths) {
    const s = await getDirectorySize(tp);
    trashBytes += s.bytes;
    trashCount += s.count;
  }

  // Кэш временных файлов
  let cacheBytes = 0;
  if (FileSystem.cacheDirectory) {
    const c = await getDirectorySize(FileSystem.cacheDirectory);
    cacheBytes = c.bytes;
  }

  const totalBytes = covers.bytes + trashBytes + cacheBytes;
  return {
    coversBytes: covers.bytes,
    coversCount: covers.count,
    trashBytes,
    trashCount,
    cacheBytes,
    totalBytes,
    formattedTotal: formatBytes(totalBytes),
  };
}

/**
 * Очистка сиротских обложек: удаляет файлы из Application Support/WouFY/covers,
 * которых больше нет ни у одного трека из активной библиотеки.
 * Если вся музыка удалена (activeCoverNames пуст) — очищает все обложки.
 */
export async function cleanupOrphanCovers(activeCoverNames: Set<string>): Promise<number> {
  let freedBytes = 0;
  try {
    const dir = coversDir();
    const info = await FileSystem.getInfoAsync(dir);
    if (!info.exists || !info.isDirectory) return 0;

    const files = await FileSystem.readDirectoryAsync(dir);
    for (const file of files) {
      if (activeCoverNames.size === 0 || !activeCoverNames.has(file)) {
        try {
          const fileUri = `${dir}${file}`;
          const fInfo = await FileSystem.getInfoAsync(fileUri);
          if (fInfo.exists) {
            freedBytes += fInfo.size ?? 0;
            await FileSystem.deleteAsync(fileUri, { idempotent: true });
          }
        } catch {
          /* ignore */
        }
      }
    }
  } catch (e) {
    console.warn('[storageService] cleanupOrphanCovers error:', e);
  }
  return freedBytes;
}

/**
 * Удаляет кэшированные .lrc тексты из lyrics_cache/, если соответствующих треков больше нет
 */
export async function cleanupOrphanLyrics(activeLrcNames: Set<string>): Promise<number> {
  let freedBytes = 0;
  try {
    const dir = `${DATA_DIR}lyrics_cache/`;
    const info = await FileSystem.getInfoAsync(dir);
    if (!info.exists) return 0;
    const files = await FileSystem.readDirectoryAsync(dir);
    for (const file of files) {
      if (!activeLrcNames.has(file)) {
        try {
          const fInfo = await FileSystem.getInfoAsync(`${dir}${file}`);
          if (fInfo.exists) {
            freedBytes += fInfo.size ?? 0;
            await FileSystem.deleteAsync(`${dir}${file}`, { idempotent: true });
          }
        } catch {
          /* ignore */
        }
      }
    }
  } catch (e) {
    console.warn('[storageService] cleanupOrphanLyrics error:', e);
  }
  return freedBytes;
}

/**
 * Очистка корзины iOS (.Trash), куда «Файлы» отправляют удалённую музыку
 */
export async function cleanupTrash(): Promise<number> {
  let freedBytes = 0;
  const trashPaths = [
    `${docDir()}.Trash/`,
    `${docDir()}../.Trash/`,
    `${docDir()}Music/.Trash/`,
  ];
  for (const tp of trashPaths) {
    try {
      const info = await FileSystem.getInfoAsync(tp);
      if (info.exists) {
        const s = await getDirectorySize(tp);
        freedBytes += s.bytes;
        await FileSystem.deleteAsync(tp, { idempotent: true });
      }
    } catch {
      /* ignore */
    }
  }
  return freedBytes;
}

/**
 * Очистка кэша временных файлов (аудио-буферы, распознавание речи, временные изображения)
 */
export async function cleanupTempCache(): Promise<number> {
  let freedBytes = 0;
  if (!FileSystem.cacheDirectory) return 0;
  try {
    const items = await FileSystem.readDirectoryAsync(FileSystem.cacheDirectory);
    for (const item of items) {
      try {
        const itemUri = `${FileSystem.cacheDirectory}${item}`;
        const info = await FileSystem.getInfoAsync(itemUri);
        if (info.exists) {
          freedBytes += info.size ?? 0;
          await FileSystem.deleteAsync(itemUri, { idempotent: true });
        }
      } catch {
        /* ignore */
      }
    }
  } catch {
    /* ignore */
  }
  return freedBytes;
}

/**
 * Полная глубокая очистка всего дискового мусора:
 * - удаляет неиспользуемые обложки
 * - очищает корзину .Trash от удалённой музыки
 * - чистит временные файлы
 */
export async function purgeStorage(activeCoverNames: Set<string>): Promise<number> {
  const b1 = await cleanupOrphanCovers(activeCoverNames);
  const b2 = await cleanupTrash();
  const b3 = await cleanupTempCache();
  return b1 + b2 + b3;
}
