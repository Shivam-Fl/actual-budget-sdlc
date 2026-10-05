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
 * The walk is recursive and README.md is excluded only at the top level, which
 * is `selectReleaseNotePaths`' rule rather than `parseReleaseNotes`' — the two
 * already disagree about the same directory, because one is fed a recursive git
 * diff pathspec and the other a single `readdir`. The checker selects a nested
 * note, the changelog generator lists it with `git ls-tree -r` and
 * count-points.mjs counts it under a recursive `upcoming-release-notes` glob, so
 * a note this gate cannot see is a note that is published and credited to
 * nobody. Rules come from util.mjs for the same reason: one rule set, so the
 * gate and the checker cannot drift apart.
 */
export function listNotePaths(dir = NOTES_DIR) {
  const paths = [];

  function walk(current, prefix) {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;

      if (entry.isDirectory()) {
        walk(path.join(current, entry.name), relative);
      } else if (entry.name.endsWith('.md') && relative !== 'README.md') {
        paths.push(relative);
      }
    }
  }

  walk(dir, '');
  // Compared rather than left to the default, because a default sort compares
  // UTF-16 code units: the report order is part of what a contributor reads when
  // several notes fail at once, and it should not shift with the input locale.
  return paths.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
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
export function validateNote(relativePath, dir = NOTES_DIR) {
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

/** Every rule failure across every note in the directory, in path order. */
export function collectFailures(dir = NOTES_DIR) {
  return listNotePaths(dir).flatMap(relativePath =>
    validateNote(relativePath, dir),
  );
}

export function main() {
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
