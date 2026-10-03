---
category: Bugfixes
authors: [Shivam-Fl]
---

Fix scheduled transactions being skipped when you post a later occurrence before an earlier one. Posting a schedule from a later "Upcoming" row no longer advances the schedule past the occurrence you skipped: that earlier occurrence stays listed and stays payable, and the later ones stay upcoming. Each occurrence is now recorded individually, so posting the same occurrence twice only ever creates one transaction.
