import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { homedir } from "node:os";
import { join } from "node:path";
import { mock, test } from "node:test";

type SpawnHandler = (
  command: string,
  args: string[],
  options: { cwd?: string; stdio?: unknown; env?: NodeJS.ProcessEnv },
) => EventEmitter & { stdout: EventEmitter; stderr: EventEmitter };

const spawnMock = mock.fn<SpawnHandler>();

mock.module("node:child_process", {
  namedExports: {
    spawn: spawnMock,
  },
});

const {
  agentCliWhoami,
  isAgentCliLoggedIn,
  runAgentCliPrompt,
  shouldUseAgentCliFallback,
} = await import("../src/agent-cli.js");

function mockSpawnResult(stdout: string, exitCode = 0, stderr = "") {
  return (...args: Parameters<SpawnHandler>) => {
    const child = new EventEmitter() as ReturnType<SpawnHandler>;
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    queueMicrotask(() => {
      if (stdout) child.stdout.emit("data", Buffer.from(stdout));
      if (stderr) child.stderr.emit("data", Buffer.from(stderr));
      child.emit("close", exitCode);
    });
    spawnMock.mock.calls.push({ arguments: args });
    return child;
  };
}

test("shouldUseAgentCliFallback is true without an api key", () => {
  assert.equal(shouldUseAgentCliFallback(undefined), true);
  assert.equal(shouldUseAgentCliFallback(""), true);
  assert.equal(shouldUseAgentCliFallback("cursor_test"), false);
});

test("isAgentCliLoggedIn checks agent status output", async () => {
  spawnMock.mock.mockImplementation((_command, args, options) =>
    mockSpawnResult("Logged in as cli@example.com\n")(_command, args, options),
  );
  assert.equal(await isAgentCliLoggedIn(), true);

  spawnMock.mock.mockImplementation((_command, args, options) =>
    mockSpawnResult("Not logged in\n")(_command, args, options),
  );
  assert.equal(await isAgentCliLoggedIn(), false);
});

test("agentCliWhoami parses the logged-in email", async () => {
  spawnMock.mock.mockImplementation(mockSpawnResult("Logged in as cli@example.com\n"));
  assert.deepEqual(await agentCliWhoami(), {
    apiKeyName: "cursor-agent-cli",
    userEmail: "cli@example.com",
  });
});

test("agentCliWhoami surfaces CLI failures", async () => {
  spawnMock.mock.mockImplementation(mockSpawnResult("", 1, "agent missing"));
  await assert.rejects(() => agentCliWhoami(), /agent missing/);
});

test("runAgentCliPrompt requires login and forwards args", async () => {
  spawnMock.mock.mockImplementation((_command, args) =>
    mockSpawnResult(args[0] === "status" ? "Logged in as cli@example.com\n" : "done\n")(
      _command,
      args,
      {},
    ),
  );

  const result = await runAgentCliPrompt({
    prompt: "hello",
    cwd: process.cwd(),
    mode: "ask",
    model: "composer-2.5",
  });

  assert.deepEqual(result, { status: "finished", result: "done" });
  const promptCall = spawnMock.mock.calls.find((call) => call.arguments[1]?.includes("-p"));
  assert.ok(promptCall);
  assert.equal(promptCall.arguments[0], join(homedir(), ".local/bin/agent"));
  assert.deepEqual(promptCall.arguments[1], [
    "-p",
    "--trust",
    "--output-format",
    "text",
    "--mode",
    "ask",
    "--model",
    "composer-2.5",
    "hello",
  ]);
});

test("createAgentChat returns a UUID", async () => {
  spawnMock.mock.mockImplementation((_command, args) =>
    mockSpawnResult(
      args[0] === "status" ? "Logged in as cli@example.com\n" : "70214411-ee56-427f-8ce1-9a87a737b0ab\n",
    )(_command, args, {}),
  );

  const { createAgentChat } = await import("../src/agent-cli.js");
  assert.equal(await createAgentChat(), "70214411-ee56-427f-8ce1-9a87a737b0ab");
});

test("runAgentCliResume forwards resume args", async () => {
  spawnMock.mock.mockImplementation((_command, args) =>
    mockSpawnResult(args[0] === "status" ? "Logged in as cli@example.com\n" : "steered\n")(
      _command,
      args,
      {},
    ),
  );

  const { runAgentCliResume } = await import("../src/agent-cli.js");
  const result = await runAgentCliResume({
    chatId: "5f88619f-f87c-482a-8f6d-829045660f78",
    prompt: "steer please",
    cwd: process.cwd(),
    workspace: process.cwd(),
    mode: "plan",
    model: "composer-2.5",
  });

  assert.deepEqual(result, { status: "finished", result: "steered" });
  const resumeCall = spawnMock.mock.calls.find((call) => call.arguments[1]?.includes("--resume"));
  assert.ok(resumeCall);
  assert.deepEqual(resumeCall.arguments[1]?.slice(0, 8), [
    "-p",
    "--trust",
    "--resume",
    "5f88619f-f87c-482a-8f6d-829045660f78",
    "--output-format",
    "text",
    "--mode",
    "plan",
  ]);
});

test("runAgentCliPrompt rejects when CLI is not logged in", async () => {
  spawnMock.mock.mockImplementation(mockSpawnResult("Not logged in\n"));
  await assert.rejects(
    () => runAgentCliPrompt({ prompt: "hello", cwd: process.cwd() }),
    /not logged in/i,
  );
});
