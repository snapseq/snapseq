---
"@snapseq/pdf": patch
---

Each shot is embedded in the PDF as soon as its page is drawn, so a long capture of tall pages no longer holds every decoded image in memory until the file is saved.
