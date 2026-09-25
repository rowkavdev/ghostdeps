# perf/ — worker profiling

`profile-worker.mjs` measures the GitHub App worker pipeline (codeload
download -> extract -> scan -> isolated adapter analysis) against pinned
real repositories and reports wall time per stage, peak RSS per run, and
where the production budgets (60 s adapter stage timeout, 512 MiB worker
heap, scanner ceilings, tarball caps, npm metadata fetch budget) actually
bind.

```
pnpm build                          # the harness imports the built packages
node perf/profile-worker.mjs        # full sweep: corpus + perf/corpus-extra.json
node perf/profile-worker.mjs --repos vite,got --reps 3
node perf/profile-worker.mjs --modes pipeline,concurrent
```

Results land in `perf/results/<timestamp>.json` (a table prints to stdout).
Checkouts cache under `perf/.cache/` — delete it to force fresh downloads.
The baseline report is `REPORT-2026-09-25.md`.
