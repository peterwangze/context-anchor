#!/usr/bin/env node

const path = require('path');
const {
  DEFAULTS,
  buildScopedSkillMarkdown,
  createPaths,
  generateId,
  loadSessionExperiences,
  loadSessionMemory,
  loadSessionSkills,
  loadSessionState,
  sanitizeKey,
  skillConflictKey,
  sessionSkillsDir,
  writeSessionSkills,
  writeText
} = require('./lib/context-anchor');

function scoreDraftSource(source = {}, kind = 'memory') {
  const heat = Number(source.heat || 0);
  const validated = source.validation?.status === 'validated' ? 20 : 0;
  const experienceBonus = kind === 'experience' ? 15 : 0;
  const typeBonus =
    source.type === 'best_practice' || source.type === 'tool-pattern'
      ? 10
      : source.type === 'lesson' || source.type === 'gotcha'
        ? 6
        : 0;

  return heat + validated + experienceBonus + typeBonus;
}

function pickDraftSource(experiences = [], memories = []) {
  const candidates = [
    ...experiences.map((entry) => ({
      ...entry,
      __kind: 'experience',
      __score: scoreDraftSource(entry, 'experience')
    })),
    ...memories.map((entry) => ({
      ...entry,
      __kind: 'memory',
      __score: scoreDraftSource(entry, 'memory')
    }))
  ].sort((left, right) => right.__score - left.__score);

  return candidates[0] || null;
}

function findReusableDraft(skills = [], sessionKey, skillName) {
  return skills.find(
    (entry) =>
      entry &&
      entry.scope === 'session' &&
      entry.status === 'draft' &&
      entry.name === skillName &&
      entry.source_session === sessionKey &&
      !entry.promoted_to_skill_id &&
      !entry.archived
  );
}

function buildDraftFingerprint(draft = {}) {
  return JSON.stringify({
    summary: draft.summary || null,
    source_type: draft.source_type || null,
    source_id: draft.source_id || null,
    source_kind: draft.source_kind || null,
    source_session: draft.source_session || null,
    source_project: draft.source_project || null,
    source_user: draft.source_user || null
  });
}

function buildDraftRecord(paths, existingDraft, sessionState, sessionKey, skillName, source, note) {
  const timestamp = new Date().toISOString();
  const draftId = existingDraft?.id || generateId('skill-draft');
  const skillPath = existingDraft?.path || path.join(sessionSkillsDir(paths, sessionKey), `${draftId}.md`);

  return {
    ...(existingDraft || {}),
    id: draftId,
    name: skillName,
    scope: 'session',
    status: 'draft',
    conflict_key: skillConflictKey(skillName),
    summary: source.summary || source.content || null,
    source_type: source.type || 'memory',
    source_id: source.id,
    source_kind: source.__kind || 'memory',
    path: skillPath,
    source_session: sessionKey,
    source_project: sessionState.project_id,
    source_user: sessionState.user_id,
    created_at: existingDraft?.created_at || timestamp,
    updated_at: timestamp,
    notes: note || existingDraft?.notes || 'Auto-generated from session assets'
  };
}

function runSkillDraftCreate(workspaceArg, sessionKeyArg, options = {}) {
  const paths = createPaths(workspaceArg);
  const sessionKey = sanitizeKey(sessionKeyArg || DEFAULTS.sessionKey);
  const sessionState = loadSessionState(paths, sessionKey, undefined, {
    createIfMissing: true,
    touch: true
  });
  const experiences = loadSessionExperiences(paths, sessionKey).filter((entry) => !entry.archived);
  const memories = loadSessionMemory(paths, sessionKey).filter((entry) => !entry.archived);
  const source = pickDraftSource(experiences, memories);

  if (!source) {
    return {
      status: 'skipped',
      reason: 'no_session_assets',
      session_key: sessionKey
    };
  }

  const skills = loadSessionSkills(paths, sessionKey);
  const skillName = `${sessionKey}-draft`;
  const existingDraft = findReusableDraft(skills, sessionKey, skillName);
  const draftRecord = buildDraftRecord(
    paths,
    existingDraft,
    sessionState,
    sessionKey,
    skillName,
    source,
    options.note
  );

  if (existingDraft && buildDraftFingerprint(existingDraft) === buildDraftFingerprint(draftRecord)) {
    return {
      status: 'unchanged',
      session_key: sessionKey,
      skill_id: existingDraft.id,
      skill_name: existingDraft.name,
      path: existingDraft.path
    };
  }

  writeText(draftRecord.path, buildScopedSkillMarkdown(draftRecord));
  if (existingDraft) {
    const existingIndex = skills.findIndex((entry) => entry.id === existingDraft.id);
    skills[existingIndex] = draftRecord;
  } else {
    skills.push(draftRecord);
  }
  writeSessionSkills(paths, sessionKey, skills);

  return {
    status: existingDraft ? 'updated' : 'created',
    session_key: sessionKey,
    skill_id: draftRecord.id,
    skill_name: skillName,
    path: draftRecord.path
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
