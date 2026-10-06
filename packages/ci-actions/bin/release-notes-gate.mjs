import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import matter from 'gray-matter';

import {
  categoryAutocorrections,
  categoryOrder,
  describeAuthor,
  findNonPersonAuthors,
  sanitizeWorkflowCommandData,
  listNotePaths as walkNotePaths,
} from '../src/release-notes/util.mjs';

// Resolved against this file rather than the working directory, because lage and
// `yarn workspace` both run npm scripts from the package directory and
// upcoming-release-notes/ sits three levels up, outside every workspace package.
const NOTES_DIR = fileURLToPath(
  new URL('../../../upcoming-release-notes', import.meta.url),
);

/**
 * Every release note under NOTES_DIR, as paths relative to it with forward
 * slashes, sorted.
 *
 * The walk lives in util.mjs and this is the wrapper that supplies the default,
 * because the rule it encodes — recurse into every subdirectory, and exclude
 * README.md only at the top level — has to be the same rule everywhere the notes
 * directory is enumerated. The checker selects a nested note through a recursive
 * git diff pathspec, the changelog generator lists it with `git ls-tree -r` and
 * count-points.mjs counts it under a recursive `upcoming-release-notes` glob; the
 * publisher calls this very function. One implementation, so a note nobody can
 * see is no longer a note that gets validated, counted, and then published
 * nowhere and credited to nobody.
 *
 * `onError` is forwarded rather than reimplemented: the gate is the caller that
 * reports an unreadable directory instead of throwing on it, and it can only do
 * that if the walk does not stop there.
 */
export function listNotePaths(dir = NOTES_DIR, onError) {
  return walkNotePaths(dir, onError);
}

/**
 * Returns one failure string per rule this note breaks, rather than throwing on
 * the first, so a run over a whole directory reports every offending file at
 * once instead of making them play whack-a-mole.
 *
 * The messages name the note by its path relative to NOTES_DIR, which is what a
 * contributor has to type into a shell — and which is why the nested case names
 * `qa-nested/bad-note.md` rather than a bare basename.
 */
function validateNote(relativePath, dir = NOTES_DIR) {
  let data;
  let content;

  try {
    ({ data, content } = matter(
      fs.readFileSync(path.join(dir, relativePath), 'utf-8'),
    ));
  } catch (error) {
    // Reported rather than thrown: one malformed note must not hide the other
    // failures in the run, and an exception escaping here would reach the
    // caller as a stack trace naming no file to fix.
    return [`${relativePath} front matter is not valid YAML: ${error.message}`];
  }

  const failures = [];

  if (!data.category) {
    failures.push(`${relativePath} is missing a category`);
  } else if (
    !categoryOrder.includes(
      categoryAutocorrections[data.category] ?? data.category,
    )
  ) {
    failures.push(
      `${relativePath} category "${data.category}" is not one of ${categoryOrder.join(', ')}`,
    );
  }

  if (!data.authors) {
    failures.push(`${relativePath} is missing authors`);
  } else if (!Array.isArray(data.authors)) {
    failures.push(`${relativePath} authors should be a list`);
  } else if (data.authors.length === 0) {
    failures.push(`${relativePath} has an empty authors list`);
  } else {
    const nonPersonAuthors = findNonPersonAuthors(data.authors);
    if (nonPersonAuthors.length > 0) {
      failures.push(
        `${relativePath} authors are not people: ${nonPersonAuthors.map(describeAuthor).join(', ')}`,
      );
    }
  }

  const trimmed = content.trim();
  if (!trimmed || trimmed.includes('\n')) {
    failures.push(`${relativePath} body should contain exactly one line`);
  }

  return failures;
}

/**
 * Every rule failure across every note in the directory, in path order.
 *
 * A directory the walk cannot read is a failure like any other, and it is
 * reported alongside the note failures rather than instead of them: catching it
 * around the whole walk meant one unreadable subdirectory discarded every note
 * already read, so the next run met a previously hidden failure for the first
 * time. The top-level directory is the same case with an empty prefix, and still
 * yields exactly one string — the caller prints each entry as an `::error::` line
 * and exits 1, which is how an unreadable directory reaches the log instead of a
 * stack trace.
 */
export function collectFailures(dir = NOTES_DIR) {
  const unreadable = [];
  const paths = listNotePaths(dir, (prefix, error) => {
    // Named rather than a fixed string, because the suite hands this a temporary
    // directory and a fixed one would misreport it.
    unreadable.push(
      `cannot read ${prefix ? path.join(dir, prefix) : dir}: ${error.message}`,
    );
  });

  // Sorted like the walk's own paths, and for the same reason: these entries
  // arrive in readdir order, which is the filesystem's and not ours, and a
  // contributor reading several failures at once must not see them reordered by
  // which machine they ran on.
  // oxlint-disable-next-line typescript/require-array-sort-compare -- the default comparator already is the deterministic, locale-independent order
  const sorted = unreadable.sort();

  return [
    ...sorted,
    ...paths.flatMap(relativePath => validateNote(relativePath, dir)),
  ];
}

function main() {
  const failures = collectFailures();

  if (failures.length > 0) {
    // The failure text carries note-authored values — a category, an author — so
    // it is escaped the way the check script escapes its own, rather than piped
    // into the log raw where a note could smuggle in a live `::add-mask::` line.
    failures.forEach(failure =>
      console.log(`::error::${sanitizeWorkflowCommandData(failure)}`),
    );
    process.exit(1);
  }

  console.log(`Validated ${listNotePaths().length} release note(s).`);
}

// Guarded so importing the module above has no side effects: the unit suite
// imports collectFailures() and runs the gate inside its own process. Both sides
// are resolved through realpath because a launcher may reach this file by a path
// that is not the one it was imported under.
const isMain =
  process.argv[1] &&
  fs.realpathSync(process.argv[1]) ===
    fs.realpathSync(fileURLToPath(import.meta.url));

if (isMain) {
  main();
}
