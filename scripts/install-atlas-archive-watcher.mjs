#!/usr/bin/env node
import { execSync } from "node:child_process";
import { copyFileSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { resolveWorkerNodeBin } from "../src/load-env.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const ICON_SRC = join(ROOT, "assets", "atlas-icon");
const PORT = Number(process.env.PORT ?? 3847);
const WATCHER_LABEL = "com.cursor-meta.atlas-archive";
const SERVER_LABEL = "com.cursor-meta.atlas-server";
const APP_LABEL = "com.cursor-meta.atlas-app";
const watcherPlistPath = join(homedir(), "Library/LaunchAgents", `${WATCHER_LABEL}.plist`);
const serverPlistPath = join(homedir(), "Library/LaunchAgents", `${SERVER_LABEL}.plist`);
const appPlistPath = join(homedir(), "Library/LaunchAgents", `${APP_LABEL}.plist`);
const logDir = join(homedir(), ".cursor-meta", "logs");
const binDir = join(homedir(), ".cursor-meta", "bin");
const appsDir = join(homedir(), ".cursor-meta", "Applications");
const appBundle = join(appsDir, "Conversation Atlas.app");
const appExecutable = join(appBundle, "Contents", "MacOS", "atlas-app");
const appBin = appExecutable;
const configPath = join(homedir(), ".cursor-meta", "atlas-app.json");
const archiveOutLog = join(logDir, "atlas-archive.out.log");
const archiveErrLog = join(logDir, "atlas-archive.err.log");
const serverOutLog = join(logDir, "atlas-server.out.log");
const serverErrLog = join(logDir, "atlas-server.err.log");
const appErrLog = join(logDir, "atlas-app.err.log");
const iconsDir = join(homedir(), ".cursor-meta", "icons");
const iconRenderer = join(ROOT, "scripts", "render-atlas-icons.swift");

function installIcons() {
  console.error("Rendering Atlas icons…");
  execSync(`swift "${iconRenderer}" "${ICON_SRC}" "${iconsDir}"`, { stdio: "inherit" });
}

function buildIcns(pngPath, icnsPath) {
  const iconset = join(logDir, "AppIcon.iconset");
  rmSync(iconset, { recursive: true, force: true });
  mkdirSync(iconset, { recursive: true });
  const sizes = [
    ["icon_16x16.png", 16],
    ["icon_16x16@2x.png", 32],
    ["icon_32x32.png", 32],
    ["icon_32x32@2x.png", 64],
    ["icon_128x128.png", 128],
    ["icon_128x128@2x.png", 256],
    ["icon_256x256.png", 256],
    ["icon_256x256@2x.png", 512],
    ["icon_512x512.png", 512],
    ["icon_512x512@2x.png", 1024],
  ];
  for (const [name, size] of sizes) {
    execSync(`sips -z ${size} ${size} "${pngPath}" --out "${join(iconset, name)}"`, { stdio: "pipe" });
  }
  execSync(`iconutil -c icns "${iconset}" -o "${icnsPath}"`, { stdio: "pipe" });
}

function buildAppBundle(executablePath) {
  const contentsDir = join(appBundle, "Contents");
  const macOSDir = join(contentsDir, "MacOS");
  const resourcesDir = join(contentsDir, "Resources");
  rmSync(appBundle, { recursive: true, force: true });
  mkdirSync(macOSDir, { recursive: true });
  mkdirSync(resourcesDir, { recursive: true });
  copyFileSync(executablePath, appExecutable);
  execSync(`chmod +x "${appExecutable}"`, { stdio: "pipe" });
  buildIcns(join(iconsDir, "app-icon.png"), join(resourcesDir, "AppIcon.icns"));
  writeFileSync(
    join(contentsDir, "Info.plist"),
    `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDevelopmentRegion</key>
  <string>en</string>
  <key>CFBundleExecutable</key>
  <string>atlas-app</string>
  <key>CFBundleIconFile</key>
  <string>AppIcon</string>
  <key>CFBundleIdentifier</key>
  <string>com.cursor-meta.atlas-app</string>
  <key>CFBundleInfoDictionaryVersion</key>
  <string>6.0</string>
  <key>CFBundleName</key>
  <string>Conversation Atlas</string>
  <key>CFBundleDisplayName</key>
  <string>Conversation Atlas</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>CFBundleShortVersionString</key>
  <string>1.0</string>
  <key>CFBundleVersion</key>
  <string>1</string>
  <key>LSMinimumSystemVersion</key>
  <string>13.0</string>
  <key>NSHighResolutionCapable</key>
  <true/>
  <key>NSPrincipalClass</key>
  <string>NSApplication</string>
</dict>
</plist>
`,
  );
}

function uid() {
  return execSync("id -u", { encoding: "utf8" }).trim();
}

function runLaunchctl(args) {
  try {
    execSync(`launchctl ${args}`, { stdio: "pipe" });
  } catch {
    // ignore missing service on bootout
  }
}

function installAgent(label, plistPath, plistBody) {
  writeFileSync(plistPath, plistBody);
  const gui = `gui/${uid()}`;
  runLaunchctl(`bootout ${gui}/${label} 2>/dev/null`);
  runLaunchctl(`bootstrap ${gui} "${plistPath}"`);
  runLaunchctl(`enable ${gui}/${label}`);
  runLaunchctl(`kickstart -k ${gui}/${label}`);
}

mkdirSync(logDir, { recursive: true });
mkdirSync(binDir, { recursive: true });
installIcons();

console.error("Building cursor-meta-mcp…");
execSync("npm run build", { cwd: ROOT, stdio: "inherit" });

console.error("Compiling Conversation Atlas app…");
const stagedBin = join(binDir, "atlas-app");
execSync(
  `swiftc -O "${join(ROOT, "scripts", "AtlasApp.swift")}" -o "${stagedBin}" -framework AppKit -framework WebKit`,
  { stdio: "inherit" },
);
console.error("Packaging Conversation Atlas.app…");
buildAppBundle(stagedBin);

const nodeBin = resolveWorkerNodeBin();
const runner = join(ROOT, "scripts", "run-with-worker-node.mjs");
const watchScript = join(ROOT, "scripts", "atlas-archive-watch.mjs");
const serveScript = join(ROOT, "scripts", "atlas-serve.mjs");
const baseUrl = `http://127.0.0.1:${PORT}`;

writeFileSync(configPath, `${JSON.stringify({ port: PORT, baseUrl }, null, 2)}\n`);

const watcherPlist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${WATCHER_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${nodeBin}</string>
    <string>--import</string>
    <string>tsx</string>
    <string>${runner}</string>
    <string>${watchScript}</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${ROOT}</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${archiveOutLog}</string>
  <key>StandardErrorPath</key>
  <string>${archiveErrLog}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>/usr/local/bin:/usr/bin:/bin:/opt/homebrew/bin:${join(homedir(), ".nvm/versions/node")}</string>
  </dict>
</dict>
</plist>
`;

const serverPlist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${SERVER_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${nodeBin}</string>
    <string>--import</string>
    <string>tsx</string>
    <string>${runner}</string>
    <string>${serveScript}</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${ROOT}</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${serverOutLog}</string>
  <key>StandardErrorPath</key>
  <string>${serverErrLog}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>/usr/local/bin:/usr/bin:/bin:/opt/homebrew/bin:${join(homedir(), ".nvm/versions/node")}</string>
    <key>PORT</key>
    <string>${PORT}</string>
    <key>ATLAS_ARCHIVE_IN_SERVER</key>
    <string>0</string>
  </dict>
</dict>
</plist>
`;

const appPlist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${APP_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${appBin}</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>StandardErrorPath</key>
  <string>${appErrLog}</string>
</dict>
</plist>
`;

// Remove legacy menubar-only agent if present
runLaunchctl(`bootout gui/${uid()}/com.cursor-meta.atlas-menubar 2>/dev/null`);

installAgent(WATCHER_LABEL, watcherPlistPath, watcherPlist);
installAgent(SERVER_LABEL, serverPlistPath, serverPlist);
installAgent(APP_LABEL, appPlistPath, appPlist);

console.error("Installed Conversation Atlas:");
console.error(`  Archive watcher → ${WATCHER_LABEL}`);
console.error(`  API server      → ${SERVER_LABEL} (${baseUrl})`);
console.error(`  Native app      → ${APP_LABEL}`);
console.error(`  App bundle      → ${appBundle}`);
console.error(`  Icons           → ${iconsDir}`);
console.error("Menu bar shows the map icon (brighter when archive is capturing).");
