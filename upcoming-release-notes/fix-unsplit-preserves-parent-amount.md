---
category: Bugfixes
authors: [Shivam-Fl]
---

Fix unsplitting a split losing part of the parent transaction's amount. A split whose children fell short of the parent — a partly typed one — used to be deleted and replaced with rows summing to less than it, and a three-or-more-child split was rewritten to the sum of the children that stayed; on a split opened from a schedule the occurrence stamp was lost too, so `/schedules` read the occurrence as Due again. The parent is now kept on both paths whenever the rows replacing it do not account for it, reduced by what left rather than recomputed from what stayed. Correctly filled splits, and splits whose children were typed to more than the parent, still split out as before.
