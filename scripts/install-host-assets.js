#!/usr/bin/env node

const path = require('path');
const {
  ensureDir,
  getOpenClawHome,
  getRepoRoot,
  getSkillsRoot,
  readJson,
  readText,
  writeJson,
  writeText
} = require('./lib/context-anchor');

function runInstallHostAssets(openClawHomeArg, skillsRootArg) {
  const openClawHome = getOpenClawHome(openClawHomeArg);
  const skillsRoot = getSkillsRoot(skillsRootArg);
  const repoRoot = getRepoRoot();
  const configFile = path.join(openClawHome, 'config.json');
  const hooksTargetDir = path.join(openClawHome, 'hooks', 'context-anchor-hook');
  const automationTargetDir = path.join(openClawHome, 'automation', 'context-anchor');
  const config = readJson(configFile, { extraDirs: [] });
  const extraDirs = Array.isArray(config.extraDirs) ? config.extraDirs : [];

  ensureDir(openClawHome);
  ensureDir(path.dirname(configFile));
  if (!extraDirs.includes(skillsRoot)) {
    extraDirs.push(skillsRoot);
  }
  config.extraDirs = extraDirs;
  writeJson(configFile, config);

  ensureDir(automationTargetDir);
  ensureDir(hooksTargetDir);

  const handlerWrapper = `#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const { handleHookEvent } = require(${JSON.stringify(
    path.join(repoRoot, 'hooks', 'context-anchor-hook', 'handler.js')
  )});

function parsePayload(rawArg) {
  if (!rawArg) {
    return {};
  }

  const maybeFile = path.resolve(rawArg);
  if (fs.existsSync(maybeFile)) {
    return JSON.parse(fs.readFileSync(maybeFile, 'utf8'));
  }

  return JSON.parse(rawArg);
}

const result = handleHookEvent(process.argv[2], parsePayload(process.argv[3]));
console.log(JSON.stringify(result, null, 2));
`;
  writeText(path.join(hooksTargetDir, 'handler.js'), handlerWrapper);
  writeText(
    path.join(hooksTargetDir, 'HOOK.md'),
    readText(path.join(repoRoot, 'hooks', 'context-anchor-hook', 'HOOK.md'))
  );

  const monitorWrapper = `#!/usr/bin/env node
const { runContextPressureMonitor } = require(${JSON.stringify(
    path.join(repoRoot, 'scripts', 'context-pressure-monitor.js')
  )});
const result = runContextPressureMonitor(process.argv[2], process.argv[3], process.argv[4]);
console.log(JSON.stringify(result, null, 2));
`;
  writeText(path.join(automationTargetDir, 'context-pressure-monitor.js'), monitorWrapper);

  return {
    status: 'installed',
    openclaw_home: openClawHome,
    skills_root: skillsRoot,
    config_file: configFile,
    hooks_dir: hooksTargetDir,
    automation_dir: automationTargetDir
  };
}

function main() {
  const result = runInstallHostAssets(process.argv[2], process.argv[3]);
  console.log(JSON.stringify(result, null, 2));
}

if (require.main === module) {
  main();
}

module.exports = {
  runInstallHostAssets
};
