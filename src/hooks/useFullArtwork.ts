import { useEffect, useState } from 'react';
import { getFullArtwork } from '../services/artwork';
import { TrackFile } from '../types';

/** Оригинал обложки трека (после миниатюры): undefined, пока не прочитан или обложки нет */
export function useFullArtwork(track?: TrackFile): string | undefined {
  const [full, setFull] = useState<{ key: string; uri: string } | null>(null);
  const key = track ? `${track.id}|${track.artworkUri ?? ''}` : '';

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

  return full && full.key === key ? full.uri : undefined;
}
