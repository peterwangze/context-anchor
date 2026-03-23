#!/usr/bin/env node

const {
  DEFAULTS,
  createPaths,
  generateId,
  loadSessionMemory,
  loadSessionState,
  loadSessionExperiences,
  resolveUserId,
  sanitizeKey,
  writeSessionExperiences,
  writeSessionState,
  writeSessionSummary
} = require('./lib/context-anchor');
const { runCheckpointCreate } = require('./checkpoint-create');
const { runCompactPacketCreate } = require('./compact-packet-create');
const { runHeatEvaluation } = require('./heat-eval');
const { runMemoryFlow } = require('./memory-flow');
const { runScopePromote } = require('./scope-promote');
const { runSkillDraftCreate } = require('./skill-draft-create');
const { runSkillificationScore } = require('./skillification-score');

function deriveSessionExperiences(sessionState, sessionMemories, existingExperiences) {
  const existingKeys = new Set(existingExperiences.map((entry) => `${entry.source_memory_id || ''}:${entry.summary || ''}`));
  const candidates = sessionMemories.filter((entry) =>
    ['lesson', 'best_practice', 'tool-pattern', 'gotcha', 'feature_request'].includes(entry.type)
  );

  const created = [];
  candidates.forEach((entry) => {
    const key = `${entry.id}:${entry.summary || entry.content || ''}`;
    if (existingKeys.has(key)) {
      return;
    }

    created.push({
      id: generateId('sess-exp'),
      scope: 'session',
      type: entry.type,
      summary: entry.summary || entry.content,
      details: entry.details || null,
      solution: entry.solution || null,
      source_memory_id: entry.id,
      source_session: sessionState.session_key,
      source_project: sessionState.project_id,
      source_user: resolveUserId(sessionState.user_id),
      created_at: new Date().toISOString(),
      heat: Math.max(50, Number(entry.heat || 0)),
      access_count: 1,
      access_sessions: [sessionState.session_key],
      validation: {
        status: 'pending',
        count: 0,
        auto_validated: false,
        last_reviewed_at: null,
        notes: []
      },
      promotion_history: [],
      load_policy: {
        auto_load: true,
        priority: 80,
        budget_weight: 1
      },
      archived: false
    });
  });

  return existingExperiences.concat(created);
}

function runSessionClose(workspaceArg, sessionKeyArg, options = {}) {
  const paths = createPaths(workspaceArg);
  const sessionKey = sanitizeKey(sessionKeyArg || DEFAULTS.sessionKey);
  const sessionState = loadSessionState(paths, sessionKey, options.projectId, {
    createIfMissing: true,
    touch: true
  });
  const checkpoint = runCheckpointCreate(paths.workspace, sessionKey, options.reason || 'session-close', {
    usagePercent: options.usagePercent
  });
  const compact = runCompactPacketCreate(paths.workspace, sessionKey, {
    reason: options.reason || 'session-close',
    usagePercent: options.usagePercent,
    userId: sessionState.user_id
  });
  const flow = runMemoryFlow(paths.workspace, sessionKey, { minimumHeat: 50 });
  const sessionMemories = loadSessionMemory(paths, sessionKey);
  const existingExperiences = loadSessionExperiences(paths, sessionKey);
  const allExperiences = deriveSessionExperiences(sessionState, sessionMemories, existingExperiences);
  writeSessionExperiences(paths, sessionKey, allExperiences);

  const skillDraft = runSkillDraftCreate(paths.workspace, sessionKey);
  const heat = runHeatEvaluation(paths.workspace, sessionState.project_id);
  const skillification = runSkillificationScore(paths.workspace, sessionState.project_id);
  const promotions = runScopePromote(paths.workspace, {
    sessionKey: sessionState.session_key,
    projectId: sessionState.project_id,
    userId: sessionState.user_id
  });
  const summary = {
    session_key: sessionState.session_key,
    project_id: sessionState.project_id,
    user_id: resolveUserId(sessionState.user_id),
    created_at: new Date().toISOString(),
    reason: options.reason || 'session-close',
    active_task: sessionState.active_task,
    pending_commitments: (sessionState.commitments || []).filter((entry) => entry.status === 'pending'),
    memory_count: sessionMemories.length,
    new_session_experiences: allExperiences.length - existingExperiences.length,
    compact_packet_file: compact.compact_packet_file,
    promoted_project_skills: promotions.project_skills,
    promoted_user_skills: promotions.user_skills,
    skill_draft: skillDraft.status === 'created' ? {
      id: skillDraft.skill_id,
      name: skillDraft.skill_name
    } : null
  };
  writeSessionSummary(paths, sessionKey, summary);

  sessionState.closed_at = new Date().toISOString();
  sessionState.last_summary = summary.created_at;
  writeSessionState(paths, sessionKey, sessionState);

  return {
    status: 'closed',
    session_key: sessionState.session_key,
    project_id: sessionState.project_id,
    checkpoint,
    compact,
    flow,
    session_summary_file: require('./lib/context-anchor').sessionSummaryFile(paths, sessionKey),
    session_experiences: allExperiences.length,
    skill_draft: skillDraft,
    promotions,
    heat,
    skillification
  };
}

function main() {
  const result = runSessionClose(process.argv[2], process.argv[3], {
    reason: process.argv[4],
    usagePercent: process.argv[5] ? Number(process.argv[5]) : undefined,
    projectId: process.argv[6]
  });
  console.log(JSON.stringify(result, null, 2));
}

if (require.main === module) {
  main();
}

module.exports = {
  runSessionClose
};
