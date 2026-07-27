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
    const child = spawn(AGENT_BIN, ["status"], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.on("close", () => {
      resolve(stdout.includes("Logged in as"));
    });
  });
}

export async function agentCliWhoami(): Promise<{
  apiKeyName: string;
  userEmail?: string;
}> {
  if (!(await agentBinExists())) {
    throw new Error("Cursor Agent CLI not installed. Run: cursor agent (from Cursor app bin).");
  }
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
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(stderr.trim() || stdout.trim() || `agent exited ${code}`));
        return;
      }
      resolve(stdout.trim());
    });
  });
}

export async function createAgentChat(): Promise<string> {
  if (!(await isAgentCliLoggedIn())) {
    throw new Error(
      "Cursor Agent CLI is not logged in. Run: ~/.local/bin/agent login",
    );
  }
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
  if (!(await isAgentCliLoggedIn())) {
    throw new Error(
      "Cursor Agent CLI is not logged in. Run: ~/.local/bin/agent login",
    );
  }

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
  if (!(await isAgentCliLoggedIn())) {
    throw new Error(
      "Cursor Agent CLI is not logged in. Run: ~/.local/bin/agent login",
    );
  }

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
