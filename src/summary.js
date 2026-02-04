// src/summary.js
import fs from "node:fs";

function safeInt(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

export function parseJUnitTotals(junitXmlPath) {
  const xml = fs.readFileSync(junitXmlPath, "utf-8");

  // Match <testsuite ...> opening tags and read attributes
  const re = /<testsuite\b([^>]*)>/g;
  let m;
  let total = 0, failures = 0, skipped = 0;
  while ((m = re.exec(xml)) !== null) {
    const attrs = m[1] || "";
    const get = (name) => {
      const mm = new RegExp(`${name}="([^"]*)"`).exec(attrs);
      return mm ? mm[1] : "";
    };
    total += safeInt(get("tests"));
    failures += safeInt(get("failures")) + safeInt(get("errors"));
    skipped += safeInt(get("skipped"));
  }
  const passed = Math.max(total - failures - skipped, 0);
  return { total, passed, failed: failures, skipped };
}

export function buildSummaryFromJUnit(params) {
  const tests = parseJUnitTotals(params.junitLocalPath);
  const status = tests.failed > 0 ? "failed" : "passed";
  const durationSec = Math.max(
    0,
    Math.round((new Date(params.finishedAt).getTime() - new Date(params.startedAt).getTime()) / 1000),
  );

  return {
    runId: params.runId,
    project: params.project,
    branch: params.branch,
    commit: params.commit,
    startedAt: params.startedAt,
    finishedAt: params.finishedAt,
    durationSec,
    status,
    tests,
    shards: params.shards,
    links: {
      htmlPrefix: params.htmlPrefixInBucket,
      junitPath: params.junitPathInBucket,
    },
    meta: params.meta ?? {},
  };
}
