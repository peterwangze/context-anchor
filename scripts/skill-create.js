#!/usr/bin/env node
/**
 * Skill Creator Script
 * Creates a new skill from an experience
 *
 * Usage: node skill-create.js <workspace> <experience-id> <skill-name> [project-id]
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const workspace = process.argv[2] || process.cwd();
const experienceId = process.argv[3];
const skillName = process.argv[4];
const projectId = process.argv[5] || 'default';

if (!experienceId || !skillName) {
  console.log(JSON.stringify({
    status: 'error',
    message: 'Usage: node skill-create.js <workspace> <experience-id> <skill-name> [project-id]'
  }, null, 2));
  process.exit(1);
}

const anchorDir = path.join(workspace, '.context-anchor');
const projectsDir = path.join(anchorDir, 'projects');
const projectDir = path.join(projectsDir, projectId);
const experiencesFile = path.join(projectDir, 'experiences.json');

const openclawProjectDir = path.join(workspace, '..', 'openclaw_project', 'openclaw');
const skillDir = path.join(openclawProjectDir, skillName);
const skillFile = path.join(skillDir, 'SKILL.md');

function ensureDir(dir) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function readJson(file, defaultValue = {}) {
  if (!fs.existsSync(file)) {
    return defaultValue;
  }
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return defaultValue;
  }
}

function writeJson(file, data) {
  ensureDir(path.dirname(file));
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

function generateSkillMd(experience, skillName) {
  const type = experience.type || 'general';
  const summary = experience.summary || '';
  const details = experience.details || '';
  const solution = experience.solution || '';
  const tags = experience.tags || [];
  
  // Generate description from summary
  const description = summary.length > 100 
    ? summary.substring(0, 100) + '...' 
    : summary;
  
  // Generate content based on type
  let content = `---
name: ${skillName}
description: "${description}"
---

# ${skillName}

${details || summary}

## 使用场景

`;

  // Add tags as scenarios
  if (tags.length > 0) {
    tags.forEach(tag => {
      content += `- ${tag}\n`;
    });
  } else {
    content += `- 通用场景\n`;
  }
  
  content += `
## 执行步骤

`;
  
  // Add solution as steps
  if (solution) {
    const steps = solution.split('\n').filter(s => s.trim());
    steps.forEach((step, i) => {
      content += `${i + 1}. ${step}\n`;
    });
  } else {
    content += `1. 识别问题场景\n`;
    content += `2. 应用最佳实践\n`;
    content += `3. 验证结果\n`;
  }
  
  content += `
## 注意事项

- 此技能从经验 ${experienceId} 沉淀而来
- 创建时间: ${new Date().toISOString().split('T')[0]}
- 原始热度: ${experience.heat || 50}

---

_此技能从经验 ${experienceId} 沉淀而来_
`;
  
  return content;
}

function createSkill() {
  // Read experience
  const experiences = readJson(experiencesFile, { experiences: [] }).experiences;
  const experience = experiences.find(e => e.id === experienceId);
  
  if (!experience) {
    console.log(JSON.stringify({
      status: 'error',
      message: `Experience ${experienceId} not found`
    }, null, 2));
    process.exit(1);
  }
  
  // Check if skill already exists
  if (fs.existsSync(skillDir)) {
    console.log(JSON.stringify({
      status: 'error',
      message: `Skill ${skillName} already exists at ${skillDir}`
    }, null, 2));
    process.exit(1);
  }
  
  // Create skill directory
  ensureDir(skillDir);
  
  // Generate SKILL.md
  const skillMd = generateSkillMd(experience, skillName);
  fs.writeFileSync(skillFile, skillMd);
  
  // Initialize git
  try {
    execSync('git init', { cwd: skillDir, stdio: 'pipe' });
    execSync('git add .', { cwd: skillDir, stdio: 'pipe' });
    execSync(`git commit -m "Initial commit: skill from experience ${experienceId}"`, { cwd: skillDir, stdio: 'pipe' });
  } catch (e) {
    // Git init failed, but skill is created
  }
  
  // Update experience with skill_name
  const updatedExperiences = experiences.map(e => {
    if (e.id === experienceId) {
      return { ...e, skill_name: skillName };
    }
    return e;
  });
  writeJson(experiencesFile, { experiences: updatedExperiences });
  
  // Update skill index
  const skillIndexFile = path.join(openclawProjectDir, '_skill-index.json');
  const skillIndex = readJson(skillIndexFile, { skills: [] });
  skillIndex.skills.push({
    name: skillName,
    source_experience: experienceId,
    source_project: projectId,
    created_at: new Date().toISOString(),
    usage_count: 0
  });
  writeJson(skillIndexFile, skillIndex);
  
  console.log(JSON.stringify({
    status: 'created',
    skill_name: skillName,
    skill_dir: skillDir,
    source_experience: experienceId,
    message: `Skill ${skillName} created successfully. It will be loaded on next session.`
  }, null, 2));
}

createSkill();
