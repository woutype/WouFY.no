/**
 * Поиск синхронизированного (LRC) и обычного текста песни через LRCLIB.
 * Таймаут короткий, чтобы никогда не тормозить скачивание трека.
 */
export async function fetchLrclibLyrics({ artist, title, album, duration }) {
  if (!artist || !title) return null;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 3500);

  try {
    const qs = new URLSearchParams({
      artist_name: artist.trim(),
      track_name: title.trim(),
    });
    if (album) qs.set('album_name', album.trim());
    if (duration && Number.isFinite(duration)) qs.set('duration', String(Math.round(duration)));

    const res = await fetch(`https://lrclib.net/api/get?${qs.toString()}`, {
      headers: {
        'User-Agent': 'WouFY-Downloader/1.0 (+https://github.com/woutype)',
        Accept: 'application/json',
      },
      signal: controller.signal,
    });

    if (!res.ok) return null;
    const data = await res.json();
    const syncedLyrics = typeof data?.syncedLyrics === 'string' && data.syncedLyrics.trim() ? data.syncedLyrics.trim() : undefined;
    const plainLyrics = typeof data?.plainLyrics === 'string' && data.plainLyrics.trim() ? data.plainLyrics.trim() : undefined;

    if (!syncedLyrics && !plainLyrics) return null;
    return {
      syncedLyrics,
      lyrics: syncedLyrics || plainLyrics,
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
