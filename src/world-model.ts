import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface WorldGoal {
  id: string;
  text: string;
  status: "active" | "completed" | "abandoned";
  createdAt: string;
  completedAt?: string;
  parentId?: string;
}

export interface WorldBelief {
  id: string;
  text: string;
  verifiedAt: string;
  source?: string;
}

export interface WorldFailure {
  id: string;
  at: string;
  context: string;
  reason: string;
}

export interface WorldEpisode {
  id: string;
  at: string;
  actor?: string;
  observe?: string;
  action?: string;
  verify?: string;
  outcome?: "success" | "failure" | "partial";
  notes?: string;
}

export interface WorldModel {
  northStar?: string;
  updatedAt: string;
  goals: WorldGoal[];
  beliefs: WorldBelief[];
  failures: WorldFailure[];
}

export function defaultWorldDir(metaDir = join(homedir(), ".cursor-meta")): string {
  return join(metaDir, "world");
}

function goalsPath(metaDir?: string): string {
  return join(defaultWorldDir(metaDir), "goals.json");
}

function beliefsPath(metaDir?: string): string {
  return join(defaultWorldDir(metaDir), "beliefs.json");
}

function failuresPath(metaDir?: string): string {
  return join(defaultWorldDir(metaDir), "failures.json");
}

function episodesDir(metaDir?: string): string {
  return join(defaultWorldDir(metaDir), "episodes");
}

function readJsonFile<T>(path: string, fallback: T): T {
  if (!existsSync(path)) return fallback;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return fallback;
  }
}

function writeJsonFile(path: string, value: unknown): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function newId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function loadWorldModel(metaDir?: string): WorldModel {
  const goalsFile = readJsonFile<{ northStar?: string; updatedAt?: string; goals?: WorldGoal[] }>(
    goalsPath(metaDir),
    {},
  );
  const beliefsFile = readJsonFile<{ beliefs?: WorldBelief[] }>(beliefsPath(metaDir), {});
  const failuresFile = readJsonFile<{ failures?: WorldFailure[] }>(failuresPath(metaDir), {});
  return {
    northStar: goalsFile.northStar,
    updatedAt: goalsFile.updatedAt ?? new Date(0).toISOString(),
    goals: goalsFile.goals ?? [],
    beliefs: beliefsFile.beliefs ?? [],
    failures: failuresFile.failures ?? [],
  };
}

function saveGoals(metaDir: string | undefined, northStar: string | undefined, goals: WorldGoal[]): void {
  writeJsonFile(goalsPath(metaDir), {
    northStar,
    updatedAt: new Date().toISOString(),
    goals,
  });
}

export function setNorthStar(text: string, metaDir?: string): WorldModel {
  const model = loadWorldModel(metaDir);
  model.northStar = text.trim();
  saveGoals(metaDir, model.northStar, model.goals);
  return loadWorldModel(metaDir);
}

export function pushGoal(text: string, metaDir?: string, parentId?: string): WorldGoal {
  const model = loadWorldModel(metaDir);
  const goal: WorldGoal = {
    id: newId("goal"),
    text: text.trim(),
    status: "active",
    createdAt: new Date().toISOString(),
    parentId,
  };
  model.goals.push(goal);
  saveGoals(metaDir, model.northStar, model.goals);
  return goal;
}

export function completeGoal(goalId: string, metaDir?: string): WorldGoal | null {
  const model = loadWorldModel(metaDir);
  const goal = model.goals.find((row) => row.id === goalId);
  if (!goal) return null;
  goal.status = "completed";
  goal.completedAt = new Date().toISOString();
  saveGoals(metaDir, model.northStar, model.goals);
  return goal;
}

export function addBelief(text: string, metaDir?: string, source?: string): WorldBelief {
  const model = loadWorldModel(metaDir);
  const belief: WorldBelief = {
    id: newId("belief"),
    text: text.trim(),
    verifiedAt: new Date().toISOString(),
    source,
  };
  model.beliefs.push(belief);
  writeJsonFile(beliefsPath(metaDir), { beliefs: model.beliefs });
  return belief;
}

export function recordFailure(context: string, reason: string, metaDir?: string): WorldFailure {
  const model = loadWorldModel(metaDir);
  const failure: WorldFailure = {
    id: newId("fail"),
    at: new Date().toISOString(),
    context: context.trim(),
    reason: reason.trim(),
  };
  model.failures.push(failure);
  writeJsonFile(failuresPath(metaDir), { failures: model.failures.slice(-200) });
  return failure;
}

export function appendEpisode(episode: Omit<WorldEpisode, "id"> & { id?: string }, metaDir?: string): WorldEpisode {
  const dir = episodesDir(metaDir);
  mkdirSync(dir, { recursive: true });
  const day = episode.at.slice(0, 10);
  const record: WorldEpisode = {
    id: episode.id ?? newId("ep"),
    at: episode.at,
    actor: episode.actor,
    observe: episode.observe,
    action: episode.action,
    verify: episode.verify,
    outcome: episode.outcome,
    notes: episode.notes,
  };
  appendFileSync(join(dir, `${day}.jsonl`), `${JSON.stringify(record)}\n`, "utf8");
  return record;
}

export function recentEpisodes(metaDir?: string, max = 20): WorldEpisode[] {
  const dir = episodesDir(metaDir);
  if (!existsSync(dir)) return [];
  const files = readdirSync(dir)
    .filter((name) => name.endsWith(".jsonl"))
    .sort()
    .reverse();
  const episodes: WorldEpisode[] = [];
  for (const name of files) {
    const lines = readFileSync(join(dir, name), "utf8").split(/\r?\n/).filter(Boolean);
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      try {
        episodes.push(JSON.parse(lines[i]!) as WorldEpisode);
        if (episodes.length >= max) return episodes;
      } catch {
        /* skip malformed line */
      }
    }
  }
  return episodes;
}

export function activeGoals(model: WorldModel): WorldGoal[] {
  return model.goals.filter((goal) => goal.status === "active");
}

export function formatWorldModelForPrompt(model: WorldModel, episodes = recentEpisodes()): string {
  const parts: string[] = [];
  if (model.northStar) parts.push(`North star: ${model.northStar}`);
  const goals = activeGoals(model).slice(0, 5);
  if (goals.length) {
    parts.push(`Active goals: ${goals.map((g) => g.text).join("; ")}`);
  }
  const beliefs = model.beliefs.slice(-5);
  if (beliefs.length) {
    parts.push(`Recent beliefs: ${beliefs.map((b) => b.text).join("; ")}`);
  }
  const failures = model.failures.slice(-3);
  if (failures.length) {
    parts.push(`Recent failures: ${failures.map((f) => `${f.context} → ${f.reason}`).join("; ")}`);
  }
  const recent = episodes.slice(0, 5);
  if (recent.length) {
    parts.push(
      `Recent episodes: ${recent
        .map((ep) => {
          const bits = [ep.actor, ep.action, ep.outcome].filter(Boolean);
          return bits.join(" · ");
        })
        .join(" | ")}`,
    );
  }
  return parts.join(". ");
}
