# repo-import-name-mismatch-python

**Attacks:** PyPI name != import name: Pillow->PIL, beautifulsoup4->bs4, PyYAML->yaml. The classic source of false 'unused' verdicts in Python dependency tools.

**Expected:**

- **unused.excludes** (Pillow): Imported as PIL; name mapping is required (issue #46 territory).
- **unused.excludes** (beautifulsoup4): Imported as bs4.
- **unused.excludes** (PyYAML): Imported as yaml.
