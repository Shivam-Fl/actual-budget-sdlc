import * as childProcess from 'node:child_process';
import * as fs from 'node:fs';
import { promisify } from 'node:util';

import matter from 'gray-matter';

import {
  categoryAutocorrections,
  categoryOrder,
  describeAuthor,
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
  // PR put live `::add-mask::` or `::notice::` lines in this job's log. It is
  // also the file a PR is most likely to delete, and this function's contract
  // is to report an error rather than throw one, so a missing one degrades to
  // an empty notice instead of failing on the way to the message.
  const readmePath = `${NOTES_DIR}/README.md`;
  const readme = fs.existsSync(readmePath)
    ? fs.readFileSync(readmePath, 'utf-8')
    : '';
  console.log(`::notice::${sanitizeWorkflowCommandData(readme)}`);

  // GITHUB_STEP_SUMMARY is supplied by the runner, so it is always set in
  // Actions and absent on a local run. The summary is the only thing the
  // message is written to, so without it there is nothing left to do but exit.
  if (!process.env.GITHUB_STEP_SUMMARY) {
    process.exit(1);
  }

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
        .map(describeAuthor)
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
    // `-z` makes git emit paths verbatim, NUL-separated, instead of quoting and
    // backslash-escaping anything a tab-separated parse would misread.
    '-z',
    // R matters as much as M: a note moved to a fresh filename reaches readers
    // with whatever is in its authors list, and HEAD holds it at the new path.
    // Deletions publish nothing. C is deliberately absent — the invocation asks
    // for no copy detection, so git reports a copy as an addition anyway.
    // `changed` (A, M, R) is what the emptiness guard below has to test, not
    // `added` (A only): the validation loop walks `changed`, so a diff that only
    // edits or renames a note has something to validate and must not be refused.
    '--diff-filter=AMR',
    `origin/${baseRef}...HEAD`,
    '--',
    `${NOTES_DIR}/`,
  ]);
  const { changed } = selectReleaseNotePaths(stdout, NOTES_DIR);

  if (changed.length === 0) {
    reportError(
      `No release note added or modified under ${NOTES_DIR}/. Add a *.md file describing your change, or edit an existing note.`,
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
