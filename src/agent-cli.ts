import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const AGENT_BIN = join(homedir(), ".local/bin/agent");

export interface AgentCliRunResult {
  agentId?: string;
  runId?: string;
  status: string;
  result: string;
}

async function agentBinExists(): Promise<boolean> {
  try {
    await access(AGENT_BIN);
    return true;
  } catch {
    return false;
  }
}

export async function isAgentCliLoggedIn(): Promise<boolean> {
  if (!(await agentBinExists())) return false;
  return new Promise((resolve) => {
    // Never shell:true — prompts contain `;`/`()`/`\n` and would be executed by sh
    // (e.g. "Minimize scope; ship small…" → `/bin/sh: ship: command not found`).
    const child = spawn(AGENT_BIN, ["status"], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let settled = false;
    const finish = (value: boolean) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.on("error", () => finish(false));
    child.on("close", () => {
      finish(stdout.includes("Logged in as"));
    });
  });
}

const AGENT_MISSING =
  "Cursor Agent CLI not installed. Run: cursor agent (from Cursor app bin).";

async function requireAgentBin(): Promise<void> {
  if (!(await agentBinExists())) {
    throw new Error(AGENT_MISSING);
  }
}

export async function agentCliWhoami(): Promise<{
  apiKeyName: string;
  userEmail?: string;
}> {
  await requireAgentBin();
  const stdout = await runAgentCommand(["status"]);
  const emailMatch = stdout.match(/Logged in as\s+(.+)/);
  return {
    apiKeyName: "cursor-agent-cli",
    userEmail: emailMatch?.[1]?.trim(),
  };
}

function runAgentCommand(args: string[], cwd?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(AGENT_BIN, args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", (error) => {
      const err = error as NodeJS.ErrnoException;
      if (err.code === "ENOENT") {
        reject(new Error(`spawn ${AGENT_BIN} ENOENT — ${AGENT_MISSING}`));
        return;
      }
      reject(error);
    });
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(stderr.trim() || stdout.trim() || `agent exited ${code}`));
        return;
      }
      resolve(stdout.trim());
    });
  });
}

async function requireAgentCliLoggedIn(): Promise<void> {
  await requireAgentBin();
  if (!(await isAgentCliLoggedIn())) {
    throw new Error(
      "Cursor Agent CLI is not logged in. Run: ~/.local/bin/agent login",
    );
  }
}

export async function createAgentChat(): Promise<string> {
  await requireAgentCliLoggedIn();
  const chatId = await runAgentCommand(["create-chat"]);
  if (!/^[0-9a-f-]{36}$/i.test(chatId)) {
    throw new Error(`Unexpected create-chat output: ${chatId}`);
  }
  return chatId;
}

export async function runAgentCliResume(params: {
  chatId: string;
  prompt: string;
  cwd: string;
  workspace?: string;
  mode?: "agent" | "plan" | "ask";
  model?: string;
}): Promise<AgentCliRunResult> {
  await requireAgentCliLoggedIn();

  const args = ["-p", "--trust", "--resume", params.chatId, "--output-format", "text"];
  if (params.mode === "plan" || params.mode === "ask") {
    args.push("--mode", params.mode);
  }
  if (params.workspace) {
    args.push("--workspace", params.workspace);
  }
  if (params.model) {
    args.push("--model", params.model);
  }
  args.push(params.prompt);

  const result = await runAgentCommand(args, params.cwd);
  return {
    status: "finished",
    result,
  };
}

export async function runAgentCliPrompt(params: {
  prompt: string;
  cwd: string;
  mode?: "agent" | "plan" | "ask";
  model?: string;
}): Promise<AgentCliRunResult> {
  await requireAgentCliLoggedIn();

  const args = ["-p", "--trust", "--output-format", "text"];
  if (params.mode === "plan" || params.mode === "ask") {
    args.push("--mode", params.mode);
  }
  if (params.model) {
    args.push("--model", params.model);
  }
  args.push(params.prompt);

  const result = await runAgentCommand(args, params.cwd);
  return {
    status: "finished",
    result,
  };
}

export function shouldUseAgentCliFallback(apiKey?: string): boolean {
  return !apiKey;
}
