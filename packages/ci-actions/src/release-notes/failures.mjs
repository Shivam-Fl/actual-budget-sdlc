import * as fs from 'node:fs';

import matter from 'gray-matter';

/**
 * The gate's failure paths, as functions that cannot fail.
 *
 * Everything here runs while the gate is already reporting a problem, so a
 * throw from any of these does not merely lose a message — it replaces the
 * `::error::` annotation the job exists to emit with a stack trace on stderr,
 * and the check stops saying what was wrong with the branch. That is the same
 * failure the gate has hit three times already: a rejected `execFile` promise
 * escaping the pipeline, a `readFileSync` inside `reportError` itself, and a
 * `matter()` call parsing front matter a PR author wrote. The invariant is
 * that none of these three may throw, and each is total over the shape it
 * handles rather than over the happy path only.
 *
 * They live under `src/` rather than in `bin/` because that is where this
 * package's vitest include points. A function in `bin/` is invisible to the
 * suite, which is how the perimeter went unheld.
 */

/**
 * Flattens a multi-line message onto one line.
 *
 * These strings end up inside a workflow command, and a newline inside one is
 * either escaped into `%0A` or — worse, in whatever consumes the log — read as
 * the start of a second command a PR author could have written. A stack trace
 * or a YAML source snippet is several lines by construction, so any message
 * built from one has to collapse before it can be reported.
 */
function oneLine(value) {
  return (
    String(value)
      .replace(/\s*\n+\s*/g, '; ')
      // git terminates every line it writes, so the join leaves a separator
      // hanging off the end of the last one.
      .replace(/;\s*$/, '')
      .trim()
  );
}

/**
 * Renders one failed `git` invocation as a single annotation line.
 *
 * The default `error.message` for a rejected `execFile` is the whole command
 * line followed by everything git wrote to stderr — a 160-character echo that
 * names neither the subcommand that failed nor the exit code it failed with,
 * and repeats the arguments the caller already knows it passed. What a person
 * reading a failed job needs is the other half: which subcommand, which exit
 * code, and whatever git said about it — `fatal: bad revision
 * 'origin/qa-tag-1...HEAD'` is the whole diagnosis, and it lives in `stderr`.
 *
 * Recognised by its own `cmd`/`code`/`stderr` rather than by `instanceof`,
 * because these cross a `util.promisify` boundary and there is no single error
 * class on the far side of it. Anything that is not a git invocation is
 * described by its own message.
 */
export function describeFailure(error) {
  // The `error != null` guard is not decoration: `Object.hasOwn` throws a
  // TypeError on a nullish throw, so a `throw null` reaching the boundary would
  // trade one crash for another inside the function written to end them.
  if (
    error != null &&
    Object.hasOwn(error, 'cmd') &&
    Object.hasOwn(error, 'code') &&
    Object.hasOwn(error, 'stderr')
  ) {
    const [program, ...words] = String(error.cmd).split(/\s+/);
    // git prints its own subcommand as the first word, and it is what names
    // the step that failed. A command line that is not git's — a wrapper, or
    // one of these helpers' own calls — is reported verbatim rather than
    // guessed at.
    const invocation =
      program === 'git' && words.length > 0
        ? `${program} ${words[0]}`
        : oneLine(error.cmd);

    return `${invocation} failed with exit ${error.code}: ${oneLine(error.stderr) || 'no output'}`;
  }

  // The fallbacks are what keep this total. `error.message` is missing on a
  // thrown string or a thrown object, `error.name` is missing on a thrown
  // primitive that has no name at all, and `String(error)` on a nullish throw
  // is itself fine — but reading `.message` off one is a TypeError, which is
  // the crash this function exists to prevent.
  if (error instanceof Error && error.message) {
    return oneLine(error.message);
  }
  return oneLine(error?.name ?? error);
}

/**
 * Returns a tracked file's text, or `''` when it cannot be read.
 *
 * Every path in `upcoming-release-notes/` is one a PR author can rewrite, and
 * the failure reporter reads `README.md` out of it on the way out of an error
 * — which makes the reporter itself an error path, and one no guard wrapped
 * around the *caller* can reach. A missing file is the expected case and
 * degrades to an empty notice; a directory in its place raises EISDIR and
 * degrades the same way.
 *
 * The `existsSync` probe this replaces asked the filesystem the same question
 * twice on every error, with a window between the two answers in which the
 * answer could change. Catching the read asks once.
 */
export function readReadme(readmePath) {
  try {
    return fs.readFileSync(readmePath, 'utf-8');
  } catch {
    return '';
  }
}

/**
 * Reads and parses one release note, as a result rather than a throw.
 *
 * Both halves of `matter(fs.readFileSync(path, 'utf-8'))` can throw on input
 * this file does not control: the read on a filename's bytes, and the parse on
 * front matter a PR author wrote. Unterminated YAML is not exotic — a
 * half-typed `category: [` parses as a flow sequence, and the author finds out
 * from the job.
 *
 * The message is the parse reason alone, not the whole exception. js-yaml
 * appends the offending source and a caret to it, which is several lines of
 * the author's own file, and this lands in a one-line annotation.
 */
export function parseNote(path) {
  try {
    const { data, content } = matter(fs.readFileSync(path, 'utf-8'));
    return { ok: true, data, content };
  } catch (error) {
    // js-yaml formats its message as `<reason> at line L, column C:` and then
    // quotes the line it choked on under it. Only the first of those says what
    // to fix, and the trailing colon reads as a second break once the text is
    // appended to `could not be parsed:`. Any other exception's message is
    // already one line, and keeps its whole text — an ENOENT trimmed to
    // `ENOENT` would name no file.
    const message = String(error?.message ?? error);
    return {
      ok: false,
      message: message.split('\n', 1)[0].replace(/:$/, '').trim(),
    };
  }
}
