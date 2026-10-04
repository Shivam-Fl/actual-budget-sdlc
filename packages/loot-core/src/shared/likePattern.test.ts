import { describe, expect, it } from 'vitest';

import { likePatternToRegex } from './likePattern';

describe('likePatternToRegex', () => {
  it('translates % to zero-or-more characters and ? to exactly one', () => {
    expect(likePatternToRegex('t%st').test('te123st')).toBe(true);
    expect(likePatternToRegex('t?st').test('test')).toBe(true);
    expect(likePatternToRegex('t?st').test('teest')).toBe(false);
  });

  it('matches case-insensitively', () => {
    expect(likePatternToRegex('food').test('FOOD')).toBe(true);
  });

  it('escapes regex metacharacters so they match literally', () => {
    // oxlint-disable-next-line no-template-curly-in-string
    expect(likePatternToRegex('.*+^${}()|[]\\').test('.*+^${}()|[]\\')).toBe(
      true,
    );
    expect(likePatternToRegex('a.c').test('abc')).toBe(false);
    expect(likePatternToRegex('a.c').test('a.c')).toBe(true);
    expect(likePatternToRegex('(x)').test('x')).toBe(false);
  });

  it('treats a backslash before % ? or \\ as an escape that consumes both', () => {
    expect(likePatternToRegex('100\\%').test('100%')).toBe(true);
    expect(likePatternToRegex('100\\%').test('1000')).toBe(false);
    expect(likePatternToRegex('c:\\\\test').test('c:\\test')).toBe(true);
  });

  it('leaves a lone backslash before anything else literal', () => {
    expect(likePatternToRegex('a\\b').test('a\\b')).toBe(true);
    // ...so the character after it is consumed as an ordinary one, not as a
    // wildcard: '\%' is an escaped percent, not 'anything'.
    expect(likePatternToRegex('a\\%b').test('a%b')).toBe(true);
    expect(likePatternToRegex('a\\%b').test('aZZb')).toBe(false);
  });

  it('matches every string for the pattern a bare contains builds', () => {
    // `contains` compiles to '%' + value + '%', so a value of '%' gives '%%%'.
    // This is why `Category contains %` selects every category on the data
    // side, and therefore every category on the row axis too.
    const bareWildcard = likePatternToRegex('%%%');

    expect(bareWildcard.test('Food')).toBe(true);
    expect(bareWildcard.test('Café')).toBe(true);
    expect(bareWildcard.test('')).toBe(true);
  });

  it('does NOT treat _ as a wildcard, contrary to SQL LIKE', () => {
    // Pinned on purpose. A QA report claimed '_' reproduced the same defect as
    // '%'; it does not. Only '%' and '?' are wildcards in this language, so
    // escaping '_' here would introduce a divergence where none exists.
    expect(likePatternToRegex('X_').test('CSharp')).toBe(false);
    expect(likePatternToRegex('X_').test('X_')).toBe(true);
    expect(likePatternToRegex('_%').test('C_Sharp')).toBe(true);
  });
});
