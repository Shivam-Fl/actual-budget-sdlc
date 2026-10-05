---
category: Bugfixes
authors: [Shivam-Fl]
---

Fix a transaction losing its payee when it stops being a split. Deleting every leg of a split, or unsplitting one whose first leg's payee had been cleared, left the surviving transaction at the right amount but with a blank payee, so it disappeared from any search or view filtered by one. The survivor now takes the payee of the row it absorbs.
