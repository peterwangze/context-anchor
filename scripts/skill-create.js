#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const {
  DEFAULTS,
  createPaths,
  ensureDir,
  getSkillsRoot,
  loadProjectExperiences,
  normalizeValidation,
  resolveProjectId,
  writeJson,
  writeProjectExperiences,
  writeText
} = require('./lib/context-anchor');
const { field, section, status } = require('./lib/terminal-format');
const { runCliMain } = require('./lib/cli-runtime');

function generateSkillMd(experience, skillName) {
  const validation = normalizeValidation(experience.validation);
  const tags = experience.tags || [];
  const steps = String(experience.solution || '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);

  const lines = [
    '---',
    `name: ${skillName}`,
    `description: "${String(experience.summary || '').replace(/"/g, '\\"')}"`,
    `source_experience: ${experience.id}`,
    `validation_status: ${validation.status}`,
    '---',
    '',
    `# ${skillName}`,
    '',
    experience.details || experience.summary || 'Derived from a validated experience.',
    '',
    '## Usage',
    '',
    '- 识别当前问题是否匹配该经验的触发条件',
    '- 按下面步骤执行',
    '- 执行后验证结果并补充新的经验',
    '',
    '## Steps',
    ''
  ];

  if (steps.length > 0) {
    steps.forEach((step, index) => {
      lines.push(`${index + 1}. ${step}`);
    });
  } else {
    lines.push('1. 识别问题边界');
    lines.push('2. 应用经验中的有效模式');
    lines.push('3. 验证结果并记录新经验');
  }

  lines.push('');
  lines.push('## Notes');
  lines.push('');
  if (tags.length > 0) {
    tags.forEach((tag) => {
      lines.push(`- ${tag}`);
    });
  } else {
    lines.push('- 无额外标签');
  }
  lines.push(`- 来源经验: ${experience.id}`);
  lines.push(`- 校验状态: ${validation.status}`);
  lines.push('');
  lines.push('---');
  lines.push('');
  lines.push(`_此技能从经验 ${experience.id} 沉淀而来_`);

  return `${lines.join('\n')}\n`;
}

function validateSkillName(skillName) {
  const value = String(skillName || '').trim();

  if (!value) {
    throw new Error('Skill name must not be empty.');
  }

  if (value === '.' || value === '..' || value !== path.basename(value)) {
    throw new Error('Skill name must be a single directory name without path separators.');
  }

  if (/[<>:"/\\|?*\x00-\x1F]/.test(value)) {
    throw new Error('Skill name contains characters that are not portable across Windows, macOS, and Linux.');
  }

  return value;
}

function runSkillCreate(workspaceArg, experienceId, skillName, projectIdArg, options = {}) {
  if (!experienceId || !skillName) {
    throw new Error(
      'Usage: node skill-create.js <workspace> <experience-id> <skill-name> [project-id]'
    );
  }

  const paths = createPaths(workspaceArg);
  const projectId = resolveProjectId(paths.workspace, projectIdArg);
  const validatedSkillName = validateSkillName(skillName);
  const experiences = loadProjectExperiences(paths, projectId);
  const experience = experiences.find((entry) => entry.id === experienceId);

  if (!experience) {
    throw new Error(`Experience ${experienceId} not found`);
  }

  const validation = normalizeValidation(experience.validation);
  const force = Boolean(options.force || process.env.CONTEXT_ANCHOR_FORCE_SKILL_CREATE === '1');
  if (validation.status !== 'validated' && !force) {
    throw new Error(`Experience ${experienceId} has not passed validation.`);
  }

  const skillsRoot = getSkillsRoot(options.skillsRoot);
  const skillDir = path.join(skillsRoot, validatedSkillName);
  const skillFile = path.join(skillDir, 'SKILL.md');
  const skillIndexFile = path.join(skillsRoot, '_skill-index.json');

  if (fs.existsSync(skillDir)) {
    throw new Error(`Skill ${skillName} already exists at ${skillDir}`);
  }

  ensureDir(skillDir);
  writeText(skillFile, generateSkillMd(experience, validatedSkillName));

  const nextExperiences = experiences.map((entry) => {
    if (entry.id !== experienceId) {
      return entry;
    }

    return {
      ...entry,
      skill_name: validatedSkillName,
      skillified_at: new Date().toISOString()
    };
  });
  writeProjectExperiences(paths, projectId, nextExperiences);

  const skillIndex = fs.existsSync(skillIndexFile)
    ? require('./lib/context-anchor').readJson(skillIndexFile, { skills: [] })
    : { skills: [] };
  skillIndex.skills.push({
    name: validatedSkillName,
    path: skillDir,
    source_experience: experienceId,
    source_project: projectId,
    created_at: new Date().toISOString(),
    usage_count: 0
  });
  writeJson(skillIndexFile, skillIndex);

  let gitInitialized = false;
  if (options.gitInit || process.env.CONTEXT_ANCHOR_GIT_INIT === '1') {
    try {
      execSync('git init', { cwd: skillDir, stdio: 'pipe' });
      execSync('git add .', { cwd: skillDir, stdio: 'pipe' });
      execSync(`git commit -m "Initial commit: skill from experience ${experienceId}"`, {
        cwd: skillDir,
        stdio: 'pipe'
      });
      gitInitialized = true;
    } catch {
      gitInitialized = false;
    }
  }

  return {
    status: 'created',
    skill_name: validatedSkillName,
    skill_dir: skillDir,
    source_experience: experienceId,
    validation_status: validation.status,
    git_initialized: gitInitialized,
    message: `Skill ${skillName} created successfully.`
  };
}

function parseArgs(argv) {
  return {
    workspace: argv[0],
    experienceId: argv[1],
    skillName: argv[2],
    projectId: argv[3],
    json: argv.includes('--json')
  };
}

function renderSkillCreateReport(result) {
  const lines = [];
  lines.push(section('Context-Anchor Skill Create', { kind: 'success' }));
  lines.push(field('Status', status(String(result.status || 'created').toUpperCase(), 'success'), { kind: 'success' }));
  lines.push(field('Skill', result.skill_name, { kind: 'success' }));
  lines.push(field('Source experience', result.source_experience, { kind: 'info' }));
  lines.push(field('Validation', String(result.validation_status || 'unknown').toUpperCase(), { kind: result.validation_status === 'validated' ? 'success' : 'warning' }));
  lines.push(field('Directory', result.skill_dir, { kind: 'muted' }));
  lines.push(field('Git initialized', result.git_initialized ? 'yes' : 'no', { kind: result.git_initialized ? 'success' : 'muted' }));
  return lines.join('\n');
}

function main() {
  return runCliMain(process.argv.slice(2), {
    parseArgs,
    run: async (options) => runSkillCreate(options.workspace, options.experienceId, options.skillName, options.projectId),
    renderText: renderSkillCreateReport,
    errorTitle: 'Context-Anchor Skill Create Failed',
    errorNextStep: 'Check the workspace, experience id, and skill name, then rerun skill-create.'
  });
}

if (require.main === module) {
  main();
}

module.exports = {
  parseArgs,
  renderSkillCreateReport,
  runSkillCreate
};
