import { isSelfImproveTarget } from "./fleet-target.js";

export type CiValidator = "local" | "github";

export interface FleetCiPolicy {
  /** Pass/fail gate for ticks — local runs test+lint; github is discouraged (CI minutes). */
  validator: CiValidator;
  /** Poll GitHub Actions for dashboard/watcher display only — never gates ticks. */
  watchGithub: boolean;
}

export interface GithubCiRun {
  id: number;
  status: string;
  conclusion: string | null;
  title: string;
  url: string;
  event: string;
  createdAt: string;
}

export interface GithubCiSnapshot {
  available: boolean;
  branch?: string;
  runs: GithubCiRun[];
  summary: string;
  error?: string;
}

export function resolveFleetCiPolicy(cwd?: string): FleetCiPolicy {
  const trimmed = cwd?.trim() ?? "";
  const externalTarget = trimmed.length > 0 && !isSelfImproveTarget(trimmed);

  const validatorRaw = process.env.CURSOR_META_CI_VALIDATOR?.trim().toLowerCase();
  let validator: CiValidator = "local";
  if (validatorRaw === "github") validator = "github";
  else if (validatorRaw === "local") validator = "local";
  else if (externalTarget) validator = "local";

  const watchRaw = process.env.CURSOR_META_CI_WATCH?.trim().toLowerCase();
  let watchGithub: boolean;
  if (watchRaw === "0" || watchRaw === "off" || watchRaw === "false") {
    watchGithub = false;
  } else if (watchRaw === "1" || watchRaw === "on" || watchRaw === "github" || watchRaw === "true") {
    watchGithub = true;
  } else {
    watchGithub = externalTarget;
  }

  return { validator, watchGithub };
}

export function formatCiRulesForPrompt(policy: FleetCiPolicy, verifyLabel: string): string {
  if (policy.validator === "local") {
    return [
      `CI gate: LOCAL ONLY — ${verifyLabel} must pass before claiming testsPass or pushing.`,
      "Do NOT push to trigger GitHub Actions for validation (limited CI minutes).",
      policy.watchGithub
        ? "The fleet watcher monitors GitHub CI passively after pushes — GH status is informational, not a tick gate."
        : "GitHub CI is not watched; local verify is the sole gate.",
    ].join(" ");
  }
  return [
    "CI gate: GitHub Actions (use sparingly — limited minutes).",
    "Prefer local verify before push.",
  ].join(" ");
}
