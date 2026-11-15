import { TrackFile } from '../types';

/**
 * Порядок очереди. Единый источник правды — движок (audioEngine): сортировка и поиск применяются ИМЕННО к очереди,
 * поэтому плеер идёт ровно по тому списку, который вы видите (раньше поиск лишь прятал строки, а играла вся библиотека).
 */
export type SortOption = 'default' | 'title' | 'artist' | 'album';

export const UNKNOWN_ARTIST = 'Неизвестный исполнитель';

// «натуральное» сравнение: 2 < 10, регистр и ё/е не важны, кириллица и латиница сортируются каждая по алфавиту
const collator = new Intl.Collator(['ru', 'en'], { numeric: true, sensitivity: 'base' });
/** убираем ведущие кавычки/скобки/символы, чтобы «(Intro)» и «"Name"» вставали по первой букве */
const sortKey = (s: string) => (s || '').trim().replace(/^[^\p{L}\p{N}]+/u, '');
const cmp = (a: string, b: string) => collator.compare(sortKey(a), sortKey(b));

function trackNo(t: TrackFile): number {
  if (t.trackNumber && !isNaN(t.trackNumber)) return t.trackNumber;
  const m = t.filename.match(/^(\d{1,3})[\s.\-_)]+\D/);
  return m ? parseInt(m[1], 10) : Number.MAX_SAFE_INTEGER;
}

export function applySort(list: TrackFile[], mode: SortOption): TrackFile[] {
  if (mode === 'default') return list;
  const copy = [...list];
  if (mode === 'title') return copy.sort((a, b) => cmp(a.title, b.title) || cmp(a.artist, b.artist));
  if (mode === 'artist') {
    return copy.sort((a, b) => {
      const ua = a.artist === UNKNOWN_ARTIST ? 1 : 0;
      const ub = b.artist === UNKNOWN_ARTIST ? 1 : 0;
      if (ua !== ub) return ua - ub; // «неизвестные» — в конец
      return cmp(a.artist, b.artist) || cmp(a.album || '', b.album || '') || trackNo(a) - trackNo(b) || cmp(a.title, b.title);
    });
  }
  // album: альбом → диск → номер трека
  return copy.sort((a, b) => {
    const c = cmp(a.album || 'Сингл', b.album || 'Сингл');
    if (c !== 0) return c;
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

export function matchesQuery(t: TrackFile, q: string): boolean {
  if (!q) return true;
  return (
    t.title.toLowerCase().includes(q) ||
    t.artist.toLowerCase().includes(q) ||
    (!!t.album && t.album.toLowerCase().includes(q)) ||
    t.filename.toLowerCase().includes(q)
  );
}
