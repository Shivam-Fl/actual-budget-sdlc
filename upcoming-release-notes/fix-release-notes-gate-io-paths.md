---
category: Bugfix
authors: [Shivam-Fl]
---

Fix the release notes check crashing instead of reporting an error when the notes directory, the summary path or the base ref is unavailable, truncating its output, and wrongly rejecting notes whose filenames are not valid UTF-8
