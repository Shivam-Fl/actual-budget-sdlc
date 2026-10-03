import { describe, expect, it } from 'vitest';

import {
  findNonPersonAuthors,
  sanitizeWorkflowCommandData,
  selectReleaseNotePaths,
} from './util.mjs';

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

describe('selectReleaseNotePaths', () => {
  const dir = 'upcoming-release-notes';
  const select = output => selectReleaseNotePaths(output, dir);

  it('reads an added note as both added and changed', () => {
    expect(select(`A\t${dir}/add-note.md\n`)).toEqual({
      added: [`${dir}/add-note.md`],
      changed: [`${dir}/add-note.md`],
    });
  });

  it('reads an edited note as changed but not added', () => {
    expect(select(`M\t${dir}/old-note.md\n`)).toEqual({
      added: [],
      changed: [`${dir}/old-note.md`],
    });
  });

  it('validates the new path of a rename, not the old one', () => {
    // The old path no longer exists on HEAD, so validating it would trip the
    // "added but does not exist" guard instead of the author check.
    expect(select(`R100\t${dir}/seed.md\t${dir}/seed-renamed.md\n`)).toEqual({
      added: [],
      changed: [`${dir}/seed-renamed.md`],
    });
  });

  it('validates the new path of a copy', () => {
    expect(select(`C75\t${dir}/seed.md\t${dir}/seed-copy.md\n`)).toEqual({
      added: [],
      changed: [`${dir}/seed-copy.md`],
    });
  });

  it('does not count a rename as adding a note', () => {
    expect(
      select(`R100\t${dir}/seed.md\t${dir}/seed-renamed.md\n`).added,
    ).toEqual([]);
  });

  it('keeps the order git reported and separates added from the rest', () => {
    const output = [
      `A\t${dir}/newone.md`,
      `M\t${dir}/seed.md`,
      `R100\t${dir}/old.md\t${dir}/moved.md`,
      `D\t${dir}/gone.md`,
      '',
    ].join('\n');
    expect(select(output)).toEqual({
      added: [`${dir}/newone.md`],
      changed: [`${dir}/newone.md`, `${dir}/seed.md`, `${dir}/moved.md`],
    });
  });

  it('drops the README, non-markdown files and blank output', () => {
    expect(
      select(
        [`A\t${dir}/README.md`, `A\t${dir}/notes.txt`, '   ', ''].join('\n'),
      ),
    ).toEqual({ added: [], changed: [] });
  });

  it('keeps a non-ASCII filename once git is told not to quote it', () => {
    expect(select(`A\t${dir}/café-note.md\n`)).toEqual({
      added: [`${dir}/café-note.md`],
      changed: [`${dir}/café-note.md`],
    });
  });
});
