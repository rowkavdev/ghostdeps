# Corpus regression check

Pinned real-repo fixtures proving the detectors find real dependency smells.
24 repos, each pinned by exact SHA in `repos.json`; `golden/<name>.json` is the
exact expected output for that pin: the full set of `{kind, severity,
dependency}` findings plus the expected scan exit code.

`node scripts/corpus.mjs` runs check mode (nightly + on corpus-touching PRs,
see `.github/workflows/corpus.yml`). This check is the gate that lifts the
`unused` severity cap (#173) and the `medium` confidence cap (#178).

## When a pin fails, the failure tells you what to do

Every failure names the repo and its pin, and says what to change - never a
bare exit code or a stack trace:

- **Drift** lists expected vs actual exit code and the missing/new findings
  as `kind severity dependency` lines, with a summary table in the job log.
- **A moved pin** (golden SHA differs from `repos.json`) fails as a moved
  pin: regenerate the golden in the same PR that moves the pin.
- **A missing, malformed, or misshapen golden** fails with the file path and
  the fix; so does a golden no repo claims, or a `--only` name no repo has.
- **A scan that exits 0 but prints unparseable JSON** fails the pin as a
  broken CLI contract - investigate the CLI, never the golden.

Rerun one pin after a fix without re-scanning all 24:

```
node scripts/corpus.mjs --only chalk,uuid
```

## Golden updates ride corpus PRs, never a CI regen

Goldens change only through PRs that touch `corpus/**`:

1. Regenerate locally: `node scripts/corpus.mjs --update` (optionally
   `--only <name>`).
2. `--update` refuses under `CI` - there is no automated regeneration path,
   so a golden can never change silently.
3. `--update` refuses to write a golden that breaks a repo's `mustBeUnused` /
   `mustNotBeUnused` invariants; those findings must be fixed first.
4. The PR trigger on `corpus.yml` runs the check against any corpus-touching
   PR (informational until promotion - see the workflow's header comment),
   so a changed golden is validated against its pin before merge.

The 14-consecutive-green-nightly streak that lifts the caps, and the exact
promotion definition, are tracked on the issue.
