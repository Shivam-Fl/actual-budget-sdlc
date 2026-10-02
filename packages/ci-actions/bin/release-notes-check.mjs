import * as childProcess from 'node:child_process';
import * as fs from 'node:fs';
import { promisify } from 'node:util';

import matter from 'gray-matter';

import {
  categoryAutocorrections,
  categoryOrder,
  findNonPersonAuthors,
  sanitizeWorkflowCommandData,
} from '../src/release-notes/util.mjs';

const execFile = promisify(childProcess.execFile);

const NOTES_DIR = 'upcoming-release-notes';

console.log('Looking in ' + fs.realpathSync(NOTES_DIR));

const baseRef = process.env.BASE_REF;
if (!baseRef) {
  console.log('::error::BASE_REF env var is not set');
  process.exit(1);
}

function reportError(message) {
  console.log(`::error::${sanitizeWorkflowCommandData(message)}`);

  process.stdout.write('::notice::');
  fs.createReadStream(`${NOTES_DIR}/README.md`).pipe(process.stdout);

  fs.createReadStream(`${NOTES_DIR}/README.md`)
    .pipe(fs.createWriteStream(process.env.GITHUB_STEP_SUMMARY))
    .on('close', () => {
      process.exit(1);
    });
}

function validateFile(path) {
  const { data, content } = matter(fs.readFileSync(path, 'utf-8'));

  if (!data.category) {
    reportError(`Release note ${path} is missing a category.`);
    return false;
  }
  const category = categoryAutocorrections[data.category] ?? data.category;
  if (!categoryOrder.includes(category)) {
    reportError(
      `Release note ${path} category "${data.category}" is not one of ${categoryOrder
        .map(JSON.stringify)
        .join(', ')}`,
    );
    return false;
  }

  if (!data.authors) {
    reportError(`Release note ${path} is missing authors.`);
    return false;
  }
  if (!Array.isArray(data.authors)) {
    reportError(`Release note ${path} authors should be a list.`);
    return false;
  }
  if (data.authors.length === 0) {
    reportError(`Release note ${path} has an empty authors list.`);
    return false;
  }
  const nonPersonAuthors = findNonPersonAuthors(data.authors);
  if (nonPersonAuthors.length > 0) {
    reportError(
      `Release note ${path} authors must be GitHub usernames of people, not bots or agents: ${nonPersonAuthors
        .map(a => (typeof a === 'string' ? a : JSON.stringify(a)))
        .join(', ')}.`,
    );
    return false;
  }

  const trimmedContent = content.trim();
  if (!trimmedContent || trimmedContent.includes('\n')) {
    reportError(`Release note ${path} body should contain exactly one line`);
    return false;
  }

  return true;
}

void (async () => {
  await execFile('git', ['fetch', 'origin', baseRef]);
  const { stdout } = await execFile('git', [
    'diff',
    '--name-status',
    '--diff-filter=AM',
    `origin/${baseRef}...HEAD`,
    '--',
    `${NOTES_DIR}/`,
  ]);
  // Selecting on the status column rather than a second diff keeps the
  // added/modified distinction available: a note edited to credit a bot is as
  // much a gate concern as one added with a bot in it.
  const rows = stdout
    .split('\n')
    .map(s => s.trim())
    .filter(Boolean)
    .map(line => line.split('\t'))
    .filter(
      ([, path]) => path?.endsWith('.md') && path !== `${NOTES_DIR}/README.md`,
    );
  const added = rows
    .filter(([status]) => status.startsWith('A'))
    .map(([, path]) => path);

  if (added.length === 0) {
    reportError(
      `No release note added under ${NOTES_DIR}/. Add a *.md file describing your change.`,
    );
    return;
  }

  const changed = rows.map(([, path]) => path);

  for (const path of changed) {
    if (!fs.existsSync(path)) {
      reportError(`Release note ${path} was added but does not exist on HEAD.`);
      return;
    }
    if (!validateFile(path)) {
      return;
    }
  }

  console.log(`Validated ${added.length} release note(s). \u{1f389}`);
})();
