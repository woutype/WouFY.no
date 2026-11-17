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

const FS_BATCH_SIZE = 24;

async function runBatched<T, R>(items: T[], fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = [];
  for (let i = 0; i < items.length; i += FS_BATCH_SIZE) {
    const chunk = items.slice(i, i + FS_BATCH_SIZE);
    results.push(...(await Promise.all(chunk.map(fn))));
  }
  return results;
}

/**
 * Подсчитывает размер файлов в директории
 */
async function getDirectorySize(dirUri: string): Promise<{ bytes: number; count: number }> {
  try {
    const info = await FileSystem.getInfoAsync(dirUri);
    if (!info.exists || !info.isDirectory) return { bytes: 0, count: 0 };
    const items = await FileSystem.readDirectoryAsync(dirUri);
    const sizes = await runBatched(items, async (name) => {
      try {
        const itemUri = `${dirUri}${name}`;
        const itemInfo = await FileSystem.getInfoAsync(itemUri);
        if (!itemInfo.exists) return { bytes: 0, count: 0 };
        if (itemInfo.isDirectory) return getDirectorySize(`${itemUri}/`);
        return { bytes: itemInfo.size ?? 0, count: 1 };
      } catch {
        return { bytes: 0, count: 0 };
      }
    });
    let bytes = 0;
    let count = 0;
    for (const s of sizes) {
      bytes += s.bytes;
      count += s.count;
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
  try {
    const dir = coversDir();
    const info = await FileSystem.getInfoAsync(dir);
    if (!info.exists || !info.isDirectory) return 0;

    const files = await FileSystem.readDirectoryAsync(dir);
    const targets =
      activeCoverNames.size === 0 ? files : files.filter((file) => !activeCoverNames.has(file));
    const freed = await runBatched(targets, async (file) => {
      try {
        const fileUri = `${dir}${file}`;
        const fInfo = await FileSystem.getInfoAsync(fileUri);
        if (!fInfo.exists) return 0;
        const size = fInfo.size ?? 0;
        await FileSystem.deleteAsync(fileUri, { idempotent: true });
        return size;
      } catch {
        return 0;
      }
    });
    return freed.reduce((sum, b) => sum + b, 0);
  } catch (e) {
    console.warn('[storageService] cleanupOrphanCovers error:', e);
    return 0;
  }
}

/**
 * Удаляет кэшированные .lrc тексты из lyrics_cache/, если соответствующих треков больше нет
 */
export async function cleanupOrphanLyrics(activeLrcNames: Set<string>): Promise<number> {
  try {
    const dir = `${DATA_DIR}lyrics_cache/`;
    const info = await FileSystem.getInfoAsync(dir);
    if (!info.exists) return 0;
    const files = await FileSystem.readDirectoryAsync(dir);
    const targets = files.filter((file) => !activeLrcNames.has(file));
    const freed = await runBatched(targets, async (file) => {
      try {
        const fileUri = `${dir}${file}`;
        const fInfo = await FileSystem.getInfoAsync(fileUri);
        if (!fInfo.exists) return 0;
        const size = fInfo.size ?? 0;
        await FileSystem.deleteAsync(fileUri, { idempotent: true });
        return size;
      } catch {
        return 0;
      }
    });
    return freed.reduce((sum, b) => sum + b, 0);
  } catch (e) {
    console.warn('[storageService] cleanupOrphanLyrics error:', e);
    return 0;
  }
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
  if (!FileSystem.cacheDirectory) return 0;
  try {
    const items = await FileSystem.readDirectoryAsync(FileSystem.cacheDirectory);
    const freed = await runBatched(items, async (item) => {
      try {
        const itemUri = `${FileSystem.cacheDirectory}${item}`;
        const info = await FileSystem.getInfoAsync(itemUri);
        if (!info.exists) return 0;
        const size = info.isDirectory ? (await getDirectorySize(`${itemUri}/`)).bytes : (info.size ?? 0);
        await FileSystem.deleteAsync(itemUri, { idempotent: true });
        return size;
      } catch {
        return 0;
      }
    });
    return freed.reduce((sum, b) => sum + b, 0);
  } catch {
    return 0;
  }
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
