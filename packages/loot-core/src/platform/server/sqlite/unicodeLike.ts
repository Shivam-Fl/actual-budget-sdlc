import { LRUCache } from 'lru-cache';

import { likePatternToRegex } from '#shared/likePattern';

const likePatternCache = new LRUCache<string, RegExp>({ max: 500 });

export function unicodeLike(
  pattern: string | null,
  value: string | null,
): number {
  if (!pattern) return 0;
  if (!value) value = '';

  let cachedRegExp = likePatternCache.get(pattern);
  if (!cachedRegExp) {
    cachedRegExp = likePatternToRegex(pattern);
    likePatternCache.set(pattern, cachedRegExp);
  }

  return cachedRegExp.test(value) ? 1 : 0;
}
