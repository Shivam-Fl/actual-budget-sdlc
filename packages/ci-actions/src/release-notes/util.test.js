import { describe, expect, it } from 'vitest';

import { findNonPersonAuthors } from './util.mjs';

describe('findNonPersonAuthors', () => {
  it('passes a real person', () => {
    expect(findNonPersonAuthors(['Shivam-Fl'])).toEqual([]);
  });

  it('rejects the bare agent name that shipped in two release notes', () => {
    expect(findNonPersonAuthors(['claude'])).toEqual(['claude']);
  });

  it('rejects the bare bot name', () => {
    expect(findNonPersonAuthors(['github-actions'])).toEqual([
      'github-actions',
    ]);
  });

  it('rejects any [bot] suffix, case-insensitively', () => {
    expect(findNonPersonAuthors(['dependabot[bot]'])).toEqual([
      'dependabot[bot]',
    ]);
    expect(findNonPersonAuthors(['some-bot[BOT]'])).toEqual(['some-bot[BOT]']);
  });

  it('rejects the suffixed form of a denylisted name without a separate entry', () => {
    expect(findNonPersonAuthors(['claude[bot]'])).toEqual(['claude[bot]']);
  });

  it('returns only the offenders from a mixed list, in input order', () => {
    expect(
      findNonPersonAuthors([
        'Shivam-Fl',
        'claude',
        'matt-fidd',
        'github-actions',
      ]),
    ).toEqual(['claude', 'github-actions']);
  });

  it('returns nothing for an empty list', () => {
    // A note still needs a non-empty authors list; that is enforced by the
    // missing/array checks in the check script, not here.
    expect(findNonPersonAuthors([])).toEqual([]);
  });
});
