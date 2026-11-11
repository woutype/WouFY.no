import * as FileSystem from 'expo-file-system/legacy';
import { parseID3Tags } from './id3Parser';

export interface TrackFile {
  id: string;
  uri: string;
  filename: string;
  title: string;
  artist?: string;
  album?: string;
  artworkUri?: string;
  artworkFileUri?: string;
  lyrics?: string;
  size?: number;
  extension: 'mp3' | 'wav';
}

const SUPPORTED_EXTENSIONS = /\.(mp3|wav)$/i;

/**
 * Recursively scans a directory and returns a flat list of audio tracks (.mp3 and .wav).
 * Perfect for dropped folders like "MusicHub" with tracks inside.
 */
export async function scanAudioFiles(
  directoryUri?: string,
  autoCreateDemoIfEmpty = true
): Promise<TrackFile[]> {
  const rootDir = directoryUri || FileSystem.documentDirectory;
  if (!rootDir) {
    return [];
  }

  if (autoCreateDemoIfEmpty && !directoryUri) {
    try {
      await copySampleTrackToDocuments();
    } catch (_) {}
  }

  const results: TrackFile[] = [];

  async function traverse(currentDir: string) {
    try {
      const items = await FileSystem.readDirectoryAsync(currentDir);

      for (const item of items) {
        // Skip hidden files/directories (like .DS_Store or .trash)
        if (item.startsWith('.')) continue;

        const itemUri = currentDir.endsWith('/') ? `${currentDir}${item}` : `${currentDir}/${item}`;
        const info = await FileSystem.getInfoAsync(itemUri);

        if (!info.exists) continue;

        if (info.isDirectory) {
          // Recursively dive into folders (like MusicHub)
          await traverse(itemUri);
        } else if (SUPPORTED_EXTENSIONS.test(item)) {
          const extMatch = item.match(/\.(mp3|wav)$/i);
          const extension = (extMatch ? extMatch[1].toLowerCase() : 'mp3') as 'mp3' | 'wav';
          let title = item.replace(/\.[^/.]+$/, '');
          let artist: string | undefined;
          let album: string | undefined;
          let artworkUri: string | undefined;
          let artworkFileUri: string | undefined;
          let lyrics: string | undefined;

          // Parse ID3 tags for MP3 files
          if (extension === 'mp3') {
            const meta = await parseID3Tags(itemUri);
            if (meta.title) title = meta.title;
            if (meta.artist) artist = meta.artist;
            if (meta.album) album = meta.album;
            if (meta.artworkUri) artworkUri = meta.artworkUri;
            if (meta.artworkFileUri) artworkFileUri = meta.artworkFileUri;
            if (meta.lyrics) lyrics = meta.lyrics;
          }

          results.push({
            id: itemUri,
            uri: itemUri,
            filename: item,
            title,
            artist: artist || 'Неизвестный исполнитель',
            album,
            artworkUri,
            artworkFileUri,
            lyrics,
            size: info.size,
            extension,
          });
        }
      }
    } catch (err) {
      console.warn(`[fileScanner] Failed to read directory ${currentDir}:`, err);
    }
  }

  await traverse(rootDir);

  // If no audio files exist at all and autoCreate is enabled, copy demo track and scan again
  if (results.length === 0 && autoCreateDemoIfEmpty && !directoryUri) {
    try {
      await copySampleTrackToDocuments();
      await traverse(rootDir);
    } catch (e) {
      console.warn('[fileScanner] Could not auto-generate demo track:', e);
    }
  }

  return results;
}

import { Asset } from 'expo-asset';

/**
 * Copies the bundled sample tracks (NEXTIME - ТАЗОМ.mp3 and NEXTIME - КИС Ю.mp3) into documents directory for immediate live testing with artwork, lyrics, and DJ transitions.
 */
export async function copySampleTrackToDocuments(): Promise<string> {
  const targetDir = FileSystem.documentDirectory;
  if (!targetDir) throw new Error('Document directory unavailable');

  try {
    // Track 1: NEXTIME - ТАЗОМ.mp3
    const destUri1 = `${targetDir}NEXTIME - ТАЗОМ.mp3`;
    const info1 = await FileSystem.getInfoAsync(destUri1);
    if (!info1.exists) {
      const asset1 = Asset.fromModule(require('../../assets/sample.mp3'));
      await asset1.downloadAsync();
      if (asset1.localUri) {
        await FileSystem.copyAsync({
          from: asset1.localUri,
          to: destUri1,
        });
      }
    }

    // Track 2: NEXTIME - КИС Ю.mp3 (for DJ crossfade testing)
    const destUri2 = `${targetDir}NEXTIME - КИС Ю.mp3`;
    const info2 = await FileSystem.getInfoAsync(destUri2);
    if (!info2.exists) {
      const asset2 = Asset.fromModule(require('../../assets/sample2.mp3'));
      await asset2.downloadAsync();
      if (asset2.localUri) {
        await FileSystem.copyAsync({
          from: asset2.localUri,
          to: destUri2,
        });
      }
    }

    return destUri1;
  } catch (e) {
    console.warn('[fileScanner] Could not copy sample tracks:', e);
  }
  return createDemoAudioFile();
}

/**
 * Creates a tiny demo .wav audio file in the documents directory for instant local testing.
 */
export async function createDemoAudioFile(): Promise<string> {
  const targetDir = FileSystem.documentDirectory;
  if (!targetDir) throw new Error('Document directory unavailable');

  // A tiny 1-second 8000Hz mono 8-bit PCM WAV (silence/click) in Base64
  const wavBase64 =
    'UklGRj4AAABXQVZFZm10IBAAAAABAAEAQB8AAEB8AAABAAgAZGF0YRoAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

  const demoPath = `${targetDir}woufy-demo-test.wav`;
  await FileSystem.writeAsStringAsync(demoPath, wavBase64, {
    encoding: FileSystem.EncodingType.Base64,
  });
  return demoPath;
}

