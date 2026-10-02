import { describe, expect, it } from 'vitest';

import { findNonPersonAuthors, sanitizeWorkflowCommandData } from './util.mjs';

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
    // The helper has nothing to say about an empty list; validateFile rejects
    // one before it ever calls this.
    expect(findNonPersonAuthors([])).toEqual([]);
  });

  it('reports a number instead of throwing on it', () => {
    expect(findNonPersonAuthors([12345])).toEqual([12345]);
  });

  it('reports null and true instead of throwing on them', () => {
    expect(findNonPersonAuthors([null])).toEqual([null]);
    expect(findNonPersonAuthors([true])).toEqual([true]);
  });

  it('reports a nested list, which is valid YAML inside a flow sequence', () => {
    expect(findNonPersonAuthors([['claude']])).toEqual([['claude']]);
  });

  it('keeps people out and offenders in order from a mixed non-string list', () => {
    expect(findNonPersonAuthors(['Shivam-Fl', 12345, null, 'claude'])).toEqual([
      12345,
      null,
      'claude',
    ]);
  });

  it('never throws for any value a YAML flow sequence can hold', () => {
    expect(() =>
      findNonPersonAuthors(['ok', 1, 1.5, false, null, ['claude'], { a: 1 }]),
    ).not.toThrow();
  });
});

describe('sanitizeWorkflowCommandData', () => {
  it('collapses a newline so a value cannot start a new workflow command', () => {
    const sanitized = sanitizeWorkflowCommandData('innocent\n::add-mask::X');
    expect(sanitized).toBe('innocent%0A::add-mask::X');
    expect(sanitized).not.toContain('\n');
  });

  it('does not let an already-escaped-looking value become a real newline', () => {
    const sanitized = sanitizeWorkflowCommandData('a%0Ab');
    expect(sanitized).toBe('a%250Ab');
    expect(sanitized).not.toContain('\n');
  });

  it('escapes CR the same way, and leaves an ordinary value untouched', () => {
    expect(sanitizeWorkflowCommandData('a\rb')).toBe('a%0Db');
    expect(sanitizeWorkflowCommandData('claude, github-actions')).toBe(
      'claude, github-actions',
    );
    expect(
      sanitizeWorkflowCommandData('upcoming-release-notes/add-note.md'),
    ).toBe('upcoming-release-notes/add-note.md');
    expect(sanitizeWorkflowCommandData('50% off')).toBe('50%25 off');
  });
});
