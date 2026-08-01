/**
 * Per-worker port allocation.
 *
 * Every coder runs the same verify command in its own worktree on one machine.
 * The moment that command starts a server — a Playwright web server, an API
 * under test — all of them race for the same fixed port and every loser gets
 * EADDRINUSE. The gate then blocks their tick and tells them their work failed
 * verification, when a peer took the port. A false failure that reads as the
 * coder's fault.
 *
 * Giving each coder a disjoint port block removes the race. The mapping is
 * declared per target repo rather than hardcoded, because which variables carry
 * ports is a property of the project, not of the fleet.
 */

export const WORKER_PORT_SPEC_ENV = "CURSOR_META_WORKER_PORT_ENV";
export const WORKER_PORT_BASE_ENV = "CURSOR_META_WORKER_PORT_BASE";
export const WORKER_PORT_STRIDE_ENV = "CURSOR_META_WORKER_PORT_STRIDE";

/** Exported to every worker so a project can build its own values from it. */
export const WORKER_PORT_BASE_OUT = "CURSOR_META_PORT_BASE";
export const WORKER_INDEX_OUT = "CURSOR_META_WORKER_INDEX";

const DEFAULT_BASE = 3000;
/** Wide enough for a project to claim several consecutive ports per worker. */
const DEFAULT_STRIDE = 20;

function intFromEnv(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const parsed = Number.parseInt(env[name] ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/** First port of the block owned by a 1-based worker index. */
export function workerPortBase(index: number, env: NodeJS.ProcessEnv = process.env): number {
  const base = intFromEnv(env, WORKER_PORT_BASE_ENV, DEFAULT_BASE);
  const stride = intFromEnv(env, WORKER_PORT_STRIDE_ENV, DEFAULT_STRIDE);
  return base + Math.max(0, index - 1) * stride;
}

/**
 * Expand `{port}` and `{port+N}` against a worker's block.
 *
 * Exposed so a URL-shaped variable can carry a port too — `FACILIQ_API_URL`
 * needs `http://127.0.0.1:3008`, not `3008`.
 */
export function expandPortTemplate(template: string, portBase: number): string {
  return template.replace(/\{port(?:\s*\+\s*(\d+))?\}/g, (_match, offset?: string) =>
    String(portBase + (offset ? Number.parseInt(offset, 10) : 0)),
  );
}

/**
 * Parse the spec into concrete env for one worker.
 *
 * Entries are comma separated and take either form:
 *   `E2E_WEB_PORT`                              → the worker's base port
 *   `FACILIQ_API_URL=http://127.0.0.1:{port+8}` → template expanded
 */
export function resolveWorkerPortEnv(
  index: number,
  env: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const portBase = workerPortBase(index, env);
  const out: Record<string, string> = {
    [WORKER_INDEX_OUT]: String(index),
    [WORKER_PORT_BASE_OUT]: String(portBase),
  };

  const spec = env[WORKER_PORT_SPEC_ENV]?.trim();
  if (!spec) return out;

  for (const raw of spec.split(",")) {
    const entry = raw.trim();
    if (!entry) continue;

    const eq = entry.indexOf("=");
    if (eq < 0) {
      out[entry] = String(portBase);
      continue;
    }

    const name = entry.slice(0, eq).trim();
    if (!name) continue;
    out[name] = expandPortTemplate(entry.slice(eq + 1).trim(), portBase);
  }

  return out;
}

/** Human-readable summary for preflight and launch logs. */
export function describeWorkerPorts(index: number, env: NodeJS.ProcessEnv = process.env): string {
  const assigned = resolveWorkerPortEnv(index, env);
  const notable = Object.entries(assigned).filter(
    ([name]) => name !== WORKER_INDEX_OUT && name !== WORKER_PORT_BASE_OUT,
  );
  if (notable.length === 0) return `ports: base ${workerPortBase(index, env)} (no spec set)`;
  return notable.map(([name, value]) => `${name}=${value}`).join(" ");
}
