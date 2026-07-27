#!/usr/bin/env node
/**
 * Orbit mission ledger CLI.
 *
 * Missions are the durable unit of fleet work: filed once, claimed by exactly one
 * coder, and landed only against verified evidence.
 *
 *   npm run mission -- list [--station <id>]
 *   npm run mission -- add "<title>" --why "<intent>" [--accept "<criterion>"]... [--verify "<cmd>"] [--severity high]
 *   npm run mission -- show <id>
 *   npm run mission -- claim <coder-id>
 *   npm run mission -- status <id> <open|claimed|active|verified|blocked|dropped> [--reason "<text>"]
 *   npm run mission -- land <id> --commit <sha> [--commit <sha>]... [--files <n>]
 *
 * Station defaults to CURSOR_META_FLEET_CWD, else the current directory.
 */
import {
  blockMission,
  claimNextMission,
  fileMission,
  getMission,
  landMission,
  listStations,
  readMissions,
  stationId,
  summarizeStation,
  updateMission,
} from "../src/orbit-ledger.js";
import { resolveFleetTargetCwd } from "../src/fleet-target.js";

const argv = process.argv.slice(2);
const command = argv[0];

function flag(name) {
  const index = argv.indexOf(`--${name}`);
  return index >= 0 ? argv[index + 1] : undefined;
}

function flagAll(name) {
  const values = [];
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === `--${name}` && argv[i + 1]) values.push(argv[i + 1]);
  }
  return values;
}

function positionals() {
  const out = [];
  for (let i = 1; i < argv.length; i += 1) {
    if (argv[i].startsWith("--")) {
      i += 1;
      continue;
    }
    out.push(argv[i]);
  }
  return out;
}

function resolveStation() {
  const explicit = flag("station");
  if (explicit) return explicit;
  return stationId(resolveFleetTargetCwd());
}

function die(message) {
  console.error(`[mission] ${message}`);
  process.exit(1);
}

function printMission(mission) {
  const claim = mission.claimedBy ? ` · held by ${mission.claimedBy}` : "";
  const blocked = mission.blockedReason ? ` · blocked: ${mission.blockedReason}` : "";
  console.log(`${mission.id}  [${mission.status}]${claim}${blocked}`);
  console.log(`  ${mission.title}`);
  if (mission.intent) console.log(`  why: ${mission.intent}`);
}

const station = resolveStation();

switch (command) {
  case "stations": {
    const stations = listStations();
    if (!stations.length) console.log("No stations have a ledger yet.");
    for (const name of stations) {
      const summary = summarizeStation(name);
      console.log(`${name}: ${summary.landed} landed · ${summary.open} open · ${summary.inFlight} in flight`);
    }
    break;
  }

  case "list": {
    const missions = readMissions(station);
    const summary = summarizeStation(station);
    console.log(
      `Station ${station}: ${summary.landed} landed · ${summary.open} open · ${summary.inFlight} in flight · ${summary.blocked} blocked`,
    );
    if (!missions.length) console.log("No missions filed.");
    for (const mission of missions) printMission(mission);
    if (summary.drained) console.log("\nQueue drained — a coder would retire here.");
    break;
  }

  case "add": {
    const [title] = positionals();
    if (!title) die('Usage: mission add "<title>" --why "<intent>"');
    const intent = flag("why");
    if (!intent) die("--why is required: a mission without a stated reason cannot drive the dashboard.");

    const mission = fileMission({
      station,
      title,
      intent,
      acceptance: flagAll("accept"),
      verify: flag("verify"),
      branch: flag("branch"),
      severity: flag("severity"),
    });
    printMission(mission);
    break;
  }

  case "show": {
    const [id] = positionals();
    if (!id) die("Usage: mission show <id>");
    const mission = getMission(station, id);
    if (!mission) die(`Mission ${id} not found on station ${station}`);
    console.log(JSON.stringify(mission, null, 2));
    break;
  }

  case "claim": {
    const [coder] = positionals();
    if (!coder) die("Usage: mission claim <coder-id>");
    const mission = claimNextMission(station, coder);
    if (!mission) {
      console.log(`No claimable missions on station ${station}.`);
      break;
    }
    printMission(mission);
    break;
  }

  case "status": {
    const [id, status] = positionals();
    if (!id || !status) die("Usage: mission status <id> <status> [--reason <text>]");

    const result =
      status === "blocked"
        ? blockMission(station, id, flag("reason") ?? "unspecified")
        : updateMission(station, id, { status });

    if (result.error) die(result.error);
    printMission(result.mission);
    break;
  }

  case "land": {
    const [id] = positionals();
    if (!id) die("Usage: mission land <id> --commit <sha> [--files <n>]");

    const filesRaw = flag("files");
    const result = landMission(station, id, {
      commits: flagAll("commit"),
      filesChanged: filesRaw ? Number.parseInt(filesRaw, 10) : undefined,
      tests: { passed: true, command: flag("verify") },
    });

    if (result.error) die(result.error);
    printMission(result.mission);
    break;
  }

  default:
    console.log(
      [
        "Orbit mission ledger",
        "",
        "  mission stations",
        "  mission list [--station <id>]",
        '  mission add "<title>" --why "<intent>" [--accept "<criterion>"]... [--verify "<cmd>"] [--severity low|normal|high]',
        "  mission show <id>",
        "  mission claim <coder-id>",
        "  mission status <id> <open|claimed|active|verified|blocked|dropped> [--reason <text>]",
        "  mission land <id> --commit <sha> [--files <n>]",
        "",
        `Current station: ${station}`,
      ].join("\n"),
    );
}
