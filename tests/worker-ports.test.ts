import assert from "node:assert/strict";
import { test } from "node:test";

const {
  describeWorkerPorts,
  expandPortTemplate,
  resolveWorkerPortEnv,
  workerPortBase,
} = await import("../src/worker-ports.js");

test("each worker gets a disjoint port block", () => {
  const env = {} as NodeJS.ProcessEnv;
  const bases = [1, 2, 3].map((i) => workerPortBase(i, env));

  assert.deepEqual(bases, [3000, 3020, 3040]);
  assert.equal(new Set(bases).size, 3, "blocks must not overlap or three workers race the same port");
});

test("base and stride are configurable per target repo", () => {
  const env = {
    CURSOR_META_WORKER_PORT_BASE: "9000",
    CURSOR_META_WORKER_PORT_STRIDE: "5",
  } as NodeJS.ProcessEnv;

  assert.equal(workerPortBase(1, env), 9000);
  assert.equal(workerPortBase(3, env), 9010);
});

test("a bare name gets the worker's base port", () => {
  const env = { CURSOR_META_WORKER_PORT_ENV: "E2E_WEB_PORT" } as NodeJS.ProcessEnv;

  assert.equal(resolveWorkerPortEnv(1, env).E2E_WEB_PORT, "3000");
  assert.equal(resolveWorkerPortEnv(2, env).E2E_WEB_PORT, "3020");
});

test("a template carries a port into a URL-shaped variable", () => {
  const env = {
    CURSOR_META_WORKER_PORT_ENV: "E2E_WEB_PORT,FACILIQ_API_URL=http://127.0.0.1:{port+8}",
  } as NodeJS.ProcessEnv;

  const worker2 = resolveWorkerPortEnv(2, env);
  assert.equal(worker2.E2E_WEB_PORT, "3020");
  assert.equal(
    worker2.FACILIQ_API_URL,
    "http://127.0.0.1:3028",
    "an API URL needs the port inside it, not the bare number",
  );
});

test("expandPortTemplate handles both offset forms", () => {
  assert.equal(expandPortTemplate("{port}", 3000), "3000");
  assert.equal(expandPortTemplate("{port+3}", 3000), "3003");
  assert.equal(expandPortTemplate("{port + 3}", 3000), "3003");
  assert.equal(expandPortTemplate("http://h:{port}/x/{port+1}", 500), "http://h:500/x/501");
});

test("workers always learn their index and base even with no spec", () => {
  const assigned = resolveWorkerPortEnv(3, {} as NodeJS.ProcessEnv);

  assert.equal(assigned.CURSOR_META_WORKER_INDEX, "3");
  assert.equal(assigned.CURSOR_META_PORT_BASE, "3040");
});

test("the three faciliq playwright ports never collide across workers", () => {
  // playwright.config.ts derives web, readonly, bootstrap and restricted ports
  // as base..base+3, so a stride of 20 must keep every worker's four clear of
  // the next worker's.
  const env = { CURSOR_META_WORKER_PORT_ENV: "E2E_WEB_PORT" } as NodeJS.ProcessEnv;
  const claimed = new Set<number>();

  for (const index of [1, 2, 3]) {
    const base = Number(resolveWorkerPortEnv(index, env).E2E_WEB_PORT);
    for (let offset = 0; offset <= 3; offset += 1) {
      const port = base + offset;
      assert.ok(!claimed.has(port), `port ${port} claimed by two workers`);
      claimed.add(port);
    }
  }

  assert.equal(claimed.size, 12);
});

test("describeWorkerPorts says so when no spec is configured", () => {
  assert.match(describeWorkerPorts(1, {} as NodeJS.ProcessEnv), /no spec set/);
  assert.match(
    describeWorkerPorts(2, { CURSOR_META_WORKER_PORT_ENV: "E2E_WEB_PORT" } as NodeJS.ProcessEnv),
    /E2E_WEB_PORT=3020/,
  );
});
