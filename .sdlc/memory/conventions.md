# Conventions

What a newcomer's first pull request gets wrong in this repo.

## Release notes are a hard gate, not a courtesy

`.github/actions/release-notes/check/action.yml` validates every note a PR adds,
modifies **or renames** under `upcoming-release-notes/`. `git diff --diff-filter=AMR`
means editing an existing note to fix its author counts; a deletion does not (there is
nothing left to publish). A PR that touches none of these paths fails.

Each note is YAML frontmatter plus a body:

```markdown
---
category: Bugfixes
authors: [Shivam-Fl]
---

One line, no newline in the body.
```

- `category` is one of `Features`, `Enhancements`, `Bugfixes`, `Maintenance`. The
  singular forms are autocorrected, so `Bugfix:` ships — but write the plural.
- `authors` must be **GitHub usernames of people**. `claude` and `github-actions` are
  rejected by an identity denylist, not a shape check, because `claude` is a valid
  handle. A future agent login must be added to `NON_PERSON_AUTHORS` in
  `packages/ci-actions/src/release-notes/util.mjs` by hand.
- The body is **exactly one line**. The gate tests `content.trim().includes('\n')`, so a
  second paragraph fails.

The diff parse uses `git diff --name-status -z`: NUL-separated, so a path holding a
quote, backslash or non-ASCII byte survives. Do not "simplify" that back to a
tab-separated parse — it shreds such rows, and a rename record then has to consume two
path fields before the next record begins.

## Pull request titles

Every PR title starts with `[AI]` — applied by hand, not by tooling.

## Comments must describe the current state

Several merged PRs existed only because a hand-written comment described the pre-fix
behaviour as the current one, four lines above code that contradicted it. When editing a
comment in this repo, read it top to bottom against the code it sits above. See
`patterns/planner-read-comment-wording-as-the-defect.md` for why this came up so often.

## Testing

- A regression test must be **able to fail**. Assert on behaviour, not on the presence
  of a mock: `expect(vi.isMockFunction(globalThis.fetch)).toBe(true)` passes for a spy
  that serves nothing. Prove it by sabotaging the guard and recording the failing run.
- `loot-core` splits its suite across two vitest configs with different `include` lists —
  see `qa/environment.md` before running a single file.
- e2e is **not** covered by `yarn typecheck`. See `qa/environment.md`.