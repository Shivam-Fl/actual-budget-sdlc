---
category: Bugfixes
authors: [Shivam-Fl]
---

Fix a scheduled transaction's occurrence being payable twice after you split its posted transaction. Splitting keeps the link to the schedule on the split itself, and the check that stopped an occurrence being posted a second time could not see that row — so the Schedules page showed the occurrence as paid while posting it again created a second transaction. The same blind spot made the balance forecast count such an occurrence a second time as a payment still to come.
