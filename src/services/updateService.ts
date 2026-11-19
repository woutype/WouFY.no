import { Linking, Platform } from 'react-native';
import * as FileSystem from 'expo-file-system/legacy';
import { WoufyFX } from '../../modules/woufy-fx';
import appConfig from '../../app.json';

export const CURRENT_VERSION: string = appConfig?.expo?.version || '1.2.8';

const APPS_JSON_URL = 'https://raw.githubusercontent.com/woutype/WouFY.no/main/apps.json';
const GITHUB_RELEASE_API = 'https://api.github.com/repos/woutype/WouFY.no/releases/latest';
const PUBLIC_REPO_RELEASES = 'https://github.com/woutype/WouFY.no/releases';

export interface UpdateInfo {
  hasUpdate: boolean;
  currentVersion: string;
  latestVersion: string;
  notes: string;
  ipaUrl: string;
  apkUrl: string;
  releaseUrl: string;
}

function parseSemver(v: string): number[] {
  return v
    .replace(/^v/i, '')
    .trim()
    .split(/[.-]/)
    .map((p) => {
      const n = parseInt(p, 10);
      return Number.isFinite(n) ? n : 0;
    });
}

export function compareVersions(a: string, b: string): number {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const va = pa[i] ?? 0;
    const vb = pb[i] ?? 0;
    if (va > vb) return 1;
    if (va < vb) return -1;
  }
  return 0;
}

let cachedUpdate: UpdateInfo | null = null;

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs = 12000): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

export async function checkForUpdate(force = false): Promise<UpdateInfo> {
  if (cachedUpdate && !force) return cachedUpdate;

  let latestVersion = CURRENT_VERSION;
  let notes = '';
  let ipaUrl = '';
  let apkUrl = '';
  let releaseUrl = PUBLIC_REPO_RELEASES;

  // 1. Сначала проверяем raw apps.json (мгновенно и без лимитов GitHub API)
  try {
    const res = await fetchWithTimeout(`${APPS_JSON_URL}?t=${Date.now()}`, {
      headers: { 'Cache-Control': 'no-cache' },
    });
    if (res.ok) {
      const data = await res.json();
      const app = data?.apps?.[0];
      const latestEntry = app?.versions?.[0];
      const ver = (latestEntry?.version || app?.version || '').replace(/^v/i, '').trim();
      if (ver) {
        latestVersion = ver;
        notes = latestEntry?.localizedDescription || app?.localizedDescription || '';
        ipaUrl =
          latestEntry?.downloadURL ||
          app?.downloadURL ||
          `https://github.com/woutype/WouFY.no/releases/download/v${ver}/woufy.ipa`;
        apkUrl =
          latestEntry?.apkDownloadURL ||
          app?.apkDownloadURL ||
          `https://github.com/woutype/WouFY.no/releases/download/v${ver}/woufy.apk`;
        releaseUrl = `https://github.com/woutype/WouFY.no/releases/tag/v${ver}`;
      }
    }
  } catch {
    // продолжаем к запасному источнику
  }

  // 2. Дополнительно проверяем GitHub Releases API (если там опубликован ещё более свежий тег или APK)
  try {
    const res = await fetchWithTimeout(GITHUB_RELEASE_API, {
      headers: { Accept: 'application/vnd.github+json' },
    });
    if (res.ok) {
      const rel = await res.json();
      const tagVer = String(rel?.tag_name || '').replace(/^v/i, '').trim();
      if (tagVer && compareVersions(tagVer, latestVersion) >= 0) {
        latestVersion = tagVer;
        if (rel?.body && !notes) notes = String(rel.body).trim();
        if (rel?.html_url) releaseUrl = String(rel.html_url);
        const assets: any[] = Array.isArray(rel?.assets) ? rel.assets : [];
        const ipaAsset = assets.find((a) => String(a?.name || '').endsWith('.ipa'));
        const apkAsset = assets.find((a) => String(a?.name || '').endsWith('.apk'));
        if (ipaAsset?.browser_download_url) ipaUrl = ipaAsset.browser_download_url;
        if (apkAsset?.browser_download_url) apkUrl = apkAsset.browser_download_url;
      }
    }
  } catch {
    // игнорируем сетевые ошибки
  }

  if (!ipaUrl) {
    ipaUrl = `https://github.com/woutype/WouFY.no/releases/download/v${latestVersion}/woufy.ipa`;
  }
  if (!apkUrl) {
    apkUrl = `https://github.com/woutype/WouFY.no/releases/download/v${latestVersion}/woufy.apk`;
  }

  const hasUpdate = compareVersions(latestVersion, CURRENT_VERSION) > 0;
  cachedUpdate = {
    hasUpdate,
    currentVersion: CURRENT_VERSION,
    latestVersion,
    notes,
    ipaUrl,
    apkUrl,
    releaseUrl,
  };
  return cachedUpdate;
}

export async function installUpdate(
  info: UpdateInfo,
  onProgress?: (progress: number) => void
): Promise<void> {
  if (Platform.OS === 'android') {
    const targetPath = `${FileSystem.cacheDirectory ?? FileSystem.documentDirectory}woufy-update-${info.latestVersion}.apk`;
    try {
      const oldInfo = await FileSystem.getInfoAsync(targetPath);
      if (oldInfo.exists) {
        await FileSystem.deleteAsync(targetPath, { idempotent: true });
      }
    } catch {}

    onProgress?.(0.02);
    const dl = FileSystem.createDownloadResumable(
      info.apkUrl,
      targetPath,
      {},
      (prog) => {
        if (prog.totalBytesExpectedToWrite > 0) {
          onProgress?.(
            Math.min(1, Math.max(0.02, prog.totalBytesWritten / prog.totalBytesExpectedToWrite))
          );
        }
      }
    );

    const res = await dl.downloadAsync();
    onProgress?.(1);

    if (res?.uri && WoufyFX?.installApk) {
      const ok = await WoufyFX.installApk(res.uri);
      if (ok) return;
    }
    await Linking.openURL(info.apkUrl);
    return;
  }

  // На iOS: пробуем открыть установку напрямую в SideStore / AltStore, иначе открываем прямую ссылку на .ipa
  const sideStoreUrl = `sidestore://install?url=${encodeURIComponent(info.ipaUrl)}`;
  const altStoreUrl = `altstore://install?url=${encodeURIComponent(info.ipaUrl)}`;

  try {
    const canSideStore = await Linking.canOpenURL(sideStoreUrl);
    if (canSideStore) {
      await Linking.openURL(sideStoreUrl);
      return;
    }
  } catch {}

  try {
    const canAltStore = await Linking.canOpenURL(altStoreUrl);
    if (canAltStore) {
      await Linking.openURL(altStoreUrl);
      return;
    }
  } catch {}

  await Linking.openURL(info.ipaUrl);
}
