import * as childProcess from 'node:child_process';
import * as fsSync from 'node:fs';
import * as fs from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

import matter from 'gray-matter';
import listify from 'listify';

const execFile = promisify(childProcess.execFile);

export const categoryAutocorrections = {
  Feature: 'Features',
  Enhancement: 'Enhancements',
  Bugfix: 'Bugfixes',
};

export const categoryOrder = [
  'Features',
  'Enhancements',
  'Bugfixes',
  'Maintenance',
];

// Authors are published verbatim as "@<author>" in the changelog, so a bot or
// agent login here ships to readers as thanks to a tool. This is an identity
// denylist rather than a handle-shape check because `claude` is a
// syntactically valid GitHub handle — shape alone cannot tell the tool from the
// person. The list is short on purpose: looking authors up over the network was
// rejected as slow and token-dependent, so a future agent login would still
// need to be added here by hand.
export const NON_PERSON_AUTHORS = ['claude', 'github-actions'];

const BOT_SUFFIX = /\[bot\]$/;

// Statuses whose file is still present on HEAD, so it is worth validating. A
// deletion is not: there is nothing left to publish. A rename is selected
// because HEAD holds that file under its new path. No copy status is listed
// because the invocation asks git for no copy detection, so a copy arrives as
// an addition — already selected, and `added` stays truthful about it.
const SELECTED_STATUSES = ['A', 'M', 'R'];

/**
 * Returns every author that is not a credit to a person — a known bot or agent,
 * or any value that is not a string — in input order, so the caller can name
 * them in its error. Returns the offending values instead of a boolean because
 * they are already in hand here.
 *
 * The type check is what makes this total over YAML input: a flow sequence can
 * hold an int, a float, a bool, null, a list or a map, none of which is a
 * GitHub username, and normalising those would throw straight out of the gate.
 */
export function findNonPersonAuthors(authors) {
  return authors.filter(author => {
    if (typeof author !== 'string') {
      return true;
    }
    const normalized = author.toLowerCase().trim();
    return (
      NON_PERSON_AUTHORS.includes(normalized) || BOT_SUFFIX.test(normalized)
    );
  });
}

/**
 * Escapes a value for use as workflow-command data, per GitHub's documented
 * rules. The order matters: "%" is escaped first, so a value already holding
 * the literal text "%0A" becomes "%250A" instead of being resurrected into a
 * real newline by the LF rule below.
 *
 * ":" and "," are deliberately left alone — they are only special inside the
 * property syntax, and the check script emits no properties.
 */
export function sanitizeWorkflowCommandData(value) {
  return String(value)
    .replace(/%/g, '%25')
    .replace(/\r/g, '%0D')
    .replace(/\n/g, '%0A');
}

/**
 * Renders one offending author for an error message. A string is already
 * readable, so it passes through untouched.
 *
 * Everything else is JSON, because the gate names the structure an author wrote
 * so they can see what to fix. JSON.stringify throws on a cycle, and a YAML
 * anchor can make a value self-referential (`authors: &a [*a]`), so the render
 * is guarded rather than left to reach the author as a stack trace. The `??`
 * matters for the same reason from the other side: JSON.stringify(undefined)
 * returns undefined without throwing, and an offender rendered as the empty
 * string would produce a message naming nobody.
 */
export function describeAuthor(value) {
  if (typeof value === 'string') {
    return value;
  }
  try {
    return JSON.stringify(value) ?? Object.prototype.toString.call(value);
  } catch {
    return Object.prototype.toString.call(value);
  }
}

/**
 * Turns NUL-separated `git diff --name-status -z` output into the release notes
 * a check run has to look at, as `{ added, changed }`.
 *
 * `-z` is what makes the path a path. Without it git quotes and backslash-
 * escapes any path holding a quote, a backslash or a control character, and
 * octal-escapes the non-ASCII bytes of any path unless it is separately told
 * not to; a tab-separated parse of that output shreds the row either way.
 * With `-z` the fields are NUL-separated: one record is `status\0path\0` and a
 * rename or copy record is `status\0old\0new\0`, so an R or C record has to
 * consume two path fields before the next record begins. Fields are consumed
 * before the status is filtered, so a row we go on to discard cannot
 * desynchronise the rows after it.
 *
 * `changed` covers modifications and renames as well as additions: a note
 * edited — or moved to a fresh filename — to credit a bot is as much a gate
 * concern as one added with a bot in it. A rename record's last path is the one
 * HEAD holds, which is the file that would ship; binding the old path instead
 * would validate a file that no longer exists.
 *
 * The `.md` and README filters are applied once, to the collected rows, before
 * they are split: both lists must exclude them, or a README-only edit would
 * satisfy the "did this branch add a note?" check and then be validated as a
 * note. `added` is derived from the status column alone, so that check keeps
 * answering exactly as it did when only added files were read.
 */
export function selectReleaseNotePaths(diffOutput, notesDir) {
  const fields = diffOutput.split('\0');
  const rows = [];

  let index = 0;
  while (index < fields.length) {
    const status = fields[index++];
    if (!status) {
      continue;
    }
    const hasTwoPaths = status[0] === 'R' || status[0] === 'C';
    const path = hasTwoPaths ? fields[index + 1] : fields[index];
    index += hasTwoPaths ? 2 : 1;

    if (SELECTED_STATUSES.includes(status[0])) {
      rows.push([status, path]);
    }
  }

  const notes = rows.filter(
    ([, path]) => path?.endsWith('.md') && path !== `${notesDir}/README.md`,
  );

  return {
    added: notes.filter(([status]) => status === 'A').map(([, path]) => path),
    changed: notes.map(([, path]) => path),
  };
}

/**
 * Every release note under `dir`, as paths relative to it with forward slashes,
 * sorted.
 *
 * This is the one enumeration of the notes directory, shared with the gate in
 * bin/release-notes-gate.mjs because both sides have to agree: the checker
 * selects a nested note through a recursive `git diff` pathspec, the changelog
 * generator lists it with `git ls-tree -r` and count-points.mjs counts it under
 * a recursive glob over `upcoming-release-notes`. A publisher that walked one
 * level deep would drop a note every other participant had already accepted —
 * validated, counted, and then published nowhere and credited to nobody, which
 * is the defect this function exists to prevent.
 *
 * The walk is recursive, and README.md is excluded only at the top level —
 * `selectReleaseNotePaths`' rule rather than "any basename called README", since
 * only the directory's own README is the directory's README.
 *
 * Synchronous, deliberately. The gate is a CLI whose every other operation is
 * `node:fs` sync, and a walk that had to be awaited could be awaited at one call
 * site and missed at the next — where `expect(collectFailures()).toEqual([])`
 * asserts on a Promise and passes without having run anything. parseReleaseNotes
 * is async and calls this without awaiting, which costs it nothing.
 */
export function listNotePaths(dir) {
  const paths = [];

  function walk(current, prefix) {
    for (const entry of fsSync.readdirSync(current, { withFileTypes: true })) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;

      if (entry.isDirectory()) {
        walk(join(current, entry.name), relative);
      } else if (entry.name.endsWith('.md') && relative !== 'README.md') {
        paths.push(relative);
      }
    }
  }

  walk(dir, '');
  // No comparator, and the rule that asks for one is off for this line on
  // purpose. The default sorts by UTF-16 code unit, which is deterministic
  // across hosts and locales — and the report order is part of what a
  // contributor reads when several notes fail at once, so it must not shift
  // with the input locale. A hand-written comparator here would only restate
  // that default, which is what this comparator used to be.
  // oxlint-disable-next-line typescript/require-array-sort-compare -- the default comparator already is the deterministic, locale-independent order
  return paths.sort();
}

export async function parseReleaseNotes(dir, owner, repo, historyRef, only) {
  const allowed = only == null ? null : new Set(only);
  const files = listNotePaths(dir).filter(
    f => allowed == null || allowed.has(f),
  );
  const notes = files.map(async name => {
    const content = await fs.readFile(join(dir, name), 'utf-8');
    const { data, content: body } = matter(content);
    const authors = listify(
      data.authors.map(a => `@${a}`),
      { finalWord: '&' },
    );
    const number = await resolvePrNumber(dir, name, historyRef);
    const prefix = number
      ? `[#${number}](https://github.com/${owner}/${repo}/pull/${number}) `
      : '';
    return {
      category: categoryAutocorrections[data.category] ?? data.category,
      value: `- ${prefix}${body.trim()} — thanks ${authors}`,
    };
  });

  const notesByCategory = (await Promise.all(notes)).reduce(
    (acc, note) => {
      if (!acc[note.category]) {
        console.log(`WARNING: Unrecognized category "${note.category}"`);
        acc[note.category] = [];
      }
      acc[note.category].push(note.value);
      return acc;
    },
    Object.fromEntries(categoryOrder.map(c => [c, []])),
  );

  return { notesByCategory, files };
}

async function resolvePrNumber(dir, name, historyRef = 'HEAD') {
  const basename = name.replace(/\.md$/, '');
  if (/^\d+$/.test(basename)) {
    return basename;
  }

  let subject;
  try {
    const { stdout } = await execFile('git', [
      'log',
      '-1',
      '--diff-filter=A',
      '--format=%s',
      historyRef,
      '--',
      join(dir, name),
    ]);
    subject = stdout.trim();
  } catch (e) {
    console.log(
      `WARNING: failed to read commit subject for ${name}: ${e.message}`,
    );
    return null;
  }

  // GitHub's squash-merge UI appends "(#NNNN)" to every commit subject,
  // so we can recover the PR number without touching the network.
  const match = subject.match(/\(#(\d+)\)\s*$/);
  if (!match) {
    console.log(
      `WARNING: no "(#N)" suffix in commit subject for ${name}; skipping PR link`,
    );
    return null;
  }
  return match[1];
}

export function formatNotes(notes) {
  return Object.entries(notes)
    .filter(([_, values]) => values.length > 0)
    .map(([category, values]) => `#### ${category}\n\n${values.join('\n')}`)
    .join('\n\n');
}
