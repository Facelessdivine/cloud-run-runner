import fs from "node:fs";
import { XMLParser } from "fast-xml-parser";

function asArray(v) {
  if (!v) return [];
  return Array.isArray(v) ? v : [v];
}
function safeInt(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

export function parseJUnitTotals(junitXmlPath) {
  const xml = fs.readFileSync(junitXmlPath, "utf-8");
  const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "" });
  const doc = parser.parse(xml);

  const suites = doc.testsuites?.testsuite
    ? asArray(doc.testsuites.testsuite)
    : asArray(doc.testsuite);

  let total = 0, failures = 0, skipped = 0;
  for (const s of suites) {
    total += safeInt(s.tests);
    failures += safeInt(s.failures) + safeInt(s.errors);
    skipped += safeInt(s.skipped);
  }
  const passed = Math.max(total - failures - skipped, 0);
  return { total, passed, failed: failures, skipped };
}

export function buildSummary({
  runId,
  project,
  branch,
  commit,
  startedAt,
  finishedAt,
  durationSec,
  shards,
  junitLocalPath,
  htmlPrefixInBucket,
  junitPathInBucket,
  meta,
}) {
  const tests = parseJUnitTotals(junitLocalPath);
  const status = tests.failed > 0 ? "failed" : "passed";

  return {
    runId,
    project,
    branch,
    commit,
    startedAt,
    finishedAt,
    durationSec,
    status,
    tests,
    shards,
    links: {
      htmlPrefix: htmlPrefixInBucket,
      junitPath: junitPathInBucket,
    },
    meta: meta ?? {},
  };
}
