import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  blockMission,
  canTransition,
  claimNextMission,
  fileMission,
  formatMissionForPrompt,
  getMission,
  landMission,
  listStations,
  missionsPath,
  readMissions,
  stationId,
  stationPrefix,
  summarizeStation,
  updateMission,
} from "../src/orbit-ledger.js";

function freshMeta(): string {
  return mkdtempSync(join(tmpdir(), "orbit-ledger-"));
}

const lintMission = {
  station: "faciliq-platform-core",
  title: "Clear workflow-builder react-hooks lint",
  intent: "Lint noise hides real regressions in the workflow builder.",
  acceptance: ["eslint reports zero errors for @faciliq/web"],
  verify: "pnpm --filter @faciliq/web run test && lint",
};

test("stationId and stationPrefix derive stable identifiers from a repo path", () => {
  assert.equal(stationId("/Users/me/Desktop/faciliq-platform-core"), "faciliq-platform-core");
  assert.equal(stationId("/Users/me/Desktop/faciliq-platform-core/"), "faciliq-platform-core");
  assert.equal(stationId("/Users/me/Projects/My Repo"), "my-repo");
  assert.equal(stationPrefix("faciliq-platform-core"), "fa");
  assert.equal(stationPrefix("x"), "xx");
  assert.equal(stationPrefix("---"), "ms");
});

test("fileMission opens a mission with a station-prefixed id", () => {
  const metaDir = freshMeta();
  const mission = fileMission(lintMission, metaDir);

  assert.match(mission.id, /^fa-[a-z0-9]{5}$/);
  assert.equal(mission.status, "open");
  assert.equal(mission.severity, "normal");
  assert.equal(mission.intent, lintMission.intent);
  assert.deepEqual(mission.acceptance, lintMission.acceptance);

  const stored = readMissions(lintMission.station, metaDir);
  assert.equal(stored.length, 1);
  assert.equal(stored[0]?.id, mission.id);
});

test("claimNextMission assigns one coder and prevents a second from taking it", () => {
  const metaDir = freshMeta();
  const first = fileMission(lintMission, metaDir);

  const claimed = claimNextMission(lintMission.station, "coder-1", metaDir);
  assert.equal(claimed?.id, first.id);
  assert.equal(claimed?.status, "claimed");
  assert.equal(claimed?.claimedBy, "coder-1");

  // Nothing else is open, so a second coder gets no work rather than colliding.
  assert.equal(claimNextMission(lintMission.station, "coder-2", metaDir), null);
});

test("claimNextMission prefers high severity, then creation order", () => {
  const metaDir = freshMeta();
  fileMission({ ...lintMission, title: "low", severity: "low" }, metaDir);
  fileMission({ ...lintMission, title: "normal" }, metaDir);
  const urgent = fileMission({ ...lintMission, title: "urgent", severity: "high" }, metaDir);

  const claimed = claimNextMission(lintMission.station, "coder-1", metaDir);
  assert.equal(claimed?.id, urgent.id);
});

test("claimNextMission returns the in-flight mission back to its original coder", () => {
  const metaDir = freshMeta();
  const mission = fileMission(lintMission, metaDir);
  claimNextMission(lintMission.station, "coder-1", metaDir);
  updateMission(lintMission.station, mission.id, { status: "active" }, metaDir);

  const resumed = claimNextMission(lintMission.station, "coder-1", metaDir);
  assert.equal(resumed?.id, mission.id);
  assert.equal(resumed?.status, "active");
});

test("landMission refuses to close without commits and a passing verify", () => {
  const metaDir = freshMeta();
  const mission = fileMission(lintMission, metaDir);
  claimNextMission(lintMission.station, "coder-1", metaDir);
  updateMission(lintMission.station, mission.id, { status: "active" }, metaDir);

  const noCommits = landMission(
    lintMission.station,
    mission.id,
    { commits: [], tests: { passed: true } },
    metaDir,
  );
  assert.match(noCommits.error ?? "", /no commits recorded/);

  const failingTests = landMission(
    lintMission.station,
    mission.id,
    { commits: ["b6930f5"], tests: { passed: false } },
    metaDir,
  );
  assert.match(failingTests.error ?? "", /verify command did not pass/);

  assert.equal(getMission(lintMission.station, mission.id, metaDir)?.status, "active");
});

test("landMission closes the mission when evidence holds", () => {
  const metaDir = freshMeta();
  const mission = fileMission(lintMission, metaDir);
  claimNextMission(lintMission.station, "coder-1", metaDir);
  updateMission(lintMission.station, mission.id, { status: "active" }, metaDir);

  const landed = landMission(
    lintMission.station,
    mission.id,
    {
      commits: ["b6930f5"],
      filesChanged: 14,
      tests: { passed: true, command: lintMission.verify },
    },
    metaDir,
  );

  assert.equal(landed.error, undefined);
  assert.equal(landed.mission?.status, "landed");
  assert.ok(landed.mission?.landedAt);
  assert.equal(landed.mission?.evidence?.filesChanged, 14);
});

test("landMission allows verify-only landing when batch policy held commits", () => {
  const metaDir = freshMeta();
  const mission = fileMission(lintMission, metaDir);
  claimNextMission(lintMission.station, "coder-1", metaDir);

  const landed = landMission(
    lintMission.station,
    mission.id,
    {
      commits: [],
      verifyOnly: true,
      tests: { passed: true, command: lintMission.verify },
    },
    metaDir,
  );

  assert.equal(landed.error, undefined);
  assert.equal(landed.mission?.status, "landed");
});

test("a claimed mission can land without an explicit active step", () => {
  const metaDir = freshMeta();
  const mission = fileMission(lintMission, metaDir);
  claimNextMission(lintMission.station, "coder-1", metaDir);

  const landed = landMission(
    lintMission.station,
    mission.id,
    { commits: ["b6930f5"], tests: { passed: true } },
    metaDir,
  );

  assert.equal(landed.error, undefined);
  assert.equal(landed.mission?.status, "landed");
  assert.equal(summarizeStation(lintMission.station, metaDir).drained, true);
});

test("updateMission rejects illegal transitions", () => {
  const metaDir = freshMeta();
  const mission = fileMission(lintMission, metaDir);

  const result = updateMission(lintMission.station, mission.id, { status: "landed" }, metaDir);
  assert.match(result.error ?? "", /Cannot move mission .* from open to landed/);
  assert.equal(getMission(lintMission.station, mission.id, metaDir)?.status, "open");
});

test("canTransition encodes the mission lifecycle", () => {
  assert.equal(canTransition("open", "claimed"), true);
  assert.equal(canTransition("active", "verified"), true);
  assert.equal(canTransition("verified", "landed"), true);
  assert.equal(canTransition("open", "landed"), false);
  assert.equal(canTransition("landed", "active"), false);
  assert.equal(canTransition("blocked", "active"), true);
});

test("blocking a mission records the reason and frees it for re-open", () => {
  const metaDir = freshMeta();
  const mission = fileMission(lintMission, metaDir);
  claimNextMission(lintMission.station, "coder-1", metaDir);

  const blocked = blockMission(
    lintMission.station,
    mission.id,
    "SDK run rate 20/20 per hour",
    metaDir,
  );
  assert.equal(blocked.mission?.status, "blocked");
  assert.match(blocked.mission?.blockedReason ?? "", /20\/20/);

  const reopened = updateMission(lintMission.station, mission.id, { status: "open" }, metaDir);
  assert.equal(reopened.mission?.status, "open");
  assert.equal(reopened.mission?.claimedBy, undefined);
});

test("summarizeStation reports drained only when no claimable work remains", () => {
  const metaDir = freshMeta();
  const empty = summarizeStation(lintMission.station, metaDir);
  assert.equal(empty.total, 0);
  assert.equal(empty.drained, true);

  const mission = fileMission(lintMission, metaDir);
  const opened = summarizeStation(lintMission.station, metaDir);
  assert.equal(opened.open, 1);
  assert.equal(opened.drained, false);
  assert.equal(opened.next?.id, mission.id);

  claimNextMission(lintMission.station, "coder-1", metaDir);
  const claimed = summarizeStation(lintMission.station, metaDir);
  assert.equal(claimed.inFlight, 1);
  assert.equal(claimed.active?.id, mission.id);
  assert.equal(claimed.drained, false);

  updateMission(lintMission.station, mission.id, { status: "active" }, metaDir);
  landMission(
    lintMission.station,
    mission.id,
    { commits: ["b6930f5"], tests: { passed: true } },
    metaDir,
  );

  const done = summarizeStation(lintMission.station, metaDir);
  assert.equal(done.landed, 1);
  assert.equal(done.inFlight, 0);
  assert.equal(done.drained, true);
});

test("readMissions applies last-write-wins and survives corrupt lines", () => {
  const metaDir = freshMeta();
  const mission = fileMission(lintMission, metaDir);

  const path = missionsPath(lintMission.station, metaDir);
  appendFileSync(path, "{ not json\n", "utf8");
  appendFileSync(path, "\n", "utf8");
  appendFileSync(path, `${JSON.stringify({ ...mission, title: "renamed" })}\n`, "utf8");

  const missions = readMissions(lintMission.station, metaDir);
  assert.equal(missions.length, 1);
  assert.equal(missions[0]?.title, "renamed");
});

test("listStations only reports directories holding a ledger", () => {
  const metaDir = freshMeta();
  assert.deepEqual(listStations(metaDir), []);

  fileMission(lintMission, metaDir);
  mkdirSync(join(metaDir, "orbit", "empty-station"), { recursive: true });

  assert.deepEqual(listStations(metaDir), [lintMission.station]);
});

test("formatMissionForPrompt states the why and refuses to invent work when idle", () => {
  const metaDir = freshMeta();
  const mission = fileMission(lintMission, metaDir);

  const prompt = formatMissionForPrompt(mission);
  assert.match(prompt, /^Mission fa-[a-z0-9]{5}: Clear workflow-builder react-hooks lint/);
  assert.match(prompt, /Why: Lint noise hides real regressions/);
  assert.match(prompt, /- eslint reports zero errors/);
  assert.match(prompt, /Verify with: pnpm/);

  assert.match(formatMissionForPrompt(null), /No mission assigned/);
});
