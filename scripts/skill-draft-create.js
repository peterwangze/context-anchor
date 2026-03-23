#!/usr/bin/env node

const path = require('path');
const {
  DEFAULTS,
  createPaths,
  generateId,
  loadSessionExperiences,
  loadSessionMemory,
  loadSessionSkills,
  loadSessionState,
  sanitizeKey,
  sessionSkillsDir,
  writeSessionSkills,
  writeText
} = require('./lib/context-anchor');

function runSkillDraftCreate(workspaceArg, sessionKeyArg) {
  const paths = createPaths(workspaceArg);
  const sessionKey = sanitizeKey(sessionKeyArg || DEFAULTS.sessionKey);
  const sessionState = loadSessionState(paths, sessionKey, undefined, {
    createIfMissing: true,
    touch: true
  });
  const experiences = loadSessionExperiences(paths, sessionKey).filter((entry) => !entry.archived);
  const memories = loadSessionMemory(paths, sessionKey).filter((entry) => !entry.archived);
  const source = experiences[0] || memories[0];

  if (!source) {
    return {
      status: 'skipped',
      reason: 'no_session_assets',
      session_key: sessionKey
    };
  }

  const skills = loadSessionSkills(paths, sessionKey);
  const draftId = generateId('skill-draft');
  const skillName = `${sessionKey}-draft`;
  const fileName = `${draftId}.md`;
  const skillPath = path.join(sessionSkillsDir(paths, sessionKey), fileName);
  const content = [
    '---',
    `id: ${draftId}`,
    `name: ${skillName}`,
    'scope: session',
    'status: draft',
    `source_session: ${sessionKey}`,
    `source_project: ${sessionState.project_id}`,
    `created_at: ${new Date().toISOString()}`,
    '---',
    '',
    `# ${skillName}`,
    '',
    source.summary || source.content || 'Derived from session activity.',
    '',
    '## Source',
    '',
    `- type: ${source.type || 'memory'}`,
    `- id: ${source.id}`,
    '',
    '## Notes',
    '',
    '- Auto-generated at session close',
    '- Draft only, not yet promoted'
  ].join('\n');

  writeText(skillPath, `${content}\n`);
  skills.push({
    id: draftId,
    name: skillName,
    scope: 'session',
    status: 'draft',
    summary: source.summary || source.content || null,
    source_type: source.type || 'memory',
    source_id: source.id,
    path: skillPath,
    created_at: new Date().toISOString()
  });
  writeSessionSkills(paths, sessionKey, skills);

  return {
    status: 'created',
    session_key: sessionKey,
    skill_id: draftId,
    skill_name: skillName,
    path: skillPath
  };
}

function main() {
  const result = runSkillDraftCreate(process.argv[2], process.argv[3]);
  console.log(JSON.stringify(result, null, 2));
}

if (require.main === module) {
  main();
}

module.exports = {
  runSkillDraftCreate
};
