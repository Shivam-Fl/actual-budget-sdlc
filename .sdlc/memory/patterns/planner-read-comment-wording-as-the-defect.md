# The planner repeatedly read comment wording and test naming as the defect

## Symptom

Across the schedule and sqlite work, a string of merged PRs were near-identical in shape:
a comment re-wrap, a comma moved for grammatical attachment, a test description
reworded, a release note duplicated. PR #67 (`Rewrap the sql.js fetch patch comment`),
PR #73 (`Attribute the console spies to the tests that install them`) and PR #65 were all
comment-and-test-text edits to the same file, none changing an executable statement.
PR #49 was largely deleting PR #15's leftover scaffolding.

## Cause — what the planner misread

The work orders were generated from review findings and then treated as product defects
with acceptance criteria. What they actually were:

- **Review comments about a comment.** The review found that a hand-written comment
  described the pre-fix state as the current one. The *defect* was the mismatch between
  comment and code — already fixed by the preceding PR. The work order then specified
  the exact replacement wording, which is what turned it into a diff.
- **A review finding about test falsifiability**, which is a real and valuable thing to
  fix, but is a change to *how strong a test is*, not to product behaviour. Specifying it
  as AC-1/AC-2/AC-3 produced three PRs to land one `+9/-4`.

The tell in every one of these PR bodies: **AC-3 or AC-2 constrains the diff itself**
("the diff touches exactly one file", "changes no executable statement"). A criterion
about what the diff must *not* contain is a criterion written for a review comment that
was already addressed.

## How to apply

When triaging or planning a follow-up:

1. **Check whether the finding is already fixed on `main`.** Several of these were
   re-reviewing a commit that had just landed. `git log -p` on the file settles it in one
   command.
2. **Separate the three kinds of follow-up.** Product behaviour → a normal ticket. Test
   strength → usually worth doing, but scope it as "make this test able to fail", not as
   a line edit. Comment accuracy → usually not worth a PR at all; fold it into the next
   change that touches the file.
3. **Be suspicious of an AC that names exact replacement prose.** If AC-1 quotes the
   sentence a comment must read, the planner is transcribing a review comment, not
   diagnosing a defect.

The sqlite and schedule fixes themselves were worth having. It is the follow-up tail —
roughly nine PRs re-litigating comments and test strength across two files — that was
misdirected.