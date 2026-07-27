import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import { metaHome } from "./meta-home.js";

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

export interface WorldSkill {
  id: string;
  name: string;
  procedure: string;
  sourceEpisodeId?: string;
  createdAt: string;
}

export interface WorldModel {
  northStar?: string;
  updatedAt: string;
  goals: WorldGoal[];
  beliefs: WorldBelief[];
  failures: WorldFailure[];
}

export function defaultWorldDir(metaDir?: string): string {
  return join(metaDir ?? metaHome(), "world");
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

function skillsIndexPath(metaDir?: string): string {
  return join(defaultWorldDir(metaDir), "skills.json");
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

/** Collapse raced duplicate active goals with the same text (keep earliest). */
export function dedupeActiveGoals(goals: WorldGoal[]): WorldGoal[] {
  const seen = new Map<string, string>();
  const now = new Date().toISOString();
  return goals.map((goal) => {
    if (goal.status !== "active") return goal;
    const key = goal.text.trim().replace(/\s+/g, " ").toLowerCase();
    if (seen.has(key)) {
      return {
        ...goal,
        status: "abandoned" as const,
        completedAt: goal.completedAt ?? now,
      };
    }
    seen.set(key, goal.id);
    return goal;
  });
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
    goals: dedupeActiveGoals(goalsFile.goals ?? []),
    beliefs: beliefsFile.beliefs ?? [],
    failures: failuresFile.failures ?? [],
  };
}

function saveGoals(metaDir: string | undefined, northStar: string | undefined, goals: WorldGoal[]): void {
  writeJsonFile(goalsPath(metaDir), {
    northStar,
    updatedAt: new Date().toISOString(),
    goals: dedupeActiveGoals(goals),
  });
}

/** Persist deduped goals so raced fleet launches do not leave duplicate actives on disk. */
export function compactGoals(metaDir?: string): WorldModel {
  const model = loadWorldModel(metaDir);
  saveGoals(metaDir, model.northStar, model.goals);
  return loadWorldModel(metaDir);
}

export function setNorthStar(text: string, metaDir?: string): WorldModel {
  const model = loadWorldModel(metaDir);
  model.northStar = text.trim();
  saveGoals(metaDir, model.northStar, model.goals);
  return loadWorldModel(metaDir);
}

export function pushGoal(text: string, metaDir?: string, parentId?: string): WorldGoal {
  const model = loadWorldModel(metaDir);
  const trimmed = text.trim();
  const existing = model.goals.find((row) => row.status === "active" && row.text === trimmed);
  if (existing) {
    // Persist load-time dedupe so raced duplicate actives are abandoned on disk.
    saveGoals(metaDir, model.northStar, model.goals);
    return existing;
  }
  const goal: WorldGoal = {
    id: newId("goal"),
    text: trimmed,
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
  try {
    extractSkillFromEpisode(record, metaDir);
  } catch {
    /* skill extraction is best-effort */
  }
  return record;
}

export function listSkills(metaDir?: string): WorldSkill[] {
  const file = readJsonFile<{ skills?: WorldSkill[] }>(skillsIndexPath(metaDir), {});
  return file.skills ?? [];
}

export function saveSkill(
  skill: Omit<WorldSkill, "id" | "createdAt"> & { id?: string },
  metaDir?: string,
): WorldSkill {
  const skills = listSkills(metaDir);
  const procedure = skill.procedure.trim();
  const existing = skills.find((row) => row.procedure === procedure);
  if (existing) return existing;
  const record: WorldSkill = {
    id: skill.id ?? newId("skill"),
    name: skill.name.trim(),
    procedure,
    sourceEpisodeId: skill.sourceEpisodeId,
    createdAt: new Date().toISOString(),
  };
  skills.push(record);
  writeJsonFile(skillsIndexPath(metaDir), { skills: skills.slice(-100) });
  return record;
}

export function extractSkillFromEpisode(episode: WorldEpisode, metaDir?: string): WorldSkill | null {
  if (episode.outcome !== "success") return null;
  const verify = episode.verify?.trim();
  if (!verify || verify.length < 15) return null;
  const name = (episode.action ?? "verified procedure").slice(0, 80);
  const procedure = [episode.observe, episode.action, episode.verify].filter(Boolean).join(" → ");
  return saveSkill({ name, procedure, sourceEpisodeId: episode.id }, metaDir);
}

export function worldStatus(metaDir?: string, episodeLimit = 12): {
  model: WorldModel;
  episodes: WorldEpisode[];
  skills: WorldSkill[];
  summary: string;
} {
  const model = loadWorldModel(metaDir);
  const episodes = recentEpisodes(metaDir, episodeLimit);
  const skills = listSkills(metaDir);
  return {
    model,
    episodes,
    skills,
    summary: formatWorldModelForPrompt(model, episodes, skills),
  };
}

export type WorldRecordAction =
  | "set_north_star"
  | "push_goal"
  | "complete_goal"
  | "add_belief"
  | "record_failure";

export function applyWorldRecord(
  action: WorldRecordAction,
  fields: { text?: string; goalId?: string; context?: string; reason?: string; source?: string },
  metaDir?: string,
): unknown {
  switch (action) {
    case "set_north_star":
      if (!fields.text?.trim()) throw new Error("text is required for set_north_star");
      return setNorthStar(fields.text, metaDir);
    case "push_goal":
      if (!fields.text?.trim()) throw new Error("text is required for push_goal");
      return pushGoal(fields.text, metaDir);
    case "complete_goal":
      if (!fields.goalId?.trim()) throw new Error("goalId is required for complete_goal");
      return completeGoal(fields.goalId, metaDir);
    case "add_belief":
      if (!fields.text?.trim()) throw new Error("text is required for add_belief");
      return addBelief(fields.text, metaDir, fields.source);
    case "record_failure":
      if (!fields.context?.trim() || !fields.reason?.trim()) {
        throw new Error("context and reason are required for record_failure");
      }
      return recordFailure(fields.context, fields.reason, metaDir);
    default:
      throw new Error(`Unknown action: ${String(action)}`);
  }
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

export function formatWorldModelForPrompt(
  model: WorldModel,
  episodes = recentEpisodes(),
  skills: WorldSkill[] = [],
): string {
  const parts: string[] = [];
  if (model.northStar) parts.push(`North star: ${model.northStar}`);
  const goals = activeGoals(model).slice(0, 5);
  if (goals.length) {
    parts.push(`Active goals: ${goals.map((g) => g.text).join("; ")}`);
  }
  const beliefRows = model.beliefs.slice(-5);
  if (beliefRows.length) {
    parts.push(`Recent beliefs: ${beliefRows.map((b) => b.text).join("; ")}`);
  }
  const failureRows = model.failures.slice(-3);
  if (failureRows.length) {
    parts.push(`Recent failures: ${failureRows.map((f) => `${f.context} → ${f.reason}`).join("; ")}`);
  }
  const skillRows = skills.slice(-3);
  if (skillRows.length) {
    parts.push(`Known skills: ${skillRows.map((s) => s.name).join("; ")}`);
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
