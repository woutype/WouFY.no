import * as FileSystem from 'expo-file-system/legacy';
import { SyncedLyricLine } from '../types';
import { DATA_DIR } from './library';

export interface AudioMetadata {
  title?: string;
  artist?: string;
  album?: string;
  bpm?: number;
  artworkUri?: string; // file:// из постоянного кэша обложек
  trackNumber?: number;
  discNumber?: number;
  lyrics?: string;
  syncedLyrics?: SyncedLyricLine[];
}

/* ───────────── базовые утилиты ───────────── */

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

/** Читает диапазон файла [position, position+length) */
async function readRange(uri: string, position: number, length: number): Promise<Uint8Array> {
  const b64 = await FileSystem.readAsStringAsync(uri, {
    encoding: FileSystem.EncodingType.Base64,
    position,
    length,
  });
  return base64ToUint8Array(b64);
}

/** Хэш для имён файлов кэша обложек */
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

function decodeUtf8(bytes: Uint8Array, start: number, end: number, stopAtNull = true): string {
  let out = '';
  let i = start;
  while (i < end) {
    const b = bytes[i];
    if (b === 0 && stopAtNull) break;
    if (b < 0x80) {
      out += String.fromCharCode(b);
      i += 1;
    } else if (b >= 0xc0 && b < 0xe0 && i + 1 < end) {
      out += String.fromCharCode(((b & 0x1f) << 6) | (bytes[i + 1] & 0x3f));
      i += 2;
    } else if (b >= 0xe0 && b < 0xf0 && i + 2 < end) {
      out += String.fromCharCode(((b & 0x0f) << 12) | ((bytes[i + 1] & 0x3f) << 6) | (bytes[i + 2] & 0x3f));
      i += 3;
    } else if (b >= 0xf0 && i + 3 < end) {
      const cp = ((b & 0x07) << 18) | ((bytes[i + 1] & 0x3f) << 12) | ((bytes[i + 2] & 0x3f) << 6) | (bytes[i + 3] & 0x3f);
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
    if (code === 0) continue;
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

/** Конец строки с нулевым терминатором с учётом кодировки: [конецТекста, началоСледующего] */
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
  return Math.round(n * 100) / 100;
}

const parseIntPart = (s: string): number | undefined => {
  const n = parseInt(s.split('/')[0], 10);
  return !isNaN(n) && n > 0 ? n : undefined;
};

/** Сохраняет обложку в постоянный кэш (Application Support/WouFY/covers) и возвращает путь */
async function saveCover(bytes: Uint8Array, ext: 'jpg' | 'png', _key: string): Promise<string | undefined> {
  try {
    const dir = `${DATA_DIR}covers/`;
    // имя по содержимому (длина + выборка байт), а не по треку: одинаковая обложка альбома хранится один раз
    let sample = '';
    const step = Math.max(1, Math.floor(bytes.length / 64));
    for (let i = 0; i < bytes.length; i += step) sample += String.fromCharCode(bytes[i]);
    const filePath = `${dir}${hash(sample)}_${bytes.length}.${ext}`;
    const existing = await FileSystem.getInfoAsync(filePath);
    if (existing.exists) return filePath;
    const dirInfo = await FileSystem.getInfoAsync(dir);
    if (!dirInfo.exists) await FileSystem.makeDirectoryAsync(dir, { intermediates: true });
    await FileSystem.writeAsStringAsync(filePath, uint8ArrayToBase64(bytes), { encoding: FileSystem.EncodingType.Base64 });
    return filePath;
  } catch (e) {
    console.warn('[tags] cover save failed:', e);
    return undefined;
  }
}

function sniffImageExt(b: Uint8Array): 'jpg' | 'png' {
  return b.length > 4 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 ? 'png' : 'jpg';
}

/* ───────────── MP3: ID3v2.2 / 2.3 / 2.4 ───────────── */

const V22_MAP: Record<string, string> = {
  TT2: 'TIT2',
  TP1: 'TPE1',
  TAL: 'TALB',
  TBP: 'TBPM',
  TRK: 'TRCK',
  TPA: 'TPOS',
  ULT: 'USLT',
  SLT: 'SYLT',
  PIC: 'APIC',
};

async function parseID3(fileUri: string, cacheKey: string): Promise<AudioMetadata> {
  const header = await readRange(fileUri, 0, 10);
  if (header.length < 10) return {};
  if (header[0] !== 0x49 || header[1] !== 0x44 || header[2] !== 0x33) return {};

  const version = header[3]; // 2, 3 или 4
  if (version < 2 || version > 4) return {};
  const flags = header[5];
  const tagSize = ((header[6] & 0x7f) << 21) | ((header[7] & 0x7f) << 14) | ((header[8] & 0x7f) << 7) | (header[9] & 0x7f);
  if (tagSize <= 0) return {};

  const data = await readRange(fileUri, 0, tagSize + 10);
  const limit = Math.min(data.length, tagSize + 10);
  let offset = 10;

  // Расширенный заголовок (v2.3/2.4)
  if (version >= 3 && flags & 0x40) {
    if (version === 4) {
      offset += ((data[offset] & 0x7f) << 21) | ((data[offset + 1] & 0x7f) << 14) | ((data[offset + 2] & 0x7f) << 7) | (data[offset + 3] & 0x7f);
    } else {
      offset += 4 + ((data[offset] << 24) | (data[offset + 1] << 16) | (data[offset + 2] << 8) | data[offset + 3]);
    }
  }

  const meta: AudioMetadata = {};
  const hdr = version === 2 ? 6 : 10;

  while (offset + hdr <= limit) {
    if (data[offset] === 0) break;
    let frameId: string;
    let frameSize: number;
    if (version === 2) {
      const raw = String.fromCharCode(data[offset], data[offset + 1], data[offset + 2]);
      frameId = V22_MAP[raw] ?? raw;
      frameSize = (data[offset + 3] << 16) | (data[offset + 4] << 8) | data[offset + 5];
    } else {
      frameId = String.fromCharCode(data[offset], data[offset + 1], data[offset + 2], data[offset + 3]);
      frameSize =
        version === 4
          ? ((data[offset + 4] & 0x7f) << 21) | ((data[offset + 5] & 0x7f) << 14) | ((data[offset + 6] & 0x7f) << 7) | (data[offset + 7] & 0x7f)
          : ((data[offset + 4] << 24) | (data[offset + 5] << 16) | (data[offset + 6] << 8) | data[offset + 7]) >>> 0;
    }

    offset += hdr;
    if (frameSize <= 0 || offset + frameSize > limit) break;
    const pStart = offset;
    const pEnd = offset + frameSize;
    offset = pEnd;

    const enc = data[pStart];

    if (frameId === 'TIT2') meta.title = decodeText(data, pStart + 1, pEnd, enc).trim();
    else if (frameId === 'TPE1') meta.artist = decodeText(data, pStart + 1, pEnd, enc).trim();
    else if (frameId === 'TALB') meta.album = decodeText(data, pStart + 1, pEnd, enc).trim();
    else if (frameId === 'TBPM') meta.bpm = parseBpm(decodeText(data, pStart + 1, pEnd, enc));
    else if (frameId === 'TRCK') meta.trackNumber = parseIntPart(decodeText(data, pStart + 1, pEnd, enc).trim());
    else if (frameId === 'TPOS') meta.discNumber = parseIntPart(decodeText(data, pStart + 1, pEnd, enc).trim());
    else if (frameId === 'USLT') {
      const [, afterDesc] = findTerminator(data, pStart + 4, pEnd, enc);
      const txt = decodeText(data, afterDesc, pEnd, enc).trim();
      // несколько USLT-кадров (разные языки): берём самый длинный
      if (!meta.lyrics || txt.length > meta.lyrics.length) meta.lyrics = txt;
    } else if (frameId === 'COMM' || frameId === 'COM') {
      const [, afterDesc] = findTerminator(data, pStart + 4, pEnd, enc);
      const desc = decodeText(data, pStart + 4, afterDesc, enc).toLowerCase();
      const txt = decodeText(data, afterDesc, pEnd, enc).trim();
      if ((desc.includes('lyric') || txt.split('\n').length > 3) && (!meta.lyrics || txt.length > meta.lyrics.length)) {
        meta.lyrics = txt;
      }
    } else if (frameId === 'TXXX') {
      const [descEnd, afterDesc] = findTerminator(data, pStart + 1, pEnd, enc);
      const desc = decodeText(data, pStart + 1, descEnd, enc).toUpperCase();
      if (desc.includes('LYRIC')) {
        const txt = decodeText(data, afterDesc, pEnd, enc).trim();
        if (txt && (!meta.lyrics || txt.length > meta.lyrics.length)) meta.lyrics = txt;
      }
    } else if (frameId === 'SYLT') {
      // enc(1) lang(3) timestampFormat(1) contentType(1) descriptor\0 { text\0 time(4) }*
      const tsFormat = data[pStart + 4];
      const contentType = data[pStart + 5];
      if (contentType === 1 || contentType === 0) {
        const [, start] = findTerminator(data, pStart + 6, pEnd, enc);
        let p = start;
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
        let imgStart: number;
        let ext: 'jpg' | 'png';
        if (version === 2) {
          // enc(1) format(3) type(1) description\0 data
          ext = /png/i.test(String.fromCharCode(data[pStart + 1], data[pStart + 2], data[pStart + 3])) ? 'png' : 'jpg';
          [, imgStart] = findTerminator(data, pStart + 5, pEnd, enc);
        } else {
          let mimeEnd = pStart + 1;
          while (mimeEnd < pEnd && data[mimeEnd] !== 0) mimeEnd++;
          let mime = '';
          for (let i = pStart + 1; i < mimeEnd; i++) mime += String.fromCharCode(data[i]);
          ext = /png/i.test(mime) ? 'png' : 'jpg';
          // после mime: 0x00, тип картинки (1 байт), описание (в кодировке enc), данные
          [, imgStart] = findTerminator(data, mimeEnd + 2, pEnd, enc);
        }
        if (imgStart < pEnd) meta.artworkUri = await saveCover(data.subarray(imgStart, pEnd), ext, cacheKey);
      } catch (e) {
        console.warn('[id3Parser] artwork failed:', e);
      }
    }
  }
  return meta;
}

/* ───────────── FLAC: Vorbis comments + PICTURE ───────────── */

async function parseFlac(fileUri: string, cacheKey: string): Promise<AudioMetadata> {
  const head = await readRange(fileUri, 0, 4);
  if (head.length < 4 || head[0] !== 0x66 || head[1] !== 0x4c || head[2] !== 0x61 || head[3] !== 0x43) return {};

  const meta: AudioMetadata = {};
  let albumArtist = '';
  let pos = 4;
  for (let guard = 0; guard < 64; guard++) {
    const bh = await readRange(fileUri, pos, 4);
    if (bh.length < 4) break;
    const last = (bh[0] & 0x80) !== 0;
    const type = bh[0] & 0x7f;
    const len = (bh[1] << 16) | (bh[2] << 8) | bh[3];
    const body = pos + 4;

    if (type === 4 && len > 0 && len < 8 * 1024 * 1024) {
      const d = await readRange(fileUri, body, len);
      const dv = (o: number) => d[o] | (d[o + 1] << 8) | (d[o + 2] << 16) | ((d[o + 3] << 24) >>> 0);
      let o = 0;
      const vendorLen = dv(o);
      o += 4 + vendorLen;
      const count = dv(o);
      o += 4;
      for (let i = 0; i < count && o + 4 <= d.length; i++) {
        const l = dv(o);
        o += 4;
        if (l < 0 || o + l > d.length) break;
        const kv = decodeUtf8(d, o, o + l, false);
        o += l;
        const eq = kv.indexOf('=');
        if (eq < 1) continue;
        const key = kv.slice(0, eq).toUpperCase();
        const val = kv.slice(eq + 1).trim();
        if (key === 'TITLE') meta.title = val;
        else if (key === 'ARTIST') meta.artist = val;
        else if (key === 'ALBUMARTIST') albumArtist = val;
        else if (key === 'ALBUM') meta.album = val;
        else if (key === 'TRACKNUMBER') meta.trackNumber = parseIntPart(val);
        else if (key === 'DISCNUMBER') meta.discNumber = parseIntPart(val);
        else if (key === 'BPM') meta.bpm = parseBpm(val);
        else if (key === 'LYRICS' || key === 'UNSYNCEDLYRICS' || key === 'UNSYNCED LYRICS') {
          if (!meta.lyrics || val.length > meta.lyrics.length) meta.lyrics = val;
        }
      }
    } else if (type === 6 && !meta.artworkUri && len > 32 && len < 16 * 1024 * 1024) {
      const d = await readRange(fileUri, body, len);
      const be = (o: number) => ((d[o] << 24) | (d[o + 1] << 16) | (d[o + 2] << 8) | d[o + 3]) >>> 0;
      let o = 4; // picture type
      const mimeLen = be(o);
      o += 4 + mimeLen;
      const descLen = be(o);
      o += 4 + descLen + 16; // width, height, depth, colors
      const dataLen = be(o);
      o += 4;
      if (dataLen > 0 && o + dataLen <= d.length) {
        const img = d.subarray(o, o + dataLen);
        meta.artworkUri = await saveCover(img, sniffImageExt(img), cacheKey);
      }
    }
    pos = body + len;
    if (last) break;
  }
  if (!meta.artist && albumArtist) meta.artist = albumArtist;
  return meta;
}

/* ───────────── M4A / AAC в MP4-контейнере: ©nam ©ART ©alb ©lyr covr trkn disk tmpo ───────────── */

const fourcc = (d: Uint8Array, o: number) => String.fromCharCode(d[o], d[o + 1], d[o + 2], d[o + 3]);
const u32 = (d: Uint8Array, o: number) => ((d[o] << 24) | (d[o + 1] << 16) | (d[o + 2] << 8) | d[o + 3]) >>> 0;

async function parseMp4(fileUri: string, cacheKey: string): Promise<AudioMetadata> {
  const info = await FileSystem.getInfoAsync(fileUri);
  const fileSize = info.exists && 'size' in info && typeof info.size === 'number' ? info.size : 0;
  if (!fileSize) return {};

  // 1) находим moov среди верхнеуровневых атомов
  let pos = 0;
  let moovStart = -1;
  let moovLen = 0;
  for (let guard = 0; guard < 64 && pos + 8 <= fileSize; guard++) {
    const h = await readRange(fileUri, pos, 16);
    if (h.length < 8) break;
    let size = u32(h, 0);
    const type = fourcc(h, 4);
    if (size === 1 && h.length >= 16) size = u32(h, 8) * 4294967296 + u32(h, 12);
    else if (size === 0) size = fileSize - pos;
    if (size < 8) break;
    if (type === 'moov') {
      moovStart = pos;
      moovLen = size;
      break;
    }
    pos += size;
  }
  if (moovStart < 0 || moovLen > 24 * 1024 * 1024) return {};

  const moov = await readRange(fileUri, moovStart, moovLen);

  // 2) спускаемся moov → udta → meta → ilst
  const find = (d: Uint8Array, from: number, to: number, name: string, skip = 0): [number, number] | null => {
    let o = from + skip;
    while (o + 8 <= to) {
      const sz = u32(d, o);
      if (sz < 8) return null;
      if (fourcc(d, o + 4) === name) return [o + 8, Math.min(to, o + sz)];
      o += sz;
    }
    return null;
  };
  const udta = find(moov, 8, moov.length, 'udta');
  if (!udta) return {};
  const metaBox = find(moov, udta[0], udta[1], 'meta');
  if (!metaBox) return {};
  const ilst = find(moov, metaBox[0] + 4, metaBox[1], 'ilst'); // у meta 4 байта version/flags
  if (!ilst) return {};

  const meta: AudioMetadata = {};
  let o = ilst[0];
  while (o + 8 <= ilst[1]) {
    const sz = u32(moov, o);
    if (sz < 8) break;
    const name = fourcc(moov, o + 4).replace(/\u00a9/g, '©');
    const end = Math.min(ilst[1], o + sz);
    const dataBox = find(moov, o + 8, end, 'data');
    if (dataBox) {
      const [ds, de] = dataBox;
      const payload = ds + 8; // 4 байта type/flags + 4 байта locale
      if (name === '©nam') meta.title = decodeUtf8(moov, payload, de, false).trim();
      else if (name === '©ART') meta.artist = decodeUtf8(moov, payload, de, false).trim();
      else if (name === 'aART' && !meta.artist) meta.artist = decodeUtf8(moov, payload, de, false).trim();
      else if (name === '©alb') meta.album = decodeUtf8(moov, payload, de, false).trim();
      else if (name === '©lyr' || name === 'lyrics') meta.lyrics = decodeUtf8(moov, payload, de, false).trim();
      else if (name === 'trkn' && de - payload >= 4) meta.trackNumber = (moov[payload + 2] << 8) | moov[payload + 3] || undefined;
      else if (name === 'disk' && de - payload >= 4) meta.discNumber = (moov[payload + 2] << 8) | moov[payload + 3] || undefined;
      else if (name === 'tmpo' && de - payload >= 2) meta.bpm = parseBpm(String((moov[payload] << 8) | moov[payload + 1]));
      else if (name === 'covr' && !meta.artworkUri && de - payload > 16) {
        const img = moov.subarray(payload, de);
        meta.artworkUri = await saveCover(img, sniffImageExt(img), cacheKey);
      }
    }
    o += sz;
  }
  return meta;
}

/**
 * Единая точка входа: определяет формат по расширению и читает теги прямо из файла
 * (читается только блок тегов, а не весь трек).
 */
export async function parseAudioTags(fileUri: string, cacheKey: string, ext: string): Promise<AudioMetadata> {
  try {
    if (ext === 'mp3') return await parseID3(fileUri, cacheKey);
    if (ext === 'flac') return await parseFlac(fileUri, cacheKey);
    if (ext === 'm4a' || ext === 'aac') {
      const m = await parseMp4(fileUri, cacheKey);
      if (m.title || m.artist || m.artworkUri || m.lyrics) return m;
      return await parseID3(fileUri, cacheKey); // .aac бывает с ID3 в начале
    }
    if (ext === 'wav' || ext === 'aiff') return await parseID3(fileUri, cacheKey);
  } catch (error) {
    console.warn(`[tags] Could not parse tags for ${fileUri}:`, error);
  }
  return {};
}

/** Совместимость со старым именем */
export const parseID3Tags = (fileUri: string, cacheKey: string) => parseAudioTags(fileUri, cacheKey, 'mp3');
