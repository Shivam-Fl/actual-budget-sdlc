import * as childProcess from 'node:child_process';
import * as fs from 'node:fs';
import { promisify } from 'node:util';

import {
  describeFailure,
  parseNote,
  readReadme,
} from '../src/release-notes/failures.mjs';
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
  // is to report an error rather than throw one, so an unreadable one degrades
  // to an empty notice instead of failing on the way to the message — which
  // includes a PR that replaces it with a directory, where the read raises
  // EISDIR rather than ENOENT.
  const readme = readReadme(`${NOTES_DIR}/README.md`);
  console.log(`::notice::${sanitizeWorkflowCommandData(readme)}`);

  // GITHUB_STEP_SUMMARY is supplied by the runner, so it is always set in
  // Actions and absent on a local run. The summary is the only thing the
  // message is written to, so without it there is nothing left to do but exit.
  //
  // Every exit here sets `exitCode` rather than calling `process.exit`. To a
  // pipe, `console.log` is asynchronous, so exiting synchronously discards
  // whatever had not drained — and the README is a tracked file any PR author
  // can rewrite, so the notice above can be megabytes. The verdict is already
  // on stdout by this point; only the unhandled write is at stake.
  if (!process.env.GITHUB_STEP_SUMMARY) {
    process.exitCode = 1;
    return;
  }

  // An unopenable summary path — a directory the runner never created, say —
  // arrives as an `error` event on the stream, and a stream with no `error`
  // listener throws it as an unhandled event. That kills the process on the way
  // out of a function whose contract is to report an error rather than throw
  // one, so both endings set the same exit code and neither throws. The
  // listener is attached before `end()` so it is in place before the write
  // attempts the open.
  const summary = fs.createWriteStream(process.env.GITHUB_STEP_SUMMARY);
  summary.on('error', () => {
    process.exitCode = 1;
  });
  summary.on('close', () => {
    process.exitCode = 1;
  });
  summary.end(readme);
}

/**
 * Validates one release note. `path` is the Buffer the filesystem is asked
 * about, and `label` is the same path as a string for the error messages —
 * a Buffer stringifies to its raw bytes, so the two cannot be one argument.
 */
function validateFile(path, label) {
  // The front matter is whatever a PR author typed, so it can fail to parse —
  // and the gate's whole job is to say which file and why rather than to exit
  // on a stack trace. This is the one place that can name the offending note,
  // because only here is the label in hand.
  const parsed = parseNote(path);
  if (!parsed.ok) {
    reportError(`Release note ${label} could not be parsed: ${parsed.message}`);
    return false;
  }
  const { data, content } = parsed;

  if (!data.category) {
    reportError(`Release note ${label} is missing a category.`);
    return false;
  }
  const category = categoryAutocorrections[data.category] ?? data.category;
  if (!categoryOrder.includes(category)) {
    reportError(
      `Release note ${label} category "${data.category}" is not one of ${categoryOrder
        .map(JSON.stringify)
        .join(', ')}`,
    );
    return false;
  }

  if (!data.authors) {
    reportError(`Release note ${label} is missing authors.`);
    return false;
  }
  if (!Array.isArray(data.authors)) {
    reportError(`Release note ${label} authors should be a list.`);
    return false;
  }
  if (data.authors.length === 0) {
    reportError(`Release note ${label} has an empty authors list.`);
    return false;
  }
  const nonPersonAuthors = findNonPersonAuthors(data.authors);
  if (nonPersonAuthors.length > 0) {
    reportError(
      `Release note ${label} authors must be GitHub usernames of people, not bots or agents: ${nonPersonAuthors
        .map(describeAuthor)
        .join(', ')}.`,
    );
    return false;
  }

  const trimmedContent = content.trim();
  if (!trimmedContent || trimmedContent.includes('\n')) {
    reportError(`Release note ${label} body should contain exactly one line`);
    return false;
  }

  return true;
}

async function main() {
  // A base ref that cannot be fetched — deleted, renamed, or unreachable for a
  // moment — rejects this promise. The guard below reports it as an annotation
  // with the ref named in it; the boundary under `main` would report it too,
  // but as a `Command failed` echo of the git invocation, so the message that
  // reached a contributor's log is kept as it is.
  try {
    await execFile('git', ['fetch', 'origin', baseRef]);
  } catch (e) {
    reportError(
      `Could not fetch base ref "${baseRef}" from origin: ${e.message}`,
    );
    return;
  }
  const { stdout } = await execFile(
    'git',
    [
      'diff',
      '--name-status',
      // `-z` makes git emit paths verbatim, NUL-separated, instead of quoting and
      // backslash-escaping anything a tab-separated parse would misread.
      '-z',
      // R matters as much as M: a note moved to a fresh filename reaches readers
      // with whatever is in its authors list, and HEAD holds it at the new path.
      // Deletions publish nothing. C is deliberately absent — the invocation asks
      // for no copy detection, so git reports a copy as an addition anyway.
      '--diff-filter=AMR',
      `origin/${baseRef}...HEAD`,
      '--',
      `${NOTES_DIR}/`,
    ],
    // A POSIX filename may hold any byte, but a UTF-8 decode cannot represent
    // every one of them: git hands back raw bytes under -z, and a byte that is
    // not valid UTF-8 becomes U+FFFD, so a file that is genuinely there stops
    // existing as far as `fs.existsSync` is concerned. latin1 maps bytes to
    // code points one for one, so it is the exact inverse of what -z produced
    // and every path below round-trips to the bytes git reported.
    //
    // `maxBuffer` overrides Node's 1MB default, which is a ceiling on the size
    // of a legitimate branch rather than a failure: a release-note batch of a
    // few thousand notes with long filenames overflows it, and the gate then
    // reports a branch that ought to pass. 64MB is ~64x the default and ~35x
    // the 1.8MB a large batch measures, so no human-authored branch reaches
    // it — and if one ever did, the boundary below reports it as an
    // annotation that names itself rather than as a stack trace.
    { encoding: 'latin1', maxBuffer: 64 * 1024 * 1024 },
  );
  const { added, changed } = selectReleaseNotePaths(stdout, NOTES_DIR);

  if (added.length === 0) {
    reportError(
      `No release note added under ${NOTES_DIR}/. Add a *.md file describing your change.`,
    );
    return;
  }

  for (const name of changed) {
    // The invariant this loop depends on: every path arriving here is the
    // latin1 view git's -z output was decoded into, so Buffer.from recovers the
    // exact bytes on disk. A caller passing genuinely decoded UTF-8 instead
    // would have its paths double-encoded, and no current caller does —
    // release-notes-check.mjs and its test are the only two.
    const path = Buffer.from(name, 'latin1');
    // Decoded back to UTF-8 for display, so a name that is valid UTF-8 still
    // reads correctly in the message rather than as mojibake.
    const label = path.toString('utf-8');
    if (!fs.existsSync(path)) {
      reportError(
        `Release note ${label} was added but does not exist on HEAD.`,
      );
      return;
    }
    if (!validateFile(path, label)) {
      return;
    }
  }

  console.log(`Validated ${changed.length} release note(s). \u{1f389}`);
}

// The one boundary under the whole pipeline. Every throw above it — a git call
// that rejects, a filename the filesystem cannot answer for, a bug in this file
// — otherwise escapes as an unhandled rejection and ends the process with a
// stack trace on stderr and no `::error::` line at all, which for a check whose
// entire output is that annotation is the worst possible ending. The handler
// reports through the same path every other error takes, so the job always
// says something and always exits 1.
void main().catch(e => {
  reportError(`Release notes check failed: ${describeFailure(e)}`);
});
