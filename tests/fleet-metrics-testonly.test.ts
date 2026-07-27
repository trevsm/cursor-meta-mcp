import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  analyzeWorkerCheckpoint,
  markTickProductivity,
  productivityBreakdown,
} from "../src/fleet-metrics.js";
import type { TickOutcome } from "../src/tick-outcome.js";

function baseOutcome(overrides: Partial<TickOutcome> = {}): TickOutcome {
  return {
    headBefore: "a",
    headAfter: "b",
    committed: true,
    pushed: false,
    commits: 1,
    filesChanged: 1,
    insertions: 1,
    deletions: 0,
    dirtyFiles: 0,
    producedWork: true,
    ...overrides,
  };
}

test("productivityBreakdown caps test-only ticks at 1 per 3 feature ticks", () => {
  const feature = baseOutcome({ testOnly: false });
  const testOnly = baseOutcome({ testOnly: true, changedPaths: ["tests/x.test.ts"] });

  const breakdown = productivityBreakdown([
    feature,
    feature,
    feature,
    testOnly,
    testOnly,
  ]);
  assert.equal(breakdown.featureTicks, 3);
  assert.equal(breakdown.countedTestOnlyTicks, 1);
  assert.equal(breakdown.cappedTestOnlyTicks, 1);
  assert.equal(breakdown.productiveTicks, 4);
});

test("markTickProductivity sets countsAsProductive on capped test-only tick", () => {
  const prior: TickOutcome[] = [
    baseOutcome({ testOnly: false, countsAsProductive: true }),
    baseOutcome({ testOnly: false, countsAsProductive: true }),
  ];
  const capped = baseOutcome({ testOnly: true, changedPaths: ["tests/a.test.ts"] });
  markTickProductivity(capped, prior);
  assert.equal(capped.countsAsProductive, false);

  prior.push(baseOutcome({ testOnly: false, countsAsProductive: true }));
  const allowed = baseOutcome({ testOnly: true, changedPaths: ["tests/b.test.ts"] });
  markTickProductivity(allowed, prior);
  assert.equal(allowed.countsAsProductive, true);
});

test("analyzeWorkerCheckpoint applies test-only cap in productive ratio", () => {
  const dir = mkdtempSync(join(tmpdir(), "fleet-cap-"));
  const path = join(dir, "worker.json");
  writeFileSync(
    path,
    JSON.stringify({
      ticks: [
        { at: "2026-07-27T00:00:00.000Z", outcome: baseOutcome({ testOnly: false }) },
        { at: "2026-07-27T00:01:00.000Z", outcome: baseOutcome({ testOnly: false }) },
        { at: "2026-07-27T00:02:00.000Z", outcome: baseOutcome({ testOnly: true, changedPaths: ["tests/a.test.ts"] }) },
        { at: "2026-07-27T00:03:00.000Z", outcome: baseOutcome({ testOnly: true, changedPaths: ["tests/b.test.ts"] }) },
      ],
    }),
  );
  const metrics = analyzeWorkerCheckpoint(path);
  assert.equal(metrics?.featureTicks, 2);
  assert.equal(metrics?.countedTestOnlyTicks, 0);
  assert.equal(metrics?.cappedTestOnlyTicks, 2);
  assert.equal(metrics?.productiveTicks, 2);
  assert.equal(metrics?.productiveRatio, 0.5);
});
