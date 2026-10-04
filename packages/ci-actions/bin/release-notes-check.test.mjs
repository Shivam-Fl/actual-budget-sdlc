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

async function runCheck(dir) {
  const env = { ...process.env, BASE_REF: BASE_BRANCH };
  // reportError only reaches its exit through the step summary when the runner
  // supplies one; unset so a failure takes the exit-1 path CI would.
  delete env.GITHUB_STEP_SUMMARY;

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
    // Reproduces the defect this file shipped with: the walk was one level deep,
    // so a nested note broke every rule and the gate still exited 0 — while the
    // release-notes checker selected it through its diff, count-points.mjs counted
    // it under `upcoming-release-notes/**/*` and the changelog generator listed it
    // with `git ls-tree -r`. Nothing may treat a subdirectory as out of scope, and
    // the path is named with forward slashes because that is what a contributor
    // types into a shell and what the gate has to name for them to find it.
    const nested = path.join(NOTES_DIR, 'qa-nested');

    try {
      fs.mkdirSync(nested, { recursive: true });
      fs.writeFileSync(
        path.join(nested, 'bad-note.md'),
        releaseNote({
          category: 'Chore',
          authors: 'github-actions',
          body: 'An automated change nobody should be thanked for',
        }),
      );

      expect(collectFailures()).toEqual(
        expect.arrayContaining([
          expect.stringMatching(/^qa-nested\/bad-note\.md category "/),
          'qa-nested/bad-note.md authors are not people: github-actions',
        ]),
      );
    } finally {
      fs.rmSync(nested, { recursive: true, force: true });
    }
  });

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
