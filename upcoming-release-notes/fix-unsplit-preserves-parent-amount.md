Unsplitting a split no longer destroys the parent transaction's amount

When you unsplit a transaction, the parent row was only kept when every row
that would replace it was `0.00`. Anything else — a partly typed split whose
children fall short of the parent — deleted the parent and left behind rows
summing to less than it, or (on a three-or-more-child split) rewrote the
parent to the sum of the children that stayed. Both silently discarded part of
the transaction's amount, and on a split opened from a schedule it also lost
the occurrence stamp, so `/schedules` read the occurrence as Due again.

The parent is now kept whenever the rows replacing it do not account for it,
on both code paths, and a surviving parent is reduced by what left rather than
recomputed from what stayed. Splits that were filled in correctly, and splits
whose children were typed to more than the parent, still split out as before —
the surplus you typed is not collapsed onto the parent.
