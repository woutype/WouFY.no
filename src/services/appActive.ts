import { useEffect, useState } from 'react';
import { AppState } from 'react-native';

/** Приложение на экране (не в фоне). В фоне интерфейс никто не видит — опросы позиции, анимации и тактильный отклик останавливаются (экономия батареи и нагрева). */
let active = AppState.currentState !== 'background';
const subs = new Set<(a: boolean) => void>();
AppState.addEventListener('change', (s) => {
  const a = s !== 'background';
  if (a === active) return;
  active = a;
  subs.forEach((f) => f(a));
});

export const isAppActive = () => active;
export function onAppActiveChange(fn: (a: boolean) => void): () => void {
  subs.add(fn);
  return () => {
    subs.delete(fn);
  };
}
export function useAppActive(): boolean {
  const [a, setA] = useState(active);
  useEffect(() => onAppActiveChange(setA), []);
  return a;
}
