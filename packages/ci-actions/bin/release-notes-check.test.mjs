import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const exec = promisify(execFile);

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
