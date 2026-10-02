import * as childProcess from 'node:child_process';
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

export async function parseReleaseNotes(dir, owner, repo, historyRef, only) {
  const allowed = only == null ? null : new Set(only);
  const files = (await fs.readdir(dir)).filter(
    f =>
      f.endsWith('.md') &&
      f !== 'README.md' &&
      (allowed == null || allowed.has(f)),
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
