---
category: Bugfixes
authors: [Shivam-Fl]
---

Fix unsplitting a split losing part of the parent transaction's amount, or its payee. A split whose children fell short of the parent — a partly typed one — used to be deleted and replaced with rows summing to less than it, and a three-or-more-child split was rewritten to the sum of the children that stayed; on a split opened from a schedule the occurrence stamp was lost too, so `/schedules` read the occurrence as Due again. The parent is now kept on both paths whenever the rows replacing it do not account for it, reduced by what left rather than recomputed from what stayed. The surviving row also keeps its payee, which it used to lose — the amount was right but the transaction showed a blank payee and disappeared from a search for it. Correctly filled splits, and splits whose children were typed to more than the parent, still split out as before, each with the payee of the leg it came from.
