import * as FileSystem from 'expo-file-system/legacy';
import { SyncedLyricLine } from '../types';

export interface AudioMetadata {
  title?: string;
  artist?: string;
  album?: string;
  bpm?: number;
  artworkUri?: string; // file:// из кэша
  lyrics?: string;
  syncedLyrics?: SyncedLyricLine[];
}

function base64ToUint8Array(base64: string): Uint8Array {
  const binaryString = atob(base64);
  const len = binaryString.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) bytes[i] = binaryString.charCodeAt(i);
  return bytes;
}

function uint8ArrayToBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunkSize = 8192;
  for (let i = 0; i < bytes.byteLength; i += chunkSize) {
    const chunk = bytes.subarray(i, Math.min(i + chunkSize, bytes.byteLength));
    binary += String.fromCharCode.apply(null, chunk as unknown as number[]);
  }
  return btoa(binary);
}

/** Грубый, но надёжный хэш для имён файлов кэша */
function hash(str: string): string {
  let h = 5381;
  for (let i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

// cp1251 → Unicode для байт 0x80–0xFF
const CP1251_HIGH =
  'ЂЃ‚ѓ„…†‡€‰Љ‹ЊЌЋЏђ‘’“”•–—\u0098™љ›њќћџ\u00a0ЎўЈ¤Ґ¦§Ё©Є«¬\u00ad®Ї°±Ііґµ¶·ё№є»јЅѕїАБВГДЕЖЗИЙКЛМНОПРСТУФХЦЧШЩЪЫЬЭЮЯабвгдежзийклмнопрстуфхцчшщъыьэюя';

function decodeLatin1OrCp1251(bytes: Uint8Array, start: number, end: number): string {
  let highCount = 0;
  let cyrillicLike = 0;
  for (let i = start; i < end; i++) {
    const b = bytes[i];
    if (b >= 0x80) {
      highCount++;
      if (b >= 0xc0) cyrillicLike++;
    }
  }
  // Если почти все не-ASCII байты попадают в диапазон кириллических букв cp1251 — это cp1251
  const useCp1251 = highCount >= 3 && cyrillicLike / highCount > 0.85;
  let out = '';
  for (let i = start; i < end; i++) {
    const b = bytes[i];
    if (b === 0) break;
    out += useCp1251 && b >= 0x80 ? CP1251_HIGH[b - 0x80] : String.fromCharCode(b);
  }
  return out;
}

function decodeUtf8(bytes: Uint8Array, start: number, end: number): string {
  let out = '';
  let i = start;
  while (i < end) {
    const b = bytes[i];
    if (b === 0) break;
    if (b < 0x80) {
      out += String.fromCharCode(b);
      i += 1;
    } else if (b >= 0xc0 && b < 0xe0 && i + 1 < end) {
      out += String.fromCharCode(((b & 0x1f) << 6) | (bytes[i + 1] & 0x3f));
      i += 2;
    } else if (b >= 0xe0 && b < 0xf0 && i + 2 < end) {
      out += String.fromCharCode(
        ((b & 0x0f) << 12) | ((bytes[i + 1] & 0x3f) << 6) | (bytes[i + 2] & 0x3f)
      );
      i += 3;
    } else if (b >= 0xf0 && i + 3 < end) {
      const cp =
        ((b & 0x07) << 18) |
        ((bytes[i + 1] & 0x3f) << 12) |
        ((bytes[i + 2] & 0x3f) << 6) |
        (bytes[i + 3] & 0x3f);
      out += String.fromCodePoint(cp);
      i += 4;
    } else {
      i += 1;
    }
  }
  return out;
}

function decodeUtf16(bytes: Uint8Array, start: number, end: number, forceBE = false): string {
  let le = true;
  let i = start;
  if (end - start >= 2) {
    if (bytes[i] === 0xff && bytes[i + 1] === 0xfe) {
      le = true;
      i += 2;
    } else if (bytes[i] === 0xfe && bytes[i + 1] === 0xff) {
      le = false;
      i += 2;
    } else if (forceBE) {
      le = false;
    }
  }
  let out = '';
  for (; i + 1 < end; i += 2) {
    const code = le ? bytes[i] | (bytes[i + 1] << 8) : (bytes[i] << 8) | bytes[i + 1];
    if (code === 0) break;
    out += String.fromCharCode(code);
  }
  return out;
}

function decodeText(bytes: Uint8Array, start: number, end: number, enc: number): string {
  if (end <= start) return '';
  if (enc === 1) return decodeUtf16(bytes, start, end);
  if (enc === 2) return decodeUtf16(bytes, start, end, true);
  if (enc === 3) return decodeUtf8(bytes, start, end);
  return decodeLatin1OrCp1251(bytes, start, end);
}

/** Находит конец строки с нулевым терминатором с учётом кодировки. Возвращает [конецТекста, началоСледующего]. */
function findTerminator(bytes: Uint8Array, start: number, end: number, enc: number): [number, number] {
  if (enc === 1 || enc === 2) {
    for (let i = start; i + 1 < end; i += 2) {
      if (bytes[i] === 0 && bytes[i + 1] === 0) return [i, i + 2];
    }
    return [end, end];
  }
  for (let i = start; i < end; i++) {
    if (bytes[i] === 0) return [i, i + 1];
  }
  return [end, end];
}

function parseBpm(text: string): number | undefined {
  const n = parseFloat(text.replace(',', '.'));
  if (!isFinite(n) || n < 30 || n > 300) return undefined;
  return Math.round(n * 10) / 10;
}

/**
 * Извлекает ID3v2 теги (название, артист, альбом, обложка, BPM, текст и синхро-текст SYLT)
 * прямо из файла, читая только блок тега, а не весь трек.
 * @param cacheKey стабильный ключ трека (для имени файла обложки)
 */
export async function parseID3Tags(fileUri: string, cacheKey: string): Promise<AudioMetadata> {
  try {
    const headerBase64 = await FileSystem.readAsStringAsync(fileUri, {
      encoding: FileSystem.EncodingType.Base64,
      position: 0,
      length: 10,
    });
    const header = base64ToUint8Array(headerBase64);
    if (header.length < 10) return {};
    if (header[0] !== 0x49 || header[1] !== 0x44 || header[2] !== 0x33) return {};

    const version = header[3];
    if (version < 3) return {}; // ID3v2.2 не поддерживаем
    const flags = header[5];
    const tagSize =
      ((header[6] & 0x7f) << 21) |
      ((header[7] & 0x7f) << 14) |
      ((header[8] & 0x7f) << 7) |
      (header[9] & 0x7f);
    if (tagSize <= 0) return {};

    const fullTagBase64 = await FileSystem.readAsStringAsync(fileUri, {
      encoding: FileSystem.EncodingType.Base64,
      position: 0,
      length: tagSize + 10,
    });
    const data = base64ToUint8Array(fullTagBase64);
    const limit = Math.min(data.length, tagSize + 10);
    let offset = 10;

    // Расширенный заголовок
    if (flags & 0x40) {
      if (version === 4) {
        offset +=
          ((data[offset] & 0x7f) << 21) |
          ((data[offset + 1] & 0x7f) << 14) |
          ((data[offset + 2] & 0x7f) << 7) |
          (data[offset + 3] & 0x7f);
      } else {
        offset += 4 + ((data[offset] << 24) | (data[offset + 1] << 16) | (data[offset + 2] << 8) | data[offset + 3]);
      }
    }

    const meta: AudioMetadata = {};

    while (offset + 10 <= limit) {
      if (data[offset] === 0) break;
      const frameId = String.fromCharCode(data[offset], data[offset + 1], data[offset + 2], data[offset + 3]);

      let frameSize: number;
      if (version === 4) {
        frameSize =
          ((data[offset + 4] & 0x7f) << 21) |
          ((data[offset + 5] & 0x7f) << 14) |
          ((data[offset + 6] & 0x7f) << 7) |
          (data[offset + 7] & 0x7f);
      } else {
        frameSize =
          ((data[offset + 4] << 24) | (data[offset + 5] << 16) | (data[offset + 6] << 8) | data[offset + 7]) >>> 0;
      }

      offset += 10;
      if (frameSize <= 0 || offset + frameSize > limit) break;
      const pStart = offset;
      const pEnd = offset + frameSize;
      offset = pEnd;

      const enc = data[pStart];

      if (frameId === 'TIT2') {
        meta.title = decodeText(data, pStart + 1, pEnd, enc).trim();
      } else if (frameId === 'TPE1') {
        meta.artist = decodeText(data, pStart + 1, pEnd, enc).trim();
      } else if (frameId === 'TALB') {
        meta.album = decodeText(data, pStart + 1, pEnd, enc).trim();
      } else if (frameId === 'TBPM') {
        meta.bpm = parseBpm(decodeText(data, pStart + 1, pEnd, enc));
      } else if (frameId === 'USLT') {
        const [, afterDesc] = findTerminator(data, pStart + 4, pEnd, enc);
        meta.lyrics = decodeText(data, afterDesc, pEnd, enc).trim();
      } else if (frameId === 'SYLT') {
        // enc(1) lang(3) timestampFormat(1) contentType(1) descriptor\0 { text\0 time(4) }*
        const tsFormat = data[pStart + 4];
        const contentType = data[pStart + 5];
        if (contentType === 1 || contentType === 0) {
          let [, p] = findTerminator(data, pStart + 6, pEnd, enc);
          const lines: SyncedLyricLine[] = [];
          while (p < pEnd) {
            const [textEnd, next] = findTerminator(data, p, pEnd, enc);
            if (next + 4 > pEnd) break;
            const t = ((data[next] << 24) | (data[next + 1] << 16) | (data[next + 2] << 8) | data[next + 3]) >>> 0;
            const text = decodeText(data, p, textEnd, enc).replace(/^\n/, '').trim();
            const seconds = tsFormat === 2 ? t / 1000 : (t * 1152) / 44100; // 1 = кадры MPEG
            if (text.length > 0) lines.push({ time: seconds, text });
            p = next + 4;
          }
          if (lines.length >= 2) meta.syncedLyrics = lines;
        }
      } else if (frameId === 'APIC' && !meta.artworkUri) {
        try {
          let mimeEnd = pStart + 1;
          while (mimeEnd < pEnd && data[mimeEnd] !== 0) mimeEnd++;
          let mime = '';
          for (let i = pStart + 1; i < mimeEnd; i++) mime += String.fromCharCode(data[i]);
          const ext = /png/i.test(mime) ? 'png' : 'jpg';

          // после mime: 0x00, тип картинки (1 байт), описание (в кодировке enc), данные
          const [, imgStart] = findTerminator(data, mimeEnd + 2, pEnd, enc);
          if (imgStart < pEnd) {
            const coversDir = `${FileSystem.cacheDirectory}covers/`;
            const filePath = `${coversDir}${hash(cacheKey)}_${frameSize}.${ext}`;
            const existing = await FileSystem.getInfoAsync(filePath);
            if (existing.exists) {
              meta.artworkUri = filePath;
            } else {
              const dirInfo = await FileSystem.getInfoAsync(coversDir);
              if (!dirInfo.exists) await FileSystem.makeDirectoryAsync(coversDir, { intermediates: true });
              await FileSystem.writeAsStringAsync(filePath, uint8ArrayToBase64(data.subarray(imgStart, pEnd)), {
                encoding: FileSystem.EncodingType.Base64,
              });
              meta.artworkUri = filePath;
            }
          }
        } catch (e) {
          console.warn('[id3Parser] artwork failed:', e);
        }
      }
    }

    return meta;
  } catch (error) {
    console.warn(`[id3Parser] Could not parse ID3 for ${fileUri}:`, error);
    return {};
  }
}
