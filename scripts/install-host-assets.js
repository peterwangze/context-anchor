#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const {
  copyDir,
  ensureDir,
  getOpenClawHome,
  getRepoRoot,
  readJson,
  readText,
  writeJson,
  writeText
} = require('./lib/context-anchor');

function copyFile(sourceFile, targetFile) {
  ensureDir(path.dirname(targetFile));
  fs.copyFileSync(sourceFile, targetFile);
}

function removeDirIfExists(targetDir) {
  if (fs.existsSync(targetDir)) {
    fs.rmSync(targetDir, { recursive: true, force: true });
  }
}

function copySkillSnapshot(repoRoot, installedSkillDir) {
  ensureDir(installedSkillDir);

  ['scripts', 'hooks', 'references', 'templates', 'state'].forEach((dirName) => {
    copyDir(path.join(repoRoot, dirName), path.join(installedSkillDir, dirName));
  });

  ['README.md', 'SKILL.md', 'package.json'].forEach((fileName) => {
    copyFile(path.join(repoRoot, fileName), path.join(installedSkillDir, fileName));
  });
}

function readJsonStrict(file, defaultValue) {
  if (!fs.existsSync(file)) {
    return defaultValue;
  }

  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    throw new Error(`Config file ${file} is not valid JSON. Fix or remove it before running install-host-assets.`);
  }
}

function runInstallHostAssets(openClawHomeArg, skillsRootArg) {
  const openClawHome = getOpenClawHome(openClawHomeArg);
  const repoRoot = getRepoRoot();
  const skillsRoot = path.resolve(
    skillsRootArg || process.env.CONTEXT_ANCHOR_SKILLS_ROOT || path.join(openClawHome, 'skills')
  );
  const skillName = 'context-anchor';
  const installedSkillDir = path.join(skillsRoot, skillName);
  const configFile = path.join(openClawHome, 'config.json');
  const hooksTargetDir = path.join(openClawHome, 'hooks', 'context-anchor-hook');
  const automationTargetDir = path.join(openClawHome, 'automation', 'context-anchor');
  const config = readJsonStrict(configFile, { extraDirs: [] });
  const extraDirs = Array.isArray(config.extraDirs) ? config.extraDirs : [];

  ensureDir(openClawHome);
  ensureDir(path.dirname(configFile));
  if (!extraDirs.includes(skillsRoot)) {
    extraDirs.push(skillsRoot);
  }
  config.extraDirs = extraDirs;
  writeJson(configFile, config);

  removeDirIfExists(installedSkillDir);
  removeDirIfExists(hooksTargetDir);
  removeDirIfExists(automationTargetDir);
  ensureDir(automationTargetDir);
  ensureDir(hooksTargetDir);
  copySkillSnapshot(repoRoot, installedSkillDir);

  const handlerWrapper = `#!/usr/bin/env node
const { handleHookEvent, parsePayload } = require(${JSON.stringify(
    path.join(installedSkillDir, 'hooks', 'context-anchor-hook', 'handler.js')
  )});
try {
  const result = handleHookEvent(process.argv[2], parsePayload(process.argv[3]));
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  console.log(JSON.stringify({
    status: 'error',
    message: error.message
  }, null, 2));
  process.exit(1);
}
`;
  writeText(path.join(hooksTargetDir, 'handler.js'), handlerWrapper);
  writeText(
    path.join(hooksTargetDir, 'HOOK.md'),
    readText(path.join(repoRoot, 'hooks', 'context-anchor-hook', 'HOOK.md'))
  );

  const monitorWrapper = `#!/usr/bin/env node
const { runContextPressureMonitor } = require(${JSON.stringify(
    path.join(installedSkillDir, 'scripts', 'context-pressure-monitor.js')
  )});
const result = runContextPressureMonitor(process.argv[2], process.argv[3], process.argv[4]);
console.log(JSON.stringify(result, null, 2));
`;
  writeText(path.join(automationTargetDir, 'context-pressure-monitor.js'), monitorWrapper);

  return {
    status: 'installed',
    openclaw_home: openClawHome,
    skills_root: skillsRoot,
    installed_skill_dir: installedSkillDir,
    config_file: configFile,
    hooks_dir: hooksTargetDir,
    automation_dir: automationTargetDir,
    hook_handler: path.join(hooksTargetDir, 'handler.js'),
    monitor_script: path.join(automationTargetDir, 'context-pressure-monitor.js'),
    doctor_script: path.join(installedSkillDir, 'scripts', 'doctor.js')
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
