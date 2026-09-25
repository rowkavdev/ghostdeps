#!/usr/bin/env node
/**
 * Production-profiling harness for the GhostDeps GitHub App worker.
 *
 * The 4 GiB production sizing was ceiling math (512 MiB heap per adapter
 * worker x max 4 parallel workers x queue concurrency 2), never a
 * measurement. This harness measures the real worker pipeline end to end:
 *
 *   codeload tarball download -> core extractTarball -> FsRepositoryHandle
 *   scan -> analyseRepositoryIsolated (adapters in worker threads, the same
 *   modules the app's DEFAULT_ADAPTER_MODULES loads)
 *
 * Modes (one child process per measured run, so peak-RSS figures are
 * hermetic):
 *
 *   pipeline    full production path: download + extract + scan + analysis
 *   adapter     analysis only, one adapter per run (per-adapter attribution)
 *   stages      analysis in-process with per-stage wall-clock timing
 *               (detection / dependency listing / dependency graph /
 *                usage analysis / notes) - shows how close any stage gets
 *               to the 60 s adapter stage timeout
 *   footprint   analysis with the app's NpmMetadataService wired in, with
 *               counters for the per-run fetch budget and run deadline
 *   concurrent  two full analyses in one process at once - the production
 *               queue-concurrency-2 shape
 *
 * Usage:
 *   pnpm build   # harness imports the built packages
 *   node perf/profile-worker.mjs                 # full sweep, 2 pipeline reps
 *   node perf/profile-worker.mjs --repos vite,got --reps 1
 *   node perf/profile-worker.mjs --modes pipeline,concurrent
 *
 * Output: a results table on stdout and the raw measurements as JSON in
 * perf/results/<timestamp>.json. Checkouts and tarballs cache under
 * perf/.cache/ (gitignored) so adapter/stages/footprint runs do not
 * re-download; delete the cache to force a fresh fetch.
 *
 * Repo sets: corpus/repos.json (the pinned regression corpus) plus
 * perf/corpus-extra.json, which pins one repo per non-JS adapter so rust,
 * go and python are measured under real work, not just detect-and-exit.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const cacheRoot = join(root, "perf", ".cache");
const resultsDir = join(root, "perf", "results");

const ADAPTERS = ["javascript-typescript", "rust", "go", "python"];
const adapterModule = (name) =>
  pathToFileURL(join(root, "packages/github-app/dist/worker/adapters", `${name}.js`)).href;

function parseArgs(argv) {
  const args = { repos: null, reps: 2, modes: null, child: null };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--child") args.child = JSON.parse(argv[++i]);
    else if (a === "--repos") args.repos = argv[++i].split(",");
    else if (a === "--reps") args.reps = Number(argv[++i]);
    else if (a === "--modes") args.modes = argv[++i].split(",");
    else throw new Error(`unknown argument: ${a}`);
  }
  return args;
}

function loadRepos() {
  const corpus = JSON.parse(readFileSync(join(root, "corpus/repos.json"), "utf8")).repos;
  const extraPath = join(root, "perf/corpus-extra.json");
  const extra = existsSync(extraPath) ? JSON.parse(readFileSync(extraPath, "utf8")).repos : [];
  const parse = (r) => {
    const m = r.url.match(/github\.com[/:]([^/]+)\/([^/.]+?)(?:\.git)?$/);
    return { name: r.name, owner: m[1], repo: m[2], sha: r.sha, covers: r.covers ?? "" };
  };
  return [
    ...corpus.map((r) => ({ ...parse(r), set: "corpus" })),
    ...extra.map((r) => ({ ...parse(r), set: "extra" })),
  ];
}

/* ---------------------------------------------------------------- child */

async function runChild(config) {
  const core = await import(join(root, "packages/core/dist/index.js"));
  const {
    analyseRepository,
    analyseRepositoryIsolated,
    extractTarball,
    FsRepositoryHandle,
    scanCompletenessFindings,
    createDefaultPolicy,
  } = core;
  const { downloadTarball } = await import(
    join(root, "packages/github-app/dist/worker/tarball.js")
  );

  const samples = [];
  const t0 = performance.now();
  const timer = setInterval(() => {
    const m = process.memoryUsage();
    samples.push({
      t: performance.now() - t0,
      rss: m.rss,
      heapUsed: m.heapUsed,
      heapTotal: m.heapTotal,
      external: m.external + m.arrayBuffers,
    });
  }, 25);
  timer.unref();

  const marks = [{ name: "start", t: 0 }];
  const mark = (name) => marks.push({ name, t: performance.now() - t0 });
  const out = { config, stages: {}, notes: [] };

  const MiB = (n) => Math.round((n / 1024 / 1024) * 10) / 10;
  const record = (name, startMark, extra = {}) => {
    const i = marks.findIndex((m) => m.name === startMark);
    const j = marks.length - 1;
    const win = samples.filter((s) => s.t >= marks[i].t && s.t <= marks[j].t);
    out.stages[name] = {
      ms: Math.round(marks[j].t - marks[i].t),
      peakRssMiB: win.length ? MiB(Math.max(...win.map((s) => s.rss))) : null,
      ...extra,
    };
  };

  const checkoutDir = (repo) =>
    join(cacheRoot, `${repo.name}-${repo.sha.slice(0, 12)}`, "checkout");

  // Same unwrapping as the worker's checkoutRoot: codeload tarballs wrap
  // everything in one owner-repo-sha/ directory; analyse that root, not
  // its parent.
  async function unwrap(dir) {
    const { readdir } = await import("node:fs/promises");
    const entries = await readdir(dir, { withFileTypes: true });
    const only = entries.length === 1 ? entries[0] : undefined;
    return only?.isDirectory() ? join(dir, only.name) : dir;
  }

  async function ensureCheckout(repo, { measure }) {
    const dir = checkoutDir(repo);
    if (!measure && existsSync(dir)) return { dir, cached: true };
    rmSync(join(cacheRoot, `${repo.name}-${repo.sha.slice(0, 12)}`), {
      recursive: true,
      force: true,
    });
    mkdirSync(dir, { recursive: true });
    const url = new URL(
      `https://codeload.github.com/${repo.owner}/${repo.repo}/tar.gz/${repo.sha}`,
    );
    let compressed = 0;
    mark("download");
    const counting = (async function* () {
      for await (const chunk of downloadTarball(url, {
        signal: AbortSignal.timeout(5 * 60 * 1000),
      })) {
        compressed += chunk.byteLength;
        yield chunk;
      }
    })();
    mark("extract");
    const summary = await extractTarball(counting, { destDir: join(dir, "x") });
    mark("extracted");
    record("download+extract(streaming)", "download", {
      compressedMiB: MiB(compressed),
      extractedFiles: summary.files,
    });
    return { dir: join(dir, "x"), cached: false };
  }

  async function openHandle(dir) {
    mark("scan");
    const handle = await FsRepositoryHandle.open(dir);
    mark("scanned");
    record("scan", "scan", {
      files: handle.scan.files.length,
      totalMiB: MiB(handle.scan.totalBytes),
      truncated: handle.scan.truncated ?? null,
    });
    return handle;
  }

  async function analyseIsolated(handle, adapterNames, { metadata } = {}) {
    const opts = {
      adapters: adapterNames.map(adapterModule),
      recommend: createDefaultPolicy(),
    };
    const scanCompleteness = scanCompletenessFindings(handle.scan);
    if (scanCompleteness.length > 0) {
      opts.scanIncomplete = true;
      opts.scanCompleteness = scanCompleteness;
    }
    if (metadata) opts.metadata = metadata;
    mark("analyse");
    const result = await analyseRepositoryIsolated(handle, opts);
    mark("analysed");
    record("analysis", "analyse", {
      findings: result.findings.length,
      dependencies: result.dependencies.length,
      usages: result.usages.length,
    });
    return result;
  }

  const repo = config.repo;
  if (config.mode === "pipeline") {
    const { dir } = await ensureCheckout(repo, { measure: true });
    const handle = await openHandle(await unwrap(dir));
    await analyseIsolated(handle, ADAPTERS);
  } else if (config.mode === "adapter") {
    const { dir } = await ensureCheckout(repo, { measure: false });
    const handle = await openHandle(await unwrap(dir));
    await analyseIsolated(handle, [config.adapter]);
  } else if (config.mode === "stages") {
    // In-process run with wall-clock timing per adapter stage. Same engine
    // stage sequence as the isolated tier (run-adapter.ts); the 60 s budget
    // in production is per stage, so these are the numbers that bind it.
    const { dir } = await ensureCheckout(repo, { measure: false });
    const handle = await openHandle(await unwrap(dir));
    const mod = await import(adapterModule(config.adapter));
    const inner = mod.adapter ?? mod.default;
    // findUsage runs with usageConcurrency 8, so summing per-call durations
    // would count overlapping calls ~8x. Track busy wall time instead: time
    // during which at least one call of that stage is in flight.
    const stageMs = {};
    const stageCalls = {};
    const timed = Object.create(Object.getPrototypeOf(inner));
    for (const key of [
      "detect",
      "listDirectDependencies",
      "buildDependencyGraph",
      "findUsage",
      "findNativeAlternatives",
      "analyseHealth",
      "notes",
    ]) {
      if (typeof inner[key] !== "function") continue;
      let active = 0,
        since = 0;
      timed[key] = async (...a) => {
        stageCalls[key] = (stageCalls[key] ?? 0) + 1;
        if (active++ === 0) since = performance.now();
        try {
          return await inner[key](...a);
        } finally {
          if (--active === 0) stageMs[key] = (stageMs[key] ?? 0) + (performance.now() - since);
        }
      };
    }
    for (const k of Object.keys(inner)) if (!(k in timed)) timed[k] = inner[k];
    mark("analyse");
    const result = await analyseRepository(handle, {
      adapters: [timed],
      recommend: createDefaultPolicy(),
    });
    mark("analysed");
    record("analysis", "analyse", { findings: result.findings.length });
    out.stageMs = Object.fromEntries(Object.entries(stageMs).map(([k, v]) => [k, Math.round(v)]));
    out.stageCalls = stageCalls;
  } else if (config.mode === "footprint") {
    const { NpmMetadataService } = await import(
      join(root, "packages/github-app/dist/worker/npm-metadata.js")
    );
    const service = new NpmMetadataService();
    const provider = service.forRun();
    const counters = {
      installSizesCalls: 0,
      packagesRequested: 0,
      packagesSized: 0,
      providerMs: 0,
    };
    const counting = {
      get complete() {
        return provider.complete;
      },
      async installSizes(req) {
        counters.installSizesCalls++;
        counters.packagesRequested += req.packages.length;
        const s = performance.now();
        const answer = await provider.installSizes(req);
        counters.providerMs += performance.now() - s;
        if (answer) counters.packagesSized += answer.sizes.length;
        return answer;
      },
    };
    const { dir } = await ensureCheckout(repo, { measure: false });
    const handle = await openHandle(await unwrap(dir));
    await analyseIsolated(handle, ADAPTERS, { metadata: counting });
    out.footprint = {
      ...counters,
      providerMs: Math.round(counters.providerMs),
      complete: provider.complete,
    };
  } else if (config.mode === "concurrent") {
    // Queue-concurrency-2 shape: two whole analyses in one process. Checkouts
    // are prepared first so the measured window is analysis-only overlap.
    const [a, b] = config.pair;
    const dirA = (await ensureCheckout(a, { measure: false })).dir;
    const dirB = (await ensureCheckout(b, { measure: false })).dir;
    const [handleA, handleB] = [
      await openHandle(await unwrap(dirA)),
      await openHandle(await unwrap(dirB)),
    ];
    delete out.stages.scan;
    const scanCompletenessFor = (h) => {
      const sc = scanCompletenessFindings(h.scan);
      return sc.length ? { scanIncomplete: true, scanCompleteness: sc } : {};
    };
    mark("analyse");
    const [ra, rb] = await Promise.all([
      analyseRepositoryIsolated(handleA, {
        adapters: ADAPTERS.map(adapterModule),
        recommend: createDefaultPolicy(),
        ...scanCompletenessFor(handleA),
      }),
      analyseRepositoryIsolated(handleB, {
        adapters: ADAPTERS.map(adapterModule),
        recommend: createDefaultPolicy(),
        ...scanCompletenessFor(handleB),
      }),
    ]);
    mark("analysed");
    record("analysis(x2 concurrent)", "analyse", {
      findings: [ra.findings.length, rb.findings.length],
    });
  } else {
    throw new Error(`unknown child mode: ${config.mode}`);
  }

  clearInterval(timer);
  const hwm = Number(
    (readFileSync("/proc/self/status", "utf8").match(/VmHWM:\s+(\d+) kB/) ?? [])[1],
  );
  const ru = process.resourceUsage();
  out.totals = {
    wallMs: Math.round(performance.now() - t0),
    peakRssMiB: MiB(Math.max(hwm * 1024, ...samples.map((s) => s.rss))),
    endHeapUsedMiB: MiB(ru ? process.memoryUsage().heapUsed : 0),
    maxRssGetrusageMiB: MiB(ru.maxRSS * 1024),
    cpuUserMs: Math.round(ru.userCPUTime / 1000),
    cpuSysMs: Math.round(ru.systemCPUTime / 1000),
  };
  out.sampleCount = samples.length;
  console.log(JSON.stringify(out));
}

/* --------------------------------------------------------------- parent */

function median(nums) {
  const s = [...nums].sort((a, b) => a - b);
  return s[Math.floor((s.length - 1) / 2)];
}

function runOne(config) {
  const raw = execFileSync(
    process.execPath,
    [join(root, "perf/profile-worker.mjs"), "--child", JSON.stringify(config)],
    { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "inherit"] },
  );
  return JSON.parse(raw.trim().split("\n").pop());
}

async function runParent(args) {
  const repos = loadRepos().filter((r) => !args.repos || args.repos.includes(r.name));
  if (repos.length === 0) throw new Error("no repos selected");
  const modes = args.modes ?? ["pipeline", "adapter", "stages", "footprint", "concurrent"];
  const env = {
    node: process.version,
    cpus: (await import("node:os")).cpus().length,
    totalMemMiB: Math.round((await import("node:os")).totalmem() / 1024 / 1024),
    repoSha: execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(),
    at: new Date().toISOString(),
  };
  mkdirSync(resultsDir, { recursive: true });
  mkdirSync(cacheRoot, { recursive: true });
  const runs = [];
  const go = (config, reps = 1) => {
    for (let i = 0; i < reps; i++) {
      process.stderr.write(
        `>> ${config.mode} ${config.repo?.name ?? config.pair?.map((r) => r.name).join("+")} ${config.adapter ?? ""} rep${i + 1}\n`,
      );
      runs.push(runOne(config));
    }
  };
  // Pipeline first: it populates the checkout cache the other modes reuse.
  if (modes.includes("pipeline"))
    for (const repo of repos) go({ mode: "pipeline", repo }, args.reps);
  if (modes.includes("adapter"))
    for (const repo of repos)
      for (const adapter of ADAPTERS) go({ mode: "adapter", repo, adapter });
  if (modes.includes("stages"))
    for (const repo of repos) for (const adapter of ADAPTERS) go({ mode: "stages", repo, adapter });
  if (modes.includes("footprint")) for (const repo of repos) go({ mode: "footprint", repo });
  if (modes.includes("concurrent")) {
    // Biggest checkout meets a mid-size one: the production worst case is
    // two jobs whose adapter waves overlap.
    const sorted = [...repos].sort((a, b) => a.name.localeCompare(b.name));
    const big = repos.find((r) => r.name === "vite") ?? sorted[0];
    const mid = repos.find((r) => r.name === "got") ?? sorted[sorted.length - 1];
    go({ mode: "concurrent", pair: [big, mid] }, args.reps);
  }
  const file = join(resultsDir, `${env.at.replace(/[:.]/g, "-")}.json`);
  writeFileSync(file, JSON.stringify({ env, runs }, null, 2));

  const rows = [];
  for (const r of runs) {
    const label = [
      r.config.mode,
      r.config.repo?.name ?? r.config.pair?.map((p) => p.name).join("+"),
      r.config.adapter,
    ]
      .filter(Boolean)
      .join(" ");
    rows.push({
      label,
      wallS: (r.totals.wallMs / 1000).toFixed(1),
      peakRssMiB: r.totals.peakRssMiB,
      dlExtractS: r.stages["download+extract(streaming)"]
        ? (r.stages["download+extract(streaming)"].ms / 1000).toFixed(1)
        : "",
      scanS: r.stages.scan ? (r.stages.scan.ms / 1000).toFixed(1) : "",
      analysisS: Object.keys(r.stages)
        .filter((k) => k.startsWith("analysis"))
        .map((k) => (r.stages[k].ms / 1000).toFixed(1))
        .join("/"),
      findings: r.stages.analysis?.findings ?? r.stages["analysis(x2 concurrent)"]?.findings ?? "",
      stageMs: r.stageMs ? JSON.stringify(r.stageMs) : "",
      footprint: r.footprint ? JSON.stringify(r.footprint) : "",
    });
  }
  console.table(rows);
  console.log(`\nraw results: ${file}`);
}

const args = parseArgs(process.argv);
if (args.child) await runChild(args.child);
else await runParent(args);
