import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  describeAuthor,
  findNonPersonAuthors,
  listNotePaths,
  parseReleaseNotes,
  sanitizeWorkflowCommandData,
  selectReleaseNotePaths,
} from './util.mjs';

/**
 * A notes directory holding one note at the top level and one a level down,
 * plus the two shapes that used to be filtered differently by each caller: a
 * README.md at the top level (excluded by both) and a nested sub/README.md
 * (excluded by neither, because only the top-level one is the README).
 */
const FIXTURE_NOTES = {
  'README.md': '# Upcoming release notes\n',
  'top.md': note('A top-level note'),
  'sub/README.md': note('A note that happens to be called README'),
  'sub/deep.md': note('A note published from a subdirectory'),
  'sub/notes.txt': 'Not a release note\n',
};

function note(body) {
  return `---\ncategory: Bugfixes\nauthors: [Shivam-Fl]\n---\n\n${body}\n`;
}

/**
 * Built under the system temporary directory rather than in the repository, so
 * an interrupted run cannot strand a fixture in the tree this suite shares with
 * every other run and every contributor.
 */
function createNotesFixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'release-notes-'));

  for (const [relative, contents] of Object.entries(FIXTURE_NOTES)) {
    const target = path.join(dir, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, contents);
  }

  return dir;
}

describe('listNotePaths', () => {
  let dir;

  beforeEach(() => {
    dir = createNotesFixture();
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('lists a top-level note and a nested one as relative forward-slashed paths', () => {
    // Relative to `dir`, not absolute: these strings are what a contributor
    // types into a shell, what the `only` filter is handed and what the gate
    // names a failure by.
    expect(listNotePaths(dir)).toEqual(
      expect.arrayContaining(['top.md', 'sub/deep.md']),
    );
    expect(listNotePaths(dir).every(note => !note.startsWith('/'))).toBe(true);
  });

  it("excludes a top-level README.md, includes sub/README.md, and skips a nested non-markdown file, matching selectReleaseNotePaths' rule", () => {
    // The exclusion is on the relative path, not the basename: only the
    // directory's own README is the directory's README, and selectReleaseNotePaths
    // drops only that one too.
    expect(listNotePaths(dir)).toEqual([
      'sub/README.md',
      'sub/deep.md',
      'top.md',
    ]);
    expect(listNotePaths(dir)).not.toContain('README.md');
    expect(listNotePaths(dir)).not.toContain('sub/notes.txt');
  });

  it('returns paths in the default sort order, so the report order does not shift with the filesystem or the host locale', () => {
    // `Array.prototype.sort` with no comparator, which compares UTF-16 code
    // units. `sub/README.md` before `sub/deep.md` is that order and not
    // alphabetical order, so this pins the behaviour down rather than restating
    // whichever sort happened to run.
    expect(listNotePaths(dir)).toEqual(
      [...listNotePaths(dir)].sort((a, b) => (a < b ? -1 : 1)),
    );
    expect(listNotePaths(dir)[0]).toBe('sub/README.md');
  });
});

describe('parseReleaseNotes', () => {
  let dir;

  beforeEach(() => {
    dir = createNotesFixture();
    // resolvePrNumber shells out to git with a path outside any repository; it
    // catches and returns null, logging a warning on the way. The warning is not
    // what this block is about, and its text is free to change.
    vi.spyOn(console, 'log').mockImplementation(() => null);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('with no `only` argument, parseReleaseNotes enumerates exactly what listNotePaths returns for the same directory', async () => {
    // The publisher calls the walk rather than re-implementing it, so the two
    // cannot disagree about which notes exist. Scoped to the no-`only` case on
    // purpose: with a filter, parseReleaseNotes is meant to return a subset.
    const { files } = await parseReleaseNotes(dir, 'actualbudget', 'actual');

    expect(files).toEqual(listNotePaths(dir));
  });

  it("publishes a nested note's body and category into notesByCategory", async () => {
    // The defect: a flat readdir dropped sub/deep.md, so a note the gate
    // validated, count-points counted and `git ls-tree -r` listed never reached
    // the changelog, credited to nobody.
    const { notesByCategory } = await parseReleaseNotes(
      dir,
      'actualbudget',
      'actual',
    );

    expect(notesByCategory.Bugfixes.join('\n')).toContain(
      'A note published from a subdirectory',
    );
  });

  it("filters on the relative path, so only = ['sub/deep.md'] selects the nested note alone", async () => {
    const { files } = await parseReleaseNotes(
      dir,
      'actualbudget',
      'actual',
      undefined,
      ['sub/deep.md'],
    );

    expect(files).toEqual(['sub/deep.md']);
  });

  it("does not match a nested note by its flat basename, so only = ['deep.md'] selects nothing", async () => {
    // release-notes-generate.mjs strips the directory prefix off its `git
    // ls-tree -r` allow-list, so the filter is handed relative paths. A flat
    // basename must not select a note it does not name.
    const { files } = await parseReleaseNotes(
      dir,
      'actualbudget',
      'actual',
      undefined,
      ['deep.md'],
    );

    expect(files).toEqual([]);
  });
});

describe('parseReleaseNotes on a note the gate would have rejected', () => {
  let dir;

  beforeEach(() => {
    dir = createNotesFixture();
    vi.spyOn(console, 'log').mockImplementation(() => null);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function writeNested(name, contents) {
    const target = path.join(dir, 'sub', name);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, contents);
  }

  it('rejects a nested note with no `authors` front matter, naming the file rather than dying on `Cannot read properties of undefined`', async () => {
    // The defect: `data.authors.map` with no guard, on a note the shared walk now
    // routes here. Before the walk reached subdirectories this was latent —
    // unreachable in practice, because the publisher only ever read top-level
    // files the gate had already cleared.
    writeNested(
      'noauthors.md',
      '---\ncategory: Bugfixes\n---\n\nNo authors key\n',
    );

    // Rejected, not skipped: release-notes-generate.mjs unlinks every entry of
    // the returned `files` array, and `files` comes from listNotePaths whether or
    // not the note parsed — so skipping this note would delete it from the tree
    // and it would never reach a changelog. Throwing aborts before that unlink.
    await expect(
      parseReleaseNotes(dir, 'actualbudget', 'actual'),
    ).rejects.toThrow(/sub\/noauthors\.md/);

    // The named error, not the TypeError: a message naming the file is what
    // tells a contributor which note to fix.
    await expect(
      parseReleaseNotes(dir, 'actualbudget', 'actual'),
    ).rejects.toThrow(/authors/);
  });

  it('rejects a note whose `authors` is a bare string instead of a list, the same way', async () => {
    // `authors: Shivam-Fl` parses to a string, which has no `.map` — a second
    // route to the same crash, and one the gate already names as "authors should
    // be a list".
    writeNested(
      'stringauthors.md',
      '---\ncategory: Bugfixes\nauthors: Shivam-Fl\n---\n\nString authors\n',
    );

    await expect(
      parseReleaseNotes(dir, 'actualbudget', 'actual'),
    ).rejects.toThrow(/sub\/stringauthors\.md/);
  });

  it('still publishes a note that has an authors list, so the guard is not satisfied by rejecting everything', async () => {
    // The control for the two above: the guard rejects a malformed list, not the
    // presence of the block. Every note in the shared fixture is well formed, so
    // publishing them all is the shape the release process depends on.
    const { files, notesByCategory } = await parseReleaseNotes(
      dir,
      'actualbudget',
      'actual',
    );

    expect(files).toEqual(listNotePaths(dir));
    expect(notesByCategory.Bugfixes).toHaveLength(3);
    expect(notesByCategory.Bugfixes.join('\n')).toContain('@Shivam-Fl');
  });
});

describe('listNotePaths with an onError callback', () => {
  let dir;

  beforeEach(() => {
    dir = createNotesFixture();
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  // root ignores the permission bits, so every case that needs a genuinely
  // unreadable directory has to skip rather than assert nothing.
  const itAsNonRoot = process.getuid && process.getuid() === 0 ? it.skip : it;

  itAsNonRoot(
    'reports an unreadable subdirectory and still returns every note outside it',
    () => {
      // The regression: catching the throw around the whole walk turned a partial
      // walk into a total one, so one unreadable subdirectory discarded every note
      // already read. The walk catches at the point of failure instead.
      const locked = path.join(dir, 'sub', 'locked');
      fs.mkdirSync(locked, { recursive: true });
      fs.chmodSync(locked, 0o000);

      const errors = [];

      try {
        const paths = listNotePaths(dir, (prefix, error) =>
          errors.push({ prefix, error }),
        );

        expect(errors).toHaveLength(1);
        // The prefix is the unreadable directory's own path relative to `dir`, so
        // the caller can name what it could not read rather than the root.
        expect(errors[0].prefix).toBe('sub/locked');
        expect(errors[0].error.code).toBe('EACCES');

        // The half that was the regression: top-level and readable nested notes
        // still come back in the same run.
        expect(paths).toEqual(
          expect.arrayContaining(['top.md', 'sub/deep.md', 'sub/README.md']),
        );
      } finally {
        fs.chmodSync(locked, 0o755);
      }
    },
  );

  it('throws on an unreadable directory when no callback is passed, preserving what the publisher relies on', () => {
    // parseReleaseNotes has no way to report and recover, so an unreadable
    // directory is an abort there. Making the walk always continue would turn a
    // loud failure into a silently shortened changelog.
    const locked = path.join(dir, 'sub', 'locked');
    fs.mkdirSync(locked, { recursive: true });
    fs.chmodSync(locked, 0o000);

    try {
      expect(() => listNotePaths(dir)).toThrow(/EACCES/);
    } finally {
      fs.chmodSync(locked, 0o755);
    }
  });
});

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
