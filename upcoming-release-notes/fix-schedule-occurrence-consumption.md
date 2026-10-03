---
category: Bugfixes
authors: [Shivam-Fl]
---

Fix scheduled transactions being skipped when you post a later occurrence before an earlier one. Posting a scheduled transaction from an account register now records that one occurrence: the transaction lands on the date of the occurrence you clicked and the Upcoming row it came from leaves the register, the occurrence you skipped past stays listed and stays payable, and posting the same occurrence twice only ever creates one transaction.
