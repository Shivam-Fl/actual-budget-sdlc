---
category: Bugfixes
authors: [Shivam-Fl]
---

Fix scheduled transactions keeping the occurrence stamp of a schedule they are no longer linked to. Unlinking or relinking a transaction on the Schedules page or in a register now clears its occurrence stamp together with the schedule link, so a schedule is no longer shown as paid on the strength of another schedule's occurrence.
