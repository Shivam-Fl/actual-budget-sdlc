import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { describeFailure, parseNote, readReadme } from './failures.mjs';

const NOTES_DIR = 'upcoming-release-notes';
const scriptPath = new URL('../../bin/release-notes-check.mjs', import.meta.url)
  .pathname;

const temporaries = [];

afterEach(() => {
  while (temporaries.length > 0) {
    fs.rmSync(temporaries.pop(), { force: true, recursive: true });
  }
});

function tempDir() {
  const dir = fs.mkdtempSync(join(os.tmpdir(), 'release-notes-'));
  temporaries.push(dir);
  return dir;
}

/**
 * The identity every sandbox commit is made under.
 *
 * CI has no global git identity, and a commit without one fails outright — so
 * the same four variables that make a GitHub Actions checkout committable are
 * set here rather than left to whatever the machine happens to have configured.
 */
const GIT_ENV = {
  GIT_AUTHOR_NAME: 'Release Notes Test',
  GIT_AUTHOR_EMAIL: 'release-notes@example.com',
  GIT_COMMITTER_NAME: 'Release Notes Test',
  GIT_COMMITTER_EMAIL: 'release-notes@example.com',
};

/**
 * Runs git in `cwd`, failing the test on anything but a clean exit.
 *
 * Every command names its branch explicitly rather than relying on a default,
 * because git's initial-branch name is configurable and this suite must not
 * depend on the runner's answer to that.
 */
function git(cwd, ...args) {
  const result = spawnSync('git', args, {
    cwd,
    encoding: 'utf-8',
    env: { ...process.env, ...GIT_ENV },
  });
  if (result.status !== 0) {
    throw new Error(
      `git ${args.join(' ')} exited ${result.status}: ${result.stderr}`,
    );
  }
  return result.stdout;
}

/**
 * Builds a repository shaped the way the check runs against one: a bare remote,
 * a clone whose `origin` is that remote, and a `base` branch holding a notes
 * directory — which is also what Actions populates BASE_REF from, a branch name
 * rather than a revision.
 *
 * The tag exists because a tag is the one ref git can fetch and still not
 * resolve as `origin/<ref>`, which is what the first spawn case needs.
 */
function buildSandbox() {
  const root = tempDir();
  const remote = join(root, 'remote.git');
  git(root, 'init', '--bare', remote);

  const work = join(root, 'work');
  git(root, 'clone', remote, work);

  fs.mkdirSync(join(work, NOTES_DIR));
  fs.writeFileSync(
    join(work, NOTES_DIR, 'README.md'),
    '# Release notes\n\nOne file per change.\n',
  );
  fs.writeFileSync(
    join(work, NOTES_DIR, 'seed.md'),
    '---\ncategory: Bugfix\nauthors: [Shivam-Fl]\n---\n\nAn earlier change\n',
  );
  git(work, 'checkout', '-b', 'base');
  // Explicit paths, never `-A`: the sandbox is its own worktree, and an add-all
  // here would still be staging whatever the runner left behind.
  git(work, 'add', `${NOTES_DIR}/README.md`, `${NOTES_DIR}/seed.md`);
  gitCommit(work, 'Seed the notes directory');
  git(work, 'push', 'origin', 'base');
  git(work, 'tag', 'qa-tag-1');
  git(work, 'push', 'origin', 'qa-tag-1');

  return work;
}

function gitCommit(cwd, message) {
  return git(cwd, 'commit', '-m', message);
}

/**
 * Runs the real gate against a sandbox, and hands back everything the
 * assertions below read.
 *
 * `GITHUB_STEP_SUMMARY` is unset because the runner supplies it and a local run
 * does not: leaving it set would write a file into the sandbox that no
 * assertion looks at, and unset is the stricter path — it is the one on which
 * the README notice has to drain through a pipe instead.
 */
function runGate(work, baseRef) {
  return spawnSync(process.execPath, [scriptPath], {
    cwd: work,
    env: {
      ...process.env,
      ...GIT_ENV,
      BASE_REF: baseRef,
      GITHUB_STEP_SUMMARY: undefined,
    },
    encoding: 'utf-8',
  });
}

function errorLines(result) {
  return result.stdout.split('\n').filter(line => line.startsWith('::error::'));
}

describe('describeFailure', () => {
  it('names the subcommand and exit code of a failed git call, not the command line', () => {
    // Shaped exactly as promisify(execFile) rejects it: `cmd`, `code` and
    // `stderr` are own properties, and `message` is a 160-character echo of
    // the invocation that names neither the step nor its status.
    const rejection = Object.assign(
      new Error(
        "Command failed: git diff\nfatal: bad revision 'origin/qa-tag-1...HEAD'\n",
      ),
      {
        cmd: 'git diff --name-status -z --diff-filter=AMR origin/qa-tag-1...HEAD -- upcoming-release-notes/',
        code: 128,
        stderr: "fatal: bad revision 'origin/qa-tag-1...HEAD'\n",
      },
    );

    const described = describeFailure(rejection);

    expect(described).toBe(
      "git diff failed with exit 128: fatal: bad revision 'origin/qa-tag-1...HEAD'",
    );
    expect(described).not.toContain('\n');
    expect(described).not.toContain('--diff-filter');
  });

  it('returns the message of a plain Error', () => {
    expect(describeFailure(new Error('something specific went wrong'))).toBe(
      'something specific went wrong',
    );
  });

  it('describes a throw that is not an Error at all', () => {
    // The boundary's own formatter is the last thing standing between a failure
    // and the process, so reading `.message` off a thrown string or a thrown
    // null must not become the crash it was reached to report.
    expect(describeFailure('just a string')).toBe('just a string');
    expect(describeFailure(undefined)).toBe('undefined');
  });

  it('keeps a failed non-git command verbatim rather than guessing a subcommand', () => {
    const rejection = Object.assign(new Error('Command failed'), {
      cmd: 'hg diff --name-status',
      code: 1,
      stderr: 'abort: no such revision\n',
    });

    expect(describeFailure(rejection)).toBe(
      'hg diff --name-status failed with exit 1: abort: no such revision',
    );
  });
});

describe('readReadme', () => {
  it('returns the file contents', () => {
    const dir = tempDir();
    fs.writeFileSync(join(dir, 'README.md'), '# Release notes\n');

    expect(readReadme(join(dir, 'README.md'))).toBe('# Release notes\n');
  });

  it('returns an empty string when the path is a directory', () => {
    // The third instance of this bug class: the error reporter reads the README
    // on its way out of an error, so a PR that replaces README.md with a
    // directory made the reporter itself throw — EISDIR, out of the function
    // whose contract is to report rather than throw. A missing file has always
    // degraded to an empty notice, and a directory now does the same.
    const dir = tempDir();
    fs.mkdirSync(join(dir, 'README.md'));
    fs.writeFileSync(join(dir, 'README.md', 'decoy'), '');

    expect(readReadme(join(dir, 'README.md'))).toBe('');
  });

  it('returns an empty string when the file does not exist', () => {
    expect(readReadme(join(tempDir(), 'absent.md'))).toBe('');
  });
});

describe('parseNote', () => {
  it('rejects front matter that is not well-formed YAML, carrying the reason', () => {
    const dir = tempDir();
    fs.writeFileSync(
      join(dir, 'broken.md'),
      '---\ncategory: [unclosed\nauthors: alice\n---\n\nBroken\n',
    );

    const parsed = parseNote(join(dir, 'broken.md'));

    expect(parsed.ok).toBe(false);
    expect(parsed.message).toContain(
      'missed comma between flow collection entries',
    );
    // The reason only, not js-yaml's echo of the offending line — this lands in
    // a one-line annotation.
    expect(parsed.message).not.toContain('\n');
  });

  it('returns the parsed note when the front matter is well-formed', () => {
    // The guard above this one could swallow a valid note along with an invalid
    // one, and every ordinary verdict would still pass; this is what holds it
    // to passing the bytes through untouched.
    const dir = tempDir();
    fs.writeFileSync(
      join(dir, 'good.md'),
      '---\ncategory: Bugfix\nauthors: [Shivam-Fl]\n---\n\nOne line of body\n',
    );

    expect(parseNote(join(dir, 'good.md'))).toEqual({
      ok: true,
      data: { category: 'Bugfix', authors: ['Shivam-Fl'] },
      content: '\nOne line of body\n',
    });
  });

  it('reports a missing note rather than throwing', () => {
    const parsed = parseNote(join(tempDir(), 'absent.md'));

    expect(parsed.ok).toBe(false);
    expect(parsed.message).toContain('ENOENT');
  });
});

describe('the gate under bin/', () => {
  it('reports a git call that fails instead of dying on an unhandled rejection', () => {
    // BASE_REF is a tag: `git fetch origin qa-tag-1` succeeds, and `git diff
    // origin/qa-tag-1...HEAD` is what fails, on a ref that does not exist in
    // that form. Before the boundary this produced zero `::error::` lines and a
    // six-frame stack on stderr, which is the shape this case exists to hold.
    const result = runGate(buildSandbox(), 'qa-tag-1');

    expect(result.status).toBe(1);
    expect(errorLines(result).length).toBeGreaterThan(0);
    expect(errorLines(result).join('\n')).toContain('qa-tag-1');
    expect(result.stderr).toBe('');
  });

  it('names the note whose front matter will not parse', () => {
    // The boundary alone would satisfy the first three assertions below — a
    // boundary turns this throw into a clean `Release notes check failed:
    // missed comma...` with an empty stderr and exit 1. So they prove nothing
    // about the parse guard in `validateFile`, and this fourth one is what
    // does: only the call site knows which of the branch's files is the broken
    // one, so an annotation that names no file is the boundary talking, and
    // removing the call site is caught here.
    const work = buildSandbox();
    git(work, 'checkout', '-b', 'broken');
    fs.writeFileSync(
      join(work, NOTES_DIR, 'broken.md'),
      '---\ncategory: [unclosed\nauthors: alice\n---\n\nBroken\n',
    );
    git(work, 'add', `${NOTES_DIR}/broken.md`);
    gitCommit(work, 'Add a note with malformed front matter');

    const result = runGate(work, 'base');

    expect(result.status).toBe(1);
    expect(errorLines(result).length).toBeGreaterThan(0);
    expect(result.stderr).toBe('');
    expect(errorLines(result).join('\n')).toContain('broken.md');
  });
});
