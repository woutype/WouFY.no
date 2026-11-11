import * as FileSystem from 'expo-file-system/legacy';

export interface AudioMetadata {
  title?: string;
  artist?: string;
  album?: string;
  artworkUri?: string; // data:image/jpeg;base64,...
  artworkFileUri?: string; // file:///... for iOS Lock Screen Now Playing
  lyrics?: string;
}

function base64ToUint8Array(base64: string): Uint8Array {
  const binaryString = atob(base64);
  const len = binaryString.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return bytes;
}

function uint8ArrayToBase64(bytes: Uint8Array): string {
  let binary = '';
  const len = bytes.byteLength;
  const chunkSize = 8192;
  for (let i = 0; i < len; i += chunkSize) {
    const chunk = bytes.subarray(i, Math.min(i + chunkSize, len));
    binary += String.fromCharCode.apply(null, chunk as unknown as number[]);
  }
  return btoa(binary);
}

function decodeText(bytes: Uint8Array, encoding: number): string {
  if (bytes.length === 0) return '';

  if (encoding === 1 || encoding === 2) {
    // UTF-16 with BOM or UTF-16BE
    if (bytes.length < 2) return '';
    let isLittleEndian = true;
    let offset = 0;
    if (bytes[0] === 0xff && bytes[1] === 0xfe) {
      isLittleEndian = true;
      offset = 2;
    } else if (bytes[0] === 0xfe && bytes[1] === 0xff) {
      isLittleEndian = false;
      offset = 2;
    }
    let str = '';
    for (let i = offset; i + 1 < bytes.length; i += 2) {
      const code = isLittleEndian ? bytes[i] | (bytes[i + 1] << 8) : (bytes[i] << 8) | bytes[i + 1];
      if (code === 0) break;
      str += String.fromCharCode(code);
    }
    return str;
  }

  if (encoding === 3) {
    // UTF-8
    let str = '';
    let i = 0;
    while (i < bytes.length) {
      const b = bytes[i];
      if (b === 0) break;
      if (b < 128) {
        str += String.fromCharCode(b);
        i++;
      } else if (b >= 192 && b < 224 && i + 1 < bytes.length) {
        str += String.fromCharCode(((b & 31) << 6) | (bytes[i + 1] & 63));
        i += 2;
      } else if (b >= 224 && b < 240 && i + 2 < bytes.length) {
        str += String.fromCharCode(
          ((b & 15) << 12) | ((bytes[i + 1] & 63) << 6) | (bytes[i + 2] & 63)
        );
        i += 3;
      } else {
        i++;
      }
    }
    return str;
  }

  // ISO-8859-1 (Latin1)
  let str = '';
  for (let i = 0; i < bytes.length; i++) {
    if (bytes[i] === 0) break;
    str += String.fromCharCode(bytes[i]);
  }
  return str;
}

/**
 * Extracts ID3v2 tags (Title, Artist, Album, Album Art, and Lyrics)
 * entirely in-memory directly from a local audio file.
 */
export async function parseID3Tags(fileUri: string): Promise<AudioMetadata> {
  try {
    // 1. Read first 10 bytes to verify ID3 header and calculate total tag size
    const headerBase64 = await FileSystem.readAsStringAsync(fileUri, {
      encoding: FileSystem.EncodingType.Base64,
      position: 0,
      length: 10,
    });

    const header = base64ToUint8Array(headerBase64);
    if (header.length < 10) return {};

    // Check "ID3" identifier
    if (header[0] !== 0x49 || header[1] !== 0x44 || header[2] !== 0x33) {
      return {};
    }

    const version = header[3]; // e.g. 3 for ID3v2.3, 4 for ID3v2.4
    const tagSize =
      ((header[6] & 0x7f) << 21) |
      ((header[7] & 0x7f) << 14) |
      ((header[8] & 0x7f) << 7) |
      (header[9] & 0x7f);

    if (tagSize <= 0) return {};

    // 2. Read only the ID3 tag block into memory (not the full audio)
    const fullTagBase64 = await FileSystem.readAsStringAsync(fileUri, {
      encoding: FileSystem.EncodingType.Base64,
      position: 0,
      length: tagSize + 10,
    });

    const data = base64ToUint8Array(fullTagBase64);
    const limit = Math.min(data.length, tagSize + 10);
    let offset = 10;

    const metadata: AudioMetadata = {};

    while (offset + 10 <= limit) {
      if (data[offset] === 0) break; // Padding reached

      const frameId = String.fromCharCode(
        data[offset],
        data[offset + 1],
        data[offset + 2],
        data[offset + 3]
      );

      let frameSize = 0;
      if (version === 4) {
        // ID3v2.4 uses synchsafe integers for frame sizes
        frameSize =
          ((data[offset + 4] & 0x7f) << 21) |
          ((data[offset + 5] & 0x7f) << 14) |
          ((data[offset + 6] & 0x7f) << 7) |
          (data[offset + 7] & 0x7f);
      } else {
        // ID3v2.3 uses regular 32-bit big-endian
        frameSize =
          (data[offset + 4] << 24) |
          (data[offset + 5] << 16) |
          (data[offset + 6] << 8) |
          data[offset + 7];
      }

      offset += 10;
      if (offset + frameSize > limit || frameSize <= 0) break;

      const payload = data.subarray(offset, offset + frameSize);
      offset += frameSize;

      if (frameId === 'TIT2') {
        metadata.title = decodeText(payload.subarray(1), payload[0]).trim();
      } else if (frameId === 'TPE1') {
        metadata.artist = decodeText(payload.subarray(1), payload[0]).trim();
      } else if (frameId === 'TALB') {
        metadata.album = decodeText(payload.subarray(1), payload[0]).trim();
      } else if (frameId === 'USLT') {
        // Unsynchronised lyrics
        const enc = payload[0];
        const rest = payload.subarray(4); // Skip language (3 bytes)
        let descEnd = 0;
        if (enc === 1 || enc === 2) {
          while (descEnd + 1 < rest.length) {
            if (rest[descEnd] === 0 && rest[descEnd + 1] === 0) {
              descEnd += 2;
              break;
            }
            descEnd += 2;
          }
        } else {
          while (descEnd < rest.length && rest[descEnd] !== 0) {
            descEnd++;
          }
          descEnd++;
        }
        metadata.lyrics = decodeText(rest.subarray(descEnd), enc).trim();
      } else if (frameId === 'APIC') {
        // Embedded artwork image
        try {
          const enc = payload[0];
          let mimeEnd = 1;
          while (mimeEnd < payload.length && payload[mimeEnd] !== 0) {
            mimeEnd++;
          }
          let mime = '';
          for (let i = 1; i < mimeEnd; i++) {
            mime += String.fromCharCode(payload[i]);
          }
          if (!mime) mime = 'image/jpeg';

          // Skip null byte and picture type (1 byte)
          const rest = payload.subarray(mimeEnd + 2);
          let descEnd = 0;
          if (enc === 1 || enc === 2) {
            while (descEnd + 1 < rest.length) {
              if (rest[descEnd] === 0 && rest[descEnd + 1] === 0) {
                descEnd += 2;
                break;
              }
              descEnd += 2;
            }
          } else {
            while (descEnd < rest.length && rest[descEnd] !== 0) {
              descEnd++;
            }
            descEnd++;
          }

          const imageBytes = rest.subarray(descEnd);
          if (imageBytes.length > 0) {
            const b64 = uint8ArrayToBase64(imageBytes);
            metadata.artworkUri = `data:${mime};base64,${b64}`;

            // Save image to cache for iOS MPNowPlayingInfoCenter / Lock Screen
            try {
              const coversDir = `${FileSystem.cacheDirectory}covers/`;
              const coversDirInfo = await FileSystem.getInfoAsync(coversDir);
              if (!coversDirInfo.exists) {
                await FileSystem.makeDirectoryAsync(coversDir, { intermediates: true });
              }
              const cleanName = fileUri.split('/').pop()?.replace(/[^a-zA-Z0-9]/g, '_') || 'track';
              const filePath = `${coversDir}${cleanName}.jpg`;
              await FileSystem.writeAsStringAsync(filePath, b64, {
                encoding: FileSystem.EncodingType.Base64,
              });
              metadata.artworkFileUri = filePath;
            } catch (cacheErr) {
              console.warn('[id3Parser] Could not write cache artwork file:', cacheErr);
            }
          }
        } catch (e) {
          console.warn('[id3Parser] Failed to decode APIC artwork:', e);
        }
      }
    }

    return metadata;
  } catch (error) {
    console.warn(`[id3Parser] Could not parse ID3 for ${fileUri}:`, error);
    return {};
  }
}
