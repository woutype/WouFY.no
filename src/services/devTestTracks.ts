import * as FileSystem from 'expo-file-system/legacy';
import { Asset } from 'expo-asset';
import { WoufyFX } from '../../modules/woufy-fx';

const TEST_TRACK_ASSETS: Array<{ filename: string; load: () => number }> = [
  { filename: 'test_track_1.mp3', load: () => require('../../test-tracks/test_track_1.mp3') },
  { filename: 'test_track_2.mp3', load: () => require('../../test-tracks/test_track_2.mp3') },
  { filename: 'test_track_3.mp3', load: () => require('../../test-tracks/test_track_3.mp3') },
];

let seeded = false;

/**
 * Копирует локальные тестовые треки из test-tracks/ в папку Music/
 * ТОЛЬКО в режиме разработки в Expo Go (__DEV__ && !WoufyFX).
 * В релизные сборки (.ipa / .apk) эти файлы не попадают.
 */
export async function seedExpoGoTestTracks(targetMusicDir: string): Promise<void> {
  if (!__DEV__ || WoufyFX || seeded) return;
  seeded = true;

  for (const item of TEST_TRACK_ASSETS) {
    try {
      const dest = `${targetMusicDir}${item.filename}`;
      const info = await FileSystem.getInfoAsync(dest);
      if (info.exists) continue;

      const mod = item.load();
      if (!mod) continue;
      const asset = Asset.fromModule(mod);
      if (!asset.localUri) {
        await asset.downloadAsync();
      }
      if (asset.localUri) {
        await FileSystem.copyAsync({ from: asset.localUri, to: dest });
      }
    } catch (e) {
      console.warn('[devTestTracks] failed to seed', item.filename, e);
    }
  }
}
