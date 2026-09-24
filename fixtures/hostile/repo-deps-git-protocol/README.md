# repo-deps-git-protocol

**Attacks:** Dependency declared via git URL ("git+https://github.com/user/repo#branch"). No registry version, no lockfile entry shape; must not be treated as a normal versioned dependency.

**Expected:**

- **dependencies.includes** (internal-lib): It is declared and used; it must appear in the model.
- **limitations.includes** "git": Non-registry constraints carry no version/health facts.
