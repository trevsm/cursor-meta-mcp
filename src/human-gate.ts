import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { readActiveAgiSession } from "./agi-mission.js";
import { projectMetaDir, resolveProjectRoot } from "./project-meta.js";

/** CodeLayer-style trusted mode vs strict approval gates. */
export type HumanGateMode = "strict" | "standard" | "yolo";

/** HumanLayer: require_approval (binary gate) vs human_as_tool (advice/feedback). */
export type HumanContactKind = "require_approval" | "human_as_tool";

export type HumanApprovalStatus = "pending" | "approved" | "denied" | "expired";

export type HumanResponseFormat = "yes_no" | "free_text" | "multiple_choice";

export type HumanUrgency = "low" | "medium" | "high";

export type ActionRisk = "low" | "high" | "critical";

export interface HumanApprovalRequest {
  id: string;
  idempotencyKey?: string;
  sessionId: string;
  runId: string;
  kind: HumanContactKind;
  action: string;
  question: string;
  context?: string;
  urgency: HumanUrgency;
  format: HumanResponseFormat;
  choices?: string[];
  status: HumanApprovalStatus;
  createdAt: string;
  expiresAt: string;
  resolvedAt?: string;
  resolvedBy?: string;
  approved?: boolean;
  feedback?: string;
  cwd?: string;
}

export interface RequestHumanApprovalParams {
  question: string;
  action: string;
  kind?: HumanContactKind;
  context?: string;
  urgency?: HumanUrgency;
  format?: HumanResponseFormat;
  choices?: string[];
  sessionId?: string;
  runId?: string;
  cwd?: string;
  idempotencyKey?: string;
  timeoutMs?: number;
}

export interface ResolveHumanApprovalParams {
  id: string;
  approved?: boolean;
  feedback?: string;
  resolvedBy?: string;
  cwd?: string;
}

const DEFAULT_APPROVAL_TTL_MS = 24 * 60 * 60_000;

const HIGH_STAKES_RULES: Array<{ pattern: RegExp; action: string; risk: ActionRisk }> = [
  { pattern: /git\s+push\s+.*(-f|--force)/i, action: "git_force_push", risk: "critical" },
  { pattern: /\brm\s+-rf\b/i, action: "recursive_delete", risk: "critical" },
  { pattern: /(DROP|TRUNCATE)\s+(TABLE|DATABASE)/i, action: "db_destructive", risk: "critical" },
  { pattern: /\.env\b|credentials|secret|api[_-]?key/i, action: "secrets_path", risk: "critical" },
  { pattern: /npm\s+publish|docker\s+push|kubectl\s+apply|terraform\s+apply/i, action: "production_deploy", risk: "high" },
  { pattern: /\/api\/reset\b|wipeFleet|hard reset/i, action: "fleet_hard_reset", risk: "high" },
  { pattern: /meta_agi_adapt|workerMode.*ide|withOrchestrator:\s*false/i, action: "architecture_change", risk: "high" },
];

function approvalsPath(cwd?: string): string {
  const active = readActiveAgiSession();
  const root = cwd ? resolveProjectRoot(cwd) : active?.cwd;
  const dir = root ? projectMetaDir(root) : join(process.env.CURSOR_META_HOME ?? "", "global");
  return join(dir, "approvals.json");
}

function loadStore(path: string): HumanApprovalRequest[] {
  if (!existsSync(path)) return [];
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as { requests?: HumanApprovalRequest[] };
    return parsed.requests ?? [];
  } catch {
    return [];
  }
}

function saveStore(path: string, requests: HumanApprovalRequest[]): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({ requests, updatedAt: new Date().toISOString() }, null, 2));
}

export function classifyActionRisk(text: string): { risk: ActionRisk; action: string } {
  for (const rule of HIGH_STAKES_RULES) {
    if (rule.pattern.test(text)) {
      return { risk: rule.risk, action: rule.action };
    }
  }
  return { risk: "low", action: "general" };
}

export function requiresHumanApproval(
  text: string,
  mode: HumanGateMode = "standard",
): { required: boolean; risk: ActionRisk; action: string } {
  const { risk, action } = classifyActionRisk(text);
  if (mode === "yolo") return { required: false, risk, action };
  if (mode === "strict") return { required: risk !== "low", risk, action };
  return { required: risk === "critical", risk, action };
}

function findByIdempotency(requests: HumanApprovalRequest[], key: string): HumanApprovalRequest | undefined {
  return requests.find(
    (row) =>
      row.idempotencyKey === key &&
      row.status === "pending" &&
      Date.parse(row.expiresAt) > Date.now(),
  );
}

export function expireStaleApprovals(requests: HumanApprovalRequest[]): HumanApprovalRequest[] {
  const now = Date.now();
  return requests.map((row) =>
    row.status === "pending" && Date.parse(row.expiresAt) <= now
      ? { ...row, status: "expired" as const, resolvedAt: new Date().toISOString() }
      : row,
  );
}

export function requestHumanApproval(params: RequestHumanApprovalParams): HumanApprovalRequest {
  const path = approvalsPath(params.cwd);
  let requests = expireStaleApprovals(loadStore(path));

  if (params.idempotencyKey) {
    const existing = findByIdempotency(requests, params.idempotencyKey);
    if (existing) return existing;
  }

  const active = readActiveAgiSession();
  const sessionId = params.sessionId ?? active?.sessionId ?? randomUUID();
  const runId = params.runId ?? active?.runId ?? randomUUID();
  const ttl = params.timeoutMs ?? DEFAULT_APPROVAL_TTL_MS;
  const createdAt = new Date().toISOString();

  const request: HumanApprovalRequest = {
    id: randomUUID(),
    idempotencyKey: params.idempotencyKey,
    sessionId,
    runId,
    kind: params.kind ?? "require_approval",
    action: params.action,
    question: params.question.trim(),
    context: params.context?.trim(),
    urgency: params.urgency ?? "medium",
    format: params.format ?? (params.kind === "human_as_tool" ? "free_text" : "yes_no"),
    choices: params.choices,
    status: "pending",
    createdAt,
    expiresAt: new Date(Date.now() + ttl).toISOString(),
    cwd: params.cwd ? resolveProjectRoot(params.cwd) : active?.cwd,
  };

  requests.push(request);
  saveStore(path, requests);
  return request;
}

export function resolveHumanApproval(params: ResolveHumanApprovalParams): HumanApprovalRequest {
  const active = readActiveAgiSession();
  const path = approvalsPath(params.cwd ?? active?.cwd);
  let requests = expireStaleApprovals(loadStore(path));
  const index = requests.findIndex((row) => row.id === params.id);
  if (index < 0) {
    throw new Error(`Approval not found: ${params.id}`);
  }

  const current = requests[index]!;
  if (current.status !== "pending") {
    throw new Error(`Approval ${params.id} is already ${current.status}.`);
  }

  const approved =
    params.approved ??
    (params.feedback?.trim().toLowerCase().startsWith("yes") && current.format === "yes_no");

  const resolved: HumanApprovalRequest = {
    ...current,
    status: approved ? "approved" : "denied",
    approved,
    feedback: params.feedback?.trim(),
    resolvedAt: new Date().toISOString(),
    resolvedBy: params.resolvedBy ?? "conductor",
  };

  requests[index] = resolved;
  saveStore(path, requests);
  return resolved;
}

export function listPendingApprovals(cwd?: string): HumanApprovalRequest[] {
  const path = approvalsPath(cwd);
  return expireStaleApprovals(loadStore(path)).filter((row) => row.status === "pending");
}

export function listApprovals(cwd?: string, limit = 20): HumanApprovalRequest[] {
  const path = approvalsPath(cwd);
  return expireStaleApprovals(loadStore(path))
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
    .slice(0, limit);
}

/** Stable hash for idempotency keys derived from action text. */
export function idempotencyKeyForAction(action: string, sessionId: string): string {
  return createHash("sha256").update(`${sessionId}:${action}`).digest("hex").slice(0, 24);
}
