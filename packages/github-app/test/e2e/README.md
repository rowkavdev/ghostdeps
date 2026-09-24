# End-to-end fixtures (#41)

Each directory is one simulated pull request against `octo-org/example-app`
(the repository in `../fixtures/pull_request.opened.json`):

- `head/` is the repository tree at the PR head. The test packs it into the
  tarball GitHub would serve.
- `base-package.json` is `package.json` at the PR base.
- `pr.diff` is the base...head diff GitHub's compare API would return.
- `expected-check.json` is the completed check run the app must write, with
  timestamps removed. Regenerate with `UPDATE_GOLDEN=1` and review the diff.
