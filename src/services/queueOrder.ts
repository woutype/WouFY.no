import { TrackFile } from '../types';

/**
 * Порядок очереди. Единый источник правды — движок (audioEngine): сортировка и поиск применяются ИМЕННО к очереди,
 * поэтому плеер идёт ровно по тому списку, который вы видите (раньше поиск лишь прятал строки, а играла вся библиотека).
 */
export type SortOption = 'default' | 'recent' | 'title' | 'artist' | 'album';

export const UNKNOWN_ARTIST = 'Неизвестный исполнитель';

// «натуральное» сравнение: 2 < 10, регистр и ё/е не важны, кириллица и латиница сортируются каждая по алфавиту
let collator: Intl.Collator | null = null;
try {
  collator = new Intl.Collator(['ru', 'en'], { numeric: true, sensitivity: 'base' });
} catch {
  collator = null;
}

/** убираем ведущие кавычки/скобки/символы, чтобы «(Intro)» и «"Name"» вставали по первой букве */
const sortKey = (s: string) => (s || '').trim().replace(/^[^\p{L}\p{N}]+/u, '');

const cmp = (a: string, b: string): number => {
  const ka = sortKey(a);
  const kb = sortKey(b);
  if (collator) {
    try {
      return collator.compare(ka, kb);
    } catch {
      // fallback
    }
  }
  return ka.localeCompare(kb, ['ru', 'en'], { numeric: true, sensitivity: 'base' });
};

function trackNo(t: TrackFile): number {
  if (t.trackNumber && !isNaN(t.trackNumber)) return t.trackNumber;
  const m = t.filename.match(/^(\d{1,3})[\s.\-_)]+\D/);
  return m ? parseInt(m[1], 10) : Number.MAX_SAFE_INTEGER;
}

export function applySort(list: TrackFile[], mode: SortOption): TrackFile[] {
  if (mode === 'default') return list;
  const copy = [...list];
  if (mode === 'recent') {
    return copy.sort((a, b) => (b.mtime ?? 0) - (a.mtime ?? 0) || cmp(a.title, b.title));
  }
  if (mode === 'title') return copy.sort((a, b) => cmp(a.title, b.title) || cmp(a.artist, b.artist));
  if (mode === 'artist') {
    return copy.sort((a, b) => {
      const ua = a.artist === UNKNOWN_ARTIST ? 1 : 0;
      const ub = b.artist === UNKNOWN_ARTIST ? 1 : 0;
      if (ua !== ub) return ua - ub; // «неизвестные» — в конец
      return cmp(a.artist, b.artist) || cmp(a.album || '', b.album || '') || trackNo(a) - trackNo(b) || cmp(a.title, b.title);
    });
  }
  // album: альбом → артист → диск → номер трека → название
  return copy.sort((a, b) => {
    const albA = a.album && a.album !== 'Сингл' ? a.album : 'Сингл';
    const albB = b.album && b.album !== 'Сингл' ? b.album : 'Сингл';
    const c = cmp(albA, albB);
    if (c !== 0) return c;
    const artC = cmp(a.artist, b.artist);
    if (artC !== 0) return artC;
    const da = a.discNumber ?? 1;
    const db = b.discNumber ?? 1;
    if (da !== db) return da - db; // диски по порядку
    const na = trackNo(a);
    const nb = trackNo(b);
    if (na !== nb) return na - nb; // от 1-го трека до последнего
    return cmp(a.title, b.title);
  });
}

/** Нормализованный запрос поиска (пустая строка — фильтра нет) */
export const normQuery = (q: string) => q.trim().toLowerCase();

/**
 * Разбивает строку исполнителей на отдельных артистов (NEXTIME/mildix -> ['NEXTIME', 'mildix'])
 * Корректно обрабатывает слэши, запятые, &, feat., ft., vs., x.
 */
export function splitArtists(artistString?: string): string[] {
  if (!artistString || !artistString.trim()) return [UNKNOWN_ARTIST];
  const trimmed = artistString.trim();
  if (/^ac\/dc$/i.test(trimmed)) return ['AC/DC'];

  const parts = trimmed
    .split(/\s*(?:\/|\\|;|,|\bfeat\.?|\bft\.?|\bvs\.?|\bx\b|&)\s*/i)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  return parts.length > 0 ? parts : [trimmed];
}

export function matchesQuery(t: TrackFile, q: string, searchLyrics = false): boolean {
  if (!q) return true;
  const lowerQ = q.toLowerCase();
  const titleMatch = t.title.toLowerCase().includes(lowerQ);
  const artistMatch =
    t.artist.toLowerCase().includes(lowerQ) ||
    splitArtists(t.artist).some((a) => a.toLowerCase().includes(lowerQ));
  const albumMatch = !!t.album && t.album.toLowerCase().includes(lowerQ);
  const fileMatch = t.filename.toLowerCase().includes(lowerQ);
  if (titleMatch || artistMatch || albumMatch || fileMatch) return true;
  if (searchLyrics) {
    if (t.lyrics && t.lyrics.toLowerCase().includes(lowerQ)) return true;
    if (t.syncedLyrics && t.syncedLyrics.some((l) => l.text.toLowerCase().includes(lowerQ))) return true;
  }
  return false;
}
