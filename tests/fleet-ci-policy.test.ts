import assert from "node:assert/strict";
import { test } from "node:test";

import { formatCiRulesForPrompt, resolveFleetCiPolicy } from "../src/fleet-ci-policy.js";
import { cursorMetaMcpRoot } from "../src/fleet-target.js";

test("resolveFleetCiPolicy defaults external repos to local validator with github watch", () => {
  const prevV = process.env.CURSOR_META_CI_VALIDATOR;
  const prevW = process.env.CURSOR_META_CI_WATCH;
  delete process.env.CURSOR_META_CI_VALIDATOR;
  delete process.env.CURSOR_META_CI_WATCH;
  try {
    const external = resolveFleetCiPolicy("/Users/me/Desktop/faciliq-platform-core");
    assert.equal(external.validator, "local");
    assert.equal(external.watchGithub, true);

    const selfTarget = resolveFleetCiPolicy(cursorMetaMcpRoot());
    assert.equal(selfTarget.validator, "local");
    assert.equal(selfTarget.watchGithub, false);
  } finally {
    if (prevV === undefined) delete process.env.CURSOR_META_CI_VALIDATOR;
    else process.env.CURSOR_META_CI_VALIDATOR = prevV;
    if (prevW === undefined) delete process.env.CURSOR_META_CI_WATCH;
    else process.env.CURSOR_META_CI_WATCH = prevW;
  }
});

test("resolveFleetCiPolicy respects env overrides", () => {
  const prevV = process.env.CURSOR_META_CI_VALIDATOR;
  const prevW = process.env.CURSOR_META_CI_WATCH;
  process.env.CURSOR_META_CI_VALIDATOR = "github";
  process.env.CURSOR_META_CI_WATCH = "0";
  try {
    const policy = resolveFleetCiPolicy("/Users/me/Desktop/faciliq-platform-core");
    assert.equal(policy.validator, "github");
    assert.equal(policy.watchGithub, false);
  } finally {
    if (prevV === undefined) delete process.env.CURSOR_META_CI_VALIDATOR;
    else process.env.CURSOR_META_CI_VALIDATOR = prevV;
    if (prevW === undefined) delete process.env.CURSOR_META_CI_WATCH;
    else process.env.CURSOR_META_CI_WATCH = prevW;
  }
});

test("formatCiRulesForPrompt tells workers not to push for CI validation", () => {
  const text = formatCiRulesForPrompt(
    { validator: "local", watchGithub: true },
    "pnpm --filter @faciliq/web run test && lint",
  );
  assert.match(text, /LOCAL ONLY/i);
  assert.match(text, /Do NOT push to trigger GitHub Actions/i);
  assert.match(text, /informational/i);
});
