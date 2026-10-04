import { describe, expect, it } from 'vitest';

import {
  describeAuthor,
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

describe('describeAuthor', () => {
  it('passes a real author through unchanged', () => {
    expect(describeAuthor('Shivam-Fl')).toBe('Shivam-Fl');
  });

  it('renders the non-string shapes a YAML flow sequence can hold as JSON', () => {
    // Byte-identical to the inline ternary this replaced, so the ordinary
    // offenders an author has to fix still read the way they used to.
    expect(describeAuthor(12345)).toBe('12345');
    expect(describeAuthor(1.5)).toBe('1.5');
    expect(describeAuthor(null)).toBe('null');
    expect(describeAuthor(true)).toBe('true');
    expect(describeAuthor({})).toBe('{}');
    expect(describeAuthor(['claude'])).toBe('["claude"]');
  });

  it('renders a self-referential array instead of throwing', () => {
    // `authors: &a [*a]` makes the offender a cycle, which JSON.stringify
    // refuses. The gate has to name it, not crash on the way to the message.
    const selfReferential = [];
    selfReferential.push(selfReferential);
    expect(describeAuthor(selfReferential)).toBe('[object Array]');
  });

  it('renders a self-referential object instead of throwing', () => {
    // `authors: &a [{k: *a}]` cycles through an object rather than an array,
    // which is a distinct shape from the list above.
    const selfReferential = {};
    selfReferential.k = selfReferential;
    expect(describeAuthor(selfReferential)).toBe('[object Object]');
  });

  it('renders undefined as a non-empty string, naming nothing otherwise', () => {
    // JSON.stringify(undefined) returns undefined rather than throwing, so a
    // bare `??` is what keeps the error message from naming an empty author.
    expect(describeAuthor(undefined)).toBe('[object Undefined]');
  });

  it('renders the values JSON.stringify refuses outright', () => {
    expect(describeAuthor(10n)).toBe('[object BigInt]');
    expect(describeAuthor(Symbol('claude'))).toBe('[object Symbol]');
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
    expect(select(`A\0${dir}/add-note.md\0`)).toEqual({
      added: [`${dir}/add-note.md`],
      changed: [`${dir}/add-note.md`],
    });
  });

  // This is the invariant bin/release-notes-check.mjs's emptiness guard rests
  // on: it has to test `changed`, because the validation loop below walks that.
  it('reads an edited note as changed but not added', () => {
    expect(select(`M\0${dir}/old-note.md\0`)).toEqual({
      added: [],
      changed: [`${dir}/old-note.md`],
    });
  });

  it('validates the new path of a rename, not the old one', () => {
    // The old path no longer exists on HEAD, so validating it would trip the
    // "added but does not exist" guard instead of the author check.
    expect(select(`R100\0${dir}/seed.md\0${dir}/seed-renamed.md\0`)).toEqual({
      added: [],
      changed: [`${dir}/seed-renamed.md`],
    });
  });

  it('does not count a rename as adding a note', () => {
    expect(
      select(`R100\0${dir}/seed.md\0${dir}/seed-renamed.md\0`).added,
    ).toEqual([]);
  });

  it('keeps the order git reported and separates added from the rest', () => {
    // The deletion is here to prove D rows are still filtered, which under a
    // field-consuming parser means consuming its single path field anyway.
    const output = [
      `A\0${dir}/newone.md\0`,
      `M\0${dir}/seed.md\0`,
      `R100\0${dir}/old.md\0${dir}/moved.md\0`,
      `D\0${dir}/gone.md\0`,
    ].join('');
    expect(select(output)).toEqual({
      added: [`${dir}/newone.md`],
      changed: [`${dir}/newone.md`, `${dir}/seed.md`, `${dir}/moved.md`],
    });
  });

  it('drops the README, non-markdown files and blank output', () => {
    expect(
      select(
        [`A\0${dir}/README.md\0`, `A\0${dir}/notes.txt\0`, '   ', ''].join(''),
      ),
    ).toEqual({ added: [], changed: [] });
  });

  it('excludes the README and non-markdown paths from added as well', () => {
    // Both lists must be filtered, or a README-only edit satisfies the "did
    // this branch add a note?" check and is then validated as a note.
    const output = [
      `A\0${dir}/README.md\0`,
      `A\0${dir}/notes.txt\0`,
      `A\0${dir}/real-note.md\0`,
    ].join('');
    expect(select(output)).toEqual({
      added: [`${dir}/real-note.md`],
      changed: [`${dir}/real-note.md`],
    });
  });

  it('selects a non-ASCII filename verbatim, with no quoting flag involved', () => {
    expect(select(`A\0${dir}/café-note.md\0`)).toEqual({
      added: [`${dir}/café-note.md`],
      changed: [`${dir}/café-note.md`],
    });
  });

  it('selects a filename containing a double quote verbatim', () => {
    // git quotes and escapes this path without -z; the tab-separated parse used
    // to split it and read the branch as "No release note added".
    expect(select(`A\0${dir}/has"quote.md\0`)).toEqual({
      added: [`${dir}/has"quote.md`],
      changed: [`${dir}/has"quote.md`],
    });
  });

  it('selects a filename containing a literal tab verbatim', () => {
    expect(select(`A\0${dir}/tab\there.md\0`)).toEqual({
      added: [`${dir}/tab\there.md`],
      changed: [`${dir}/tab\there.md`],
    });
  });

  it('selects a filename containing a newline verbatim', () => {
    expect(select(`A\0${dir}/nl\nname.md\0`)).toEqual({
      added: [`${dir}/nl\nname.md`],
      changed: [`${dir}/nl\nname.md`],
    });
  });
});
