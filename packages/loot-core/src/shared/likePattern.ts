/**
 * The single definition of the LIKE pattern language that `UNICODE_LIKE` speaks.
 *
 * Anything that must agree with `UNICODE_LIKE` — a rule evaluation, a report's
 * row axis — has to go through this function rather than reimplementing the
 * translation. The desktop client cannot reach the SQLite platform layer, which
 * is why the language lives here and `unicodeLike` delegates to it.
 *
 * Note what this language is NOT: it is not SQL LIKE, and `_` is not a wildcard
 * in it. Only `%` and `?` are, and a backslash escapes exactly those two plus a
 * literal backslash.
 */

export const REGEX_SPECIAL = /[.*+^${}()|[\]\\?]/g;

export function likePatternToRegex(pattern: string): RegExp {
  let regexStr = '';
  let i = 0;
  while (i < pattern.length) {
    const ch = pattern[i];
    if (ch === '\\' && i + 1 < pattern.length) {
      const next = pattern[i + 1];
      if (next === '%' || next === '?' || next === '\\') {
        // escaped wildcard — treat as literal character
        regexStr += next.replace(REGEX_SPECIAL, '\\$&'); // ? added here
        i += 2;
        continue;
      }
    }
    if (ch === '%') {
      regexStr += '.*';
    } else if (ch === '?') {
      regexStr += '.';
    } else {
      regexStr += ch.replace(REGEX_SPECIAL, '\\$&');
    }
    i++;
  }
  return new RegExp(regexStr, 'i');
}
