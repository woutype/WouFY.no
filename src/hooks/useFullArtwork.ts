import { useEffect, useState } from 'react';
import { getFullArtwork, peekFullArtwork } from '../services/artwork';
import { TrackFile } from '../types';

/** Оригинал обложки трека (после миниатюры): синхронно из кэша или асинхронно из файла */
export function useFullArtwork(track?: TrackFile): string | undefined {
  const key = track ? `${track.id}|${track.artworkUri ?? ''}` : '';
  const syncUri = peekFullArtwork(track);
  const [full, setFull] = useState<{ key: string; uri: string } | null>(
    syncUri ? { key, uri: syncUri } : null
  );

  useEffect(() => {
    if (!track) return;
    let alive = true;
    getFullArtwork(track).then((uri) => {
      if (alive && uri) setFull({ key, uri });
    });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  return (full && full.key === key ? full.uri : undefined) ?? syncUri;
}
