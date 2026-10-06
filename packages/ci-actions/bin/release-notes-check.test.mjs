import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import { createRequire } from 'node:module';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { collectFailures, listNotePaths } from './release-notes-gate.mjs';

const exec = promisify(execFile);

// lage.config.js and this package's package.json are CommonJS; the suite is ESM.
const require = createRequire(import.meta.url);

// Driven as a subprocess against a real repository, because the defect is
// which key the script destructures from selectReleaseNotePaths - a unit test of
// the parser can only prove the parser is right, and it already was.
const SCRIPT_PATH = fileURLToPath(
  new URL('./release-notes-check.mjs', import.meta.url),
);

const BASE_BRANCH = 'base';
const NOTES_DIR = 'upcoming-release-notes';

function releaseNote({ category = 'Bugfixes', authors = 'Shivam-Fl', body }) {
  return `---\ncategory: ${category}\nauthors: [${authors}]\n---\n\n${body}\n`;
}

/**
 * A throwaway repository with a local bare origin, since the script resolves
 * its base ref against a remote rather than a local branch.
 */
async function createRepo() {
  const root = await fs.promises.mkdtemp(
    path.join(os.tmpdir(), 'release-notes-check-'),
  );
  const dir = path.join(root, 'work');
  const git = (...args) => exec('git', args, { cwd: dir });

  await fs.promises.mkdir(path.join(dir, NOTES_DIR), { recursive: true });
  await fs.promises.writeFile(path.join(dir, NOTES_DIR, '.gitkeep'), '');

  await git('init', '--quiet', '--initial-branch', BASE_BRANCH);
  await git('config', 'user.name', 'Release Notes Check');
  await git('config', 'user.email', 'release-notes@example.invalid');

  const origin = path.join(root, 'origin.git');
  await git('init', '--quiet', '--bare', origin);
  await git('remote', 'add', 'origin', origin);

  const repo = {
    root,
    dir,
    git,
    writeNote: (name, contents) =>
      fs.promises.writeFile(path.join(dir, NOTES_DIR, name), contents),
    writeFile: (relativePath, contents) =>
      fs.promises.writeFile(path.join(dir, relativePath), contents),
    commit: async message => {
      await git('add', '--all');
      await git('commit', '--quiet', '-m', message);
    },
    push: () => git('push', '--quiet', 'origin', BASE_BRANCH),
    startBranch: () => git('checkout', '--quiet', '-b', 'feature'),
  };

  // The base branch has to exist on the remote before the script can fetch it,
  // and it has to hold whatever the branch under test will later edit.
  await repo.commit('base');
  await repo.push();

  return repo;
}

/**
 * `overrides` is applied AFTER the BASE_REF injection above, and an undefined
 * value DELETES the key rather than being stringified into it. Node's execFile
 * omits undefined-valued env entries entirely, so the deletion reaches the child
 * as an absence.
 *
 * The order is the whole point. Applied before the BASE_REF injection, a
 * `BASE_REF: undefined` override would be overwritten by the line above and the
 * child would still have a base ref — which is exactly the state in which the
 * script's reportError does not stop at the missing-notes-directory guard, so the
 * case asserting that it does would pass vacuously.
 */
async function runCheck(dir, overrides = {}) {
  const env = { ...process.env, BASE_REF: BASE_BRANCH };
  // reportError reaches its exit without a step summary, which is the path a
  // local run takes; unset so a failure takes the exit-1 path CI would. A case
  // that needs the runner's shape sets it back through `overrides` below.
  delete env.GITHUB_STEP_SUMMARY;

  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) {
      delete env[key];
    } else {
      env[key] = value;
    }
  }

  try {
    const { stdout } = await exec(process.execPath, [SCRIPT_PATH], {
      cwd: dir,
      env,
    });
    return { code: 0, stdout };
  } catch (error) {
    return { code: error.code, stdout: error.stdout };
  }
}

describe('release-notes-check', () => {
  const repos = [];

  async function setup() {
    const repo = await createRepo();
    repos.push(repo);
    return repo;
  }

  afterEach(async () => {
    await Promise.all(
      repos
        .splice(0)
        .map(repo =>
          fs.promises.rm(repo.root, { recursive: true, force: true }),
        ),
    );
  });

  it('accepts a diff that only edits an existing valid note', async () => {
    const repo = await setup();
    await repo.writeNote('seed.md', releaseNote({ body: 'The original body' }));
    await repo.commit('add a release note');
    await repo.push();

    await repo.startBranch();
    await repo.writeNote('seed.md', releaseNote({ body: 'The edited body' }));
    await repo.commit('edit the release note');

    const { code, stdout } = await runCheck(repo.dir);

    expect(code).toBe(0);
    expect(stdout).toContain('Validated 1 release note(s)');
  });

  it('still refuses a diff that touches nothing under upcoming-release-notes', async () => {
    const repo = await setup();
    await repo.startBranch();
    await repo.writeFile('README.md', '# Unrelated change\n');
    await repo.commit('change something else');

    const { code, stdout } = await runCheck(repo.dir);

    expect(code).toBe(1);
    expect(stdout).toContain(
      '::error::No release note added or modified under upcoming-release-notes/.',
    );
  });

  it('validates an edited note, not just an added one', async () => {
    // The whole point of widening the guard: before it, this diff was refused
    // for having added nothing, so the note was never checked at all.
    const repo = await setup();
    await repo.writeNote('seed.md', releaseNote({ body: 'The original body' }));
    await repo.commit('add a release note');
    await repo.push();

    await repo.startBranch();
    await repo.writeNote(
      'seed.md',
      releaseNote({ authors: 'claude', body: 'The edited body' }),
    );
    await repo.commit('edit the note and credit a bot');

    const { code, stdout } = await runCheck(repo.dir);

    expect(code).toBe(1);
    expect(stdout).toContain('not bots or agents: claude');
  });

  it('still refuses an added note whose body is two lines', async () => {
    const repo = await setup();
    await repo.startBranch();
    await repo.writeNote(
      'two-lines.md',
      releaseNote({ body: 'First line\nSecond line' }),
    );
    await repo.commit('add a two-line note');

    const { code, stdout } = await runCheck(repo.dir);

    expect(code).toBe(1);
    expect(stdout).toContain('body should contain exactly one line');
  });

  it('still refuses an added note crediting a bot', async () => {
    const repo = await setup();
    await repo.startBranch();
    await repo.writeNote(
      'bot.md',
      releaseNote({ authors: 'github-actions', body: 'Automated change' }),
    );
    await repo.commit('add a note crediting a bot');

    const { code, stdout } = await runCheck(repo.dir);

    expect(code).toBe(1);
    expect(stdout).toContain('not bots or agents: github-actions');
  });

  it('still refuses an added note in an unknown category', async () => {
    const repo = await setup();
    await repo.startBranch();
    await repo.writeNote(
      'unknown.md',
      releaseNote({ category: 'Nope', body: 'Misfiled change' }),
    );
    await repo.commit('add a miscategorised note');

    const { code, stdout } = await runCheck(repo.dir);

    expect(code).toBe(1);
    expect(stdout).toContain('category "Nope" is not one of');
  });

  it('reports a missing upcoming-release-notes/ as one error line and exits 1, not a stack trace', async () => {
    const repo = await setup();
    await fs.promises.rm(path.join(repo.dir, NOTES_DIR), {
      recursive: true,
      force: true,
    });

    const { code, stdout } = await runCheck(repo.dir);

    expect(code).toBe(1);
    // Only the prefix: the ENOENT text after it varies by platform, and a
    // stack trace reaching the log is the defect this covers.
    expect(stdout).toContain('::error::Cannot read upcoming-release-notes/: ');
    expect(stdout).not.toContain('ENOENT: no such file or directory, realpath');
  });

  it('halts at the missing-notes-directory guard with GITHUB_STEP_SUMMARY set, as a runner has it', async () => {
    // The other half of the guard above, and the half this harness hid: the
    // script's reportError reached its exit only through the step summary, so
    // with one set — which is every real Actions run, and the environment this
    // suite deleted by default — it returned instead of exiting, and the
    // module-scope call above carried on into the BASE_REF check and printed a
    // second error over the first.
    const repo = await setup();
    await fs.promises.rm(path.join(repo.dir, NOTES_DIR), {
      recursive: true,
      force: true,
    });
    const summary = path.join(repo.root, 'step-summary.md');

    const { code, stdout } = await runCheck(repo.dir, {
      GITHUB_STEP_SUMMARY: summary,
      // Must be deleted, not stringified. With BASE_REF left set by this helper
      // the script finds its base ref, so the guard's own line is the only
      // failure reported and this case passes against the unfixed script —
      // vacuously. Measured both ways: 92 passed with it set, 1 failed here.
      BASE_REF: undefined,
    });

    expect(code).toBe(1);
    expect(stdout).toContain('::error::Cannot read upcoming-release-notes/: ');
    // The symptom, stated as an absence: the run stopped at the guard rather
    // than reporting an unrelated second failure over it.
    expect(stdout).not.toContain('BASE_REF env var is not set');
  });
});

// The cases above are driven against throwaway repositories, because a diff is
// the only way to control which paths the script sees and that is what the
// script's own defect was about. But no workflow runs that script over the notes
// this repository actually ships — the release-notes action exists and nothing
// references it — so the file a release note is made of had no gate at all. This
// block is that gate: the same rules, over the real directory, on every run of
// the unit suite.
//
// It goes through util.mjs rather than importing validateFile() from the script,
// because the script executes its git-diff IIFE at module load.
//
// It reads the whole directory rather than one note's exact bytes on purpose:
// rewording a release note is routine and must not fail a test, while breaking
// the published-changelog rules must.
//
// The rules and the walk live in release-notes-gate.mjs rather than here, so the
// gate CI runs and the gate this suite runs cannot drift apart — which is exactly
// how the two shipped: the walk below used to be a single non-recursive
// readdirSync while the checker selected nested notes through its diff.
describe('the real upcoming-release-notes/ directory', () => {
  const NOTES_DIR = fileURLToPath(
    new URL('../../../upcoming-release-notes', import.meta.url),
  );

  it('contains release notes to check', () => {
    // A moved or mis-resolved NOTES_DIR would make the rule case below pass
    // vacuously, so the set it reads is asserted to be non-empty first.
    expect(listNotePaths().length).toBeGreaterThan(0);
  });

  it('every note carries a category the published changelog has a header for', () => {
    expect(collectFailures()).toEqual([]);
  });

  it('holds a note in a subdirectory to the same rules', () => {
    // Reproduces the defect this file shipped with: the publisher walked one
    // level deep, so a nested note broke every rule and the gate still exited 0
    // — while the release-notes checker selected it through its diff,
    // count-points.mjs counted it under `upcoming-release-notes/**/*` and the
    // changelog generator listed it with `git ls-tree -r`. Nothing may treat a
    // subdirectory as out of scope, and the path is named with forward slashes
    // because that is what a contributor types into a shell and what the gate has
    // to name for them to find it.
    //
    // The fixture lives in the system temporary directory, not in the notes
    // directory this suite also reads: a vitest killed between the write and the
    // cleanup used to leave `qa-nested/` behind, where it fails every later run.
    const fixtureDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'release-notes-gate-'),
    );

    try {
      const nested = path.join(fixtureDir, 'qa-nested');
      fs.mkdirSync(nested, { recursive: true });
      fs.writeFileSync(
        path.join(nested, 'bad-note.md'),
        releaseNote({
          category: 'Chore',
          authors: 'github-actions',
          body: 'An automated change nobody should be thanked for',
        }),
      );

      expect(collectFailures(fixtureDir)).toEqual(
        expect.arrayContaining([
          expect.stringMatching(/^qa-nested\/bad-note\.md category "/),
          'qa-nested/bad-note.md authors are not people: github-actions',
        ]),
      );
    } finally {
      fs.rmSync(fixtureDir, { recursive: true, force: true });
    }
  });

  it('leaves no qa-nested directory in the real upcoming-release-notes/', () => {
    // The property the case above is written to hold: the suite writes nothing
    // inside the repository, so there is nothing for an interrupted run to
    // strand and nothing for a later run to trip over.
    expect(fs.existsSync(path.join(NOTES_DIR, 'qa-nested'))).toBe(false);
  });

  it('reports a directory it cannot read as one failure string naming that path, instead of throwing', () => {
    const missing = path.join(os.tmpdir(), 'release-notes-gate-does-not-exist');

    // Reported rather than thrown: the caller prints failure strings as
    // `::error::` lines before exiting 1, so a missing directory should reach
    // the log the same way a broken note does instead of as a stack trace.
    const failures = collectFailures(missing);

    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain(`cannot read ${missing}: `);
  });

  // root ignores the permission bits, so a chmod-000 directory is readable to it
  // and every case that needs a genuinely unreadable one has to skip rather than
  // assert nothing.
  const itAsNonRoot =
    typeof process.getuid === 'function' && process.getuid() === 0
      ? it.skip
      : it;

  /**
   * A notes directory holding one chmod-000 subdirectory plus whatever `notes`
   * describes, handed to `run` as (dir, lockedPath), with the permissions
   * restored in a finally so the fixture can be removed on every path out.
   */
  function withLockedSubdirectory(notes, run) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'release-notes-locked-'));
    const locked = path.join(dir, 'subdir', 'locked');

    fs.mkdirSync(locked, { recursive: true });
    for (const [relative, contents] of Object.entries(notes)) {
      const target = path.join(dir, relative);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, contents);
    }
    fs.chmodSync(locked, 0o000);

    try {
      return run(dir, locked);
    } finally {
      fs.chmodSync(locked, 0o755);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  itAsNonRoot(
    'reports an unreadable subdirectory alongside the failures of the notes outside it',
    () => {
      // The regression: the try/catch wrapped the entire walk, so a throw at depth
      // one discarded every note already read. A contributor who fixed the
      // unreadable directory and re-ran would meet this broken note's two
      // failures for the first time.
      const failures = withLockedSubdirectory(
        {
          'zzz-broken.md': releaseNote({
            category: 'Nope',
            authors: 'github-actions',
            body: 'Broken in two ways',
          }),
        },
        dir => collectFailures(dir),
      );

      expect(failures).toHaveLength(3);
      const [unreadable, ...noteFailures] = failures;
      // The unreadable subdirectory is named as itself rather than as the root
      // it sits under: "cannot read <notes dir>" would send a contributor looking
      // in the wrong place for a directory whose siblings are right there.
      expect(unreadable).toContain(`${path.sep}subdir${path.sep}locked: `);
      expect(unreadable).toContain('EACCES');
      expect(noteFailures).toEqual([
        expect.stringMatching(/^zzz-broken\.md category "Nope" is not one of/),
        'zzz-broken.md authors are not people: github-actions',
      ]);
    },
  );

  itAsNonRoot(
    'prints exactly one line for an unreadable subdirectory when every other note is clean',
    () => {
      // What AC-3's and AC-10's shared scoping clause predicts, asserted as a
      // count rather than assumed: one 'cannot read' entry for the subdirectory,
      // and zero entries from the clean notes outside it.
      const failures = withLockedSubdirectory(
        {
          'top.md': releaseNote({ body: 'A valid note' }),
          'sub/deep.md': releaseNote({ body: 'Another valid note' }),
        },
        dir => collectFailures(dir),
      );

      expect(failures).toHaveLength(1);
      expect(failures[0]).toContain('cannot read ');
    },
  );

  itAsNonRoot(
    'orders unreadable directories the same way whatever order they were created in',
    () => {
      // The unreadable entries arrive in readdir order, which is the filesystem's
      // and not ours, so they are sorted the way the walk's own paths are. Two
      // runs over the same names created in opposite orders must report
      // identically, or the report order shifts between contributors' machines.
      const readBack = order => {
        const dir = fs.mkdtempSync(
          path.join(os.tmpdir(), 'release-notes-order-'),
        );
        const locked = order.map(name => {
          const target = path.join(dir, name);
          fs.mkdirSync(target, { recursive: true });
          fs.chmodSync(target, 0o000);
          return target;
        });

        try {
          return (
            collectFailures(dir)
              .filter(failure => failure.startsWith('cannot read '))
              // The directory's own name, so two runs over different temporary
              // directories are comparable.
              .map(failure => path.basename(failure.split(':')[0]))
          );
        } finally {
          for (const target of locked) {
            fs.chmodSync(target, 0o755);
          }
          fs.rmSync(dir, { recursive: true, force: true });
        }
      };

      const ba = readBack(['b', 'a']);
      const ab = readBack(['a', 'b']);

      expect(ba).toHaveLength(2);
      expect(ba).toEqual(ab);
      // And it is the sort order rather than the creation order, which is what
      // makes the report identical on two contributors' machines.
      expect(ba).toEqual(['a', 'b']);
    },
  );

  it('is reachable on every run, not only on a cold cache', () => {
    // Reproduces the other defect: the gate lived inside lage's cached `test`
    // task, and upcoming-release-notes/ is outside every workspace package, so no
    // note can enter that task's hash. A note-only change left the key identical,
    // lage printed `» skip @actual-app/ci-actions test` and exited 0 on bytes
    // vitest rejects — a no-op on precisely the change it exists to police. What a
    // unit test can see is the wiring, so that is what this asserts; AC-6 is the
    // live behaviour.
    // Resolved through new URL rather than a '../../..' specifier, both because
    // the notes dir above already is and because the boundaries rule forbids
    // backtracked specifiers — and a package.json "imports" entry cannot reach
    // here, since its targets are not allowed to escape the package root.
    const config = require(
      fileURLToPath(new URL('../../../lage.config.js', import.meta.url)),
    );
    const pkg = require(
      fileURLToPath(new URL('../package.json', import.meta.url)),
    );

    expect(config.pipeline['release-notes'].cache).toBe(false);
    expect(config.pipeline.test.dependsOn).toContain('release-notes');
    // One key in one package is what scopes the npmScript task to it: lage skips
    // a task whose package.json does not define the script.
    expect(pkg.scripts['release-notes']).toContain('release-notes-gate.mjs');
  });
});
