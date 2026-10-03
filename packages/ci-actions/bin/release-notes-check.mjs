import * as childProcess from 'node:child_process';
import * as fs from 'node:fs';
import { promisify } from 'node:util';

import matter from 'gray-matter';

import {
  categoryAutocorrections,
  categoryOrder,
  findNonPersonAuthors,
  sanitizeWorkflowCommandData,
  selectReleaseNotePaths,
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

  // The README is a tracked file any PR author can rewrite, and it is excluded
  // from validation below, so its bytes are never checked. Escaping the whole
  // file collapses it onto this single notice line: piping it raw would let a
  // PR put live `::add-mask::` or `::notice::` lines in this job's log.
  const readme = fs.readFileSync(`${NOTES_DIR}/README.md`, 'utf-8');
  console.log(`::notice::${sanitizeWorkflowCommandData(readme)}`);

  fs.createWriteStream(process.env.GITHUB_STEP_SUMMARY)
    .end(readme)
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
    // Without this git octal-escapes any non-ASCII byte in a path and wraps it
    // in quotes, so a note whose filename is not pure ASCII silently fails the
    // `.md` test below and reads as "No release note added".
    '-c',
    'core.quotePath=false',
    'diff',
    '--name-status',
    // R and C matter as much as M: a note can be renamed or copied to a fresh
    // filename and reach readers with a bot in its authors list either way.
    '--diff-filter=AMRC',
    `origin/${baseRef}...HEAD`,
    '--',
    `${NOTES_DIR}/`,
  ]);
  const { added, changed } = selectReleaseNotePaths(stdout, NOTES_DIR);

  if (added.length === 0) {
    reportError(
      `No release note added under ${NOTES_DIR}/. Add a *.md file describing your change.`,
    );
    return;
  }

  for (const path of changed) {
    if (!fs.existsSync(path)) {
      reportError(`Release note ${path} was added but does not exist on HEAD.`);
      return;
    }
    if (!validateFile(path)) {
      return;
    }
  }

  console.log(`Validated ${changed.length} release note(s). \u{1f389}`);
})();
