#!/usr/bin/env node

const {
  DEFAULTS,
  buildAdaptiveBudget,
  buildHealthSummary,
  collectSkillDiagnostics,
  countByStatus,
  createPaths,
  loadCollectionCountSnapshot,
  loadCollectionSnapshot,
  projectDecisionsArchiveFile,
  readRuntimeStateSnapshot,
  loadSessionState,
  projectExperiencesArchiveFile,
  projectFactsArchiveFile,
  projectDecisionsFile,
  projectExperiencesFile,
  projectFactsFile,
  projectSkillsIndexFile,
  projectStateFile,
  readMirroredDocumentSnapshot,
  resolveProjectId,
  resolveUserId,
  sanitizeKey,
  sessionExperiencesArchiveFile,
  sessionExperiencesFile,
  sessionMemoryArchiveFile,
  sessionMemoryFile,
  sessionSkillsIndexFile,
  sessionSummaryFile,
  summarizeEvidence,
  userExperiencesArchiveFile,
  userExperiencesFile,
  userMemoriesArchiveFile,
  userMemoriesFile,
  userSkillsIndexFile,
  userStateFile,
  writeStatusSnapshot
} = require('./lib/context-anchor');
const { describeCollectionFile, readLatestGovernanceRun } = require('./lib/context-anchor-db');
const { resolveOwnership } = require('./lib/host-config');
const { buildTaskStateSummary } = require('./lib/task-state');
const {
  classifyMemorySourceHealth,
  summarizeExternalMemorySources
} = require('./legacy-memory-sync');

function quoteArg(value) {
  return `"${String(value).replace(/"/g, '\\"')}"`;
}

function buildNpmScriptCommand(scriptName, options = {}) {
  const forwarded = [];

  if (options.workspace) {
    forwarded.push('--workspace', quoteArg(options.workspace));
  }
  if (options.projectId) {
    forwarded.push('--project-id', quoteArg(options.projectId));
  }
  if (options.openclawHome) {
    forwarded.push('--openclaw-home', quoteArg(options.openclawHome));
  }
  if (options.skillsRoot) {
    forwarded.push('--skills-root', quoteArg(options.skillsRoot));
  }
  if (options.applyConfig) {
    forwarded.push('--apply-config');
  }
  if (options.enforceMemoryTakeover) {
    forwarded.push('--enforce-memory-takeover');
  }
  if (options.yes) {
    forwarded.push('--yes');
  }

  return forwarded.length > 0
    ? `npm run ${scriptName} -- ${forwarded.join(' ')}`
    : `npm run ${scriptName}`;
}

function summarizeSkillEvidence(skills = []) {
  const entries = skills.flatMap((skill) =>
    (Array.isArray(skill.evidence) ? skill.evidence : []).map((event) => ({
      ...event,
      skill_id: skill.id,
      skill_name: skill.name,
      skill_scope: skill.scope
    }))
  );
  const summary = summarizeEvidence(entries);
  return {
    ...summary,
    recent: summary.recent.map((event) => ({
      type: event.type,
      at: event.at,
      reason: event.reason,
      actor: event.actor,
      skill_id: event.skill_id,
      skill_name: event.skill_name,
      scope: event.skill_scope
    }))
  };
}

function summarizeStorageGovernance(paths, sessionKey, projectId, userId) {
  const activeItems = {
    session_memories: loadCollectionCountSnapshot(sessionMemoryFile(paths, sessionKey), 'entries'),
    session_experiences: loadCollectionCountSnapshot(sessionExperiencesFile(paths, sessionKey), 'experiences'),
    project_decisions: loadCollectionCountSnapshot(projectDecisionsFile(paths, projectId), 'decisions'),
    project_experiences: loadCollectionCountSnapshot(projectExperiencesFile(paths, projectId), 'experiences'),
    project_facts: loadCollectionCountSnapshot(projectFactsFile(paths, projectId), 'facts'),
    user_memories: loadCollectionCountSnapshot(userMemoriesFile(paths, userId), 'memories'),
    user_experiences: loadCollectionCountSnapshot(userExperiencesFile(paths, userId), 'experiences')
  };
  const archiveItems = {
    session_memories: loadCollectionCountSnapshot(sessionMemoryArchiveFile(paths, sessionKey), 'entries'),
    session_experiences: loadCollectionCountSnapshot(sessionExperiencesArchiveFile(paths, sessionKey), 'experiences'),
    project_decisions: loadCollectionCountSnapshot(projectDecisionsArchiveFile(paths, projectId), 'decisions'),
    project_experiences: loadCollectionCountSnapshot(projectExperiencesArchiveFile(paths, projectId), 'experiences'),
    project_facts: loadCollectionCountSnapshot(projectFactsArchiveFile(paths, projectId), 'facts'),
    user_memories: loadCollectionCountSnapshot(userMemoriesArchiveFile(paths, userId), 'memories'),
    user_experiences: loadCollectionCountSnapshot(userExperiencesArchiveFile(paths, userId), 'experiences')
  };
  const workspaceDbFile =
    describeCollectionFile(sessionMemoryFile(paths, sessionKey), 'entries')?.dbFile || null;
  const lastRun = readLatestGovernanceRun(workspaceDbFile, {
    workspace: paths.workspace,
    session_key: sessionKey,
    project_id: projectId,
    user_id: userId
  });

  return {
    active_item_count: Object.values(activeItems).reduce((sum, count) => sum + Number(count || 0), 0),
    archive_item_count: Object.values(archiveItems).reduce((sum, count) => sum + Number(count || 0), 0),
    active_items: activeItems,
    archive_items: archiveItems,
    last_run: lastRun
      ? {
          run_id: lastRun.run_id,
          session_key: lastRun.session_key,
          project_id: lastRun.project_id,
          user_id: lastRun.user_id,
          reason: lastRun.reason,
          mode: lastRun.mode,
          prune_archive: lastRun.prune_archive,
          applied: lastRun.applied,
          governed_at: lastRun.governed_at,
          active_before: lastRun.totals.active_before,
          archive_before: lastRun.totals.archive_before,
          active_after: lastRun.totals.active_after,
          archive_after: lastRun.totals.archive_after,
          deduped: lastRun.totals.deduped,
          archived: lastRun.totals.archived,
          restored: lastRun.totals.restored,
          prune_count: lastRun.totals.pruned,
          bytes_before: lastRun.totals.bytes_before,
          bytes_after: lastRun.totals.bytes_after,
          collection_count: Array.isArray(lastRun.collections) ? lastRun.collections.length : 0
        }
      : null
  };
}

function runStatusReport(workspaceArg, sessionKeyArg, projectIdArg, userIdArg, options = {}) {
  const paths = createPaths(workspaceArg);
  const sessionKey = sanitizeKey(sessionKeyArg || DEFAULTS.sessionKey);
  const ownership = resolveOwnership(paths.openClawHome, {
    workspace: paths.workspace,
    sessionKey,
    projectId: projectIdArg,
    userId: userIdArg
  });
  const projectId = ownership.projectId || resolveProjectId(paths.workspace, projectIdArg);
  const existingSessionState = loadSessionState(paths, sessionKey, projectId, {
    createIfMissing: false,
    touch: false
  });
  const userId = resolveUserId(userIdArg || existingSessionState?.user_id || ownership.userId || DEFAULTS.userId);

  const projectState = readMirroredDocumentSnapshot(projectStateFile(paths, projectId), {
    project_id: projectId,
    name: projectId,
    created_at: null,
    last_updated: null,
    sessions_count: 0,
    key_decisions: [],
    key_experiences: [],
    user_preferences: {},
    metadata: {}
  });
  const userState = readMirroredDocumentSnapshot(userStateFile(paths, userId), {
    user_id: userId,
    created_at: null,
    last_updated: null,
    preferences: {},
    profile: {},
    key_memories: [],
    key_experiences: [],
    key_skills: [],
    metadata: {}
  });
  const sessionState =
    existingSessionState || {
      session_key: sessionKey,
      project_id: projectId,
      user_id: userId,
      active_task: null,
      commitments: [],
      last_checkpoint: null,
      last_summary: null
    };
  const runtimeState = readRuntimeStateSnapshot(paths, sessionKey, projectId, {
    userId
  });

  const sessionMemories = loadCollectionCountSnapshot(sessionMemoryFile(paths, sessionKey), 'entries');
  const sessionExperiences = loadCollectionCountSnapshot(sessionExperiencesFile(paths, sessionKey), 'experiences');
  const sessionSkills = loadCollectionSnapshot(sessionSkillsIndexFile(paths, sessionKey), 'skills');
  const sessionSummary = readMirroredDocumentSnapshot(sessionSummaryFile(paths, sessionKey), {});
  const projectDecisions = loadCollectionCountSnapshot(projectDecisionsFile(paths, projectId), 'decisions');
  const projectExperiences = loadCollectionCountSnapshot(projectExperiencesFile(paths, projectId), 'experiences');
  const projectFacts = loadCollectionCountSnapshot(projectFactsFile(paths, projectId), 'facts');
  const projectSkills = loadCollectionSnapshot(projectSkillsIndexFile(paths, projectId), 'skills');
  const userMemories = loadCollectionCountSnapshot(userMemoriesFile(paths, userId), 'memories');
  const userExperiences = loadCollectionCountSnapshot(userExperiencesFile(paths, userId), 'experiences');
  const userSkills = loadCollectionSnapshot(userSkillsIndexFile(paths, userId), 'skills');

  const diagnostics = collectSkillDiagnostics({
    session: sessionSkills,
    project: projectSkills,
    user: userSkills
  });
  const skillStatusCounts = countByStatus(diagnostics.all);
  const externalSources = summarizeExternalMemorySources(paths.workspace);
  const memorySourceHealth = classifyMemorySourceHealth(externalSources, {
    memoryTakeoverMode: ownership.config?.onboarding?.memory_takeover_mode
  });
  const recommendedAction =
    memorySourceHealth.status === 'drift_detected'
      ? {
          type: 'sync_legacy_memory',
          priority: 'high',
          summary: 'External memory sources changed after the last sync. Re-sync them into context-anchor now.',
          command: buildNpmScriptCommand('migrate:memory', {
            workspace: paths.workspace,
            projectId
          }),
          follow_up_command:
            memorySourceHealth.memory_takeover_mode === 'enforced'
              ? null
              : buildNpmScriptCommand('configure:host', {
                  workspace: paths.workspace,
                  openclawHome: paths.openClawHome,
                  applyConfig: true,
                  enforceMemoryTakeover: true,
                  yes: true
                })
        }
      : memorySourceHealth.status === 'best_effort'
        ? {
            type: 'enforce_memory_takeover',
            priority: 'medium',
            summary: 'Takeover is still best-effort. Enforce context-anchor takeover to reduce future memory bypass.',
            command: buildNpmScriptCommand('configure:host', {
              workspace: paths.workspace,
              openclawHome: paths.openClawHome,
              applyConfig: true,
              enforceMemoryTakeover: true,
              yes: true
            }),
            follow_up_command: null
          }
        : {
            type: 'none',
            priority: 'low',
            summary: 'No repair action required.',
            command: null,
            follow_up_command: null
          };

  const report = {
    status: memorySourceHealth.drift_detected ? 'warning' : 'ok',
    workspace: paths.workspace,
    user: {
      id: userId,
      preferences_count: Object.keys(userState.preferences || {}).length,
      memories: userMemories,
      experiences: userExperiences,
      skills: userSkills.length
    },
    project: {
      id: projectId,
      name: projectState.name,
      decisions: projectDecisions,
      experiences: projectExperiences,
      facts: projectFacts,
      skills: projectSkills.length
    },
    session: {
      key: sessionKey,
      active_task:
        Object.prototype.hasOwnProperty.call(runtimeState || {}, 'current_goal')
          ? runtimeState?.current_goal || null
          : Object.prototype.hasOwnProperty.call(runtimeState || {}, 'active_task')
          ? runtimeState?.active_task || null
          : sessionState.active_task,
      pending_commitments: Array.isArray(runtimeState?.pending_commitments)
        ? runtimeState.pending_commitments.length
        : (sessionState.commitments || []).filter((entry) => entry.status === 'pending').length,
      memories: sessionMemories,
      experiences: sessionExperiences,
      skills: sessionSkills.length,
      last_checkpoint: runtimeState?.last_checkpoint || sessionState.last_checkpoint,
      last_summary: runtimeState?.last_summary || sessionState.last_summary,
      task_state_summary: buildTaskStateSummary(runtimeState || {}),
      last_summary_snapshot: sessionSummary.created_at ? {
        created_at: sessionSummary.created_at,
        promoted_project_skills: (sessionSummary.promoted_project_skills || []).length,
        promoted_user_skills: (sessionSummary.promoted_user_skills || []).length,
        deactivated_project_skills: sessionSummary.deactivated_project_skills || 0,
        reactivated_project_skills: sessionSummary.reactivated_project_skills || 0,
        deactivated_user_skills: sessionSummary.deactivated_user_skills || 0,
        reactivated_user_skills: sessionSummary.reactivated_user_skills || 0,
        archived_project_skills: sessionSummary.archived_project_skills || 0,
        archived_user_skills: sessionSummary.archived_user_skills || 0
      } : null
    },
    governance: {
      active: diagnostics.active.length,
      shadowed: diagnostics.shadowed.length,
      superseded: diagnostics.superseded.length,
      budgeted_out: diagnostics.budgeted_out.length
    },
    external_sources: externalSources,
    memory_source_health: memorySourceHealth,
    recommended_action: recommendedAction,
    storage_governance: summarizeStorageGovernance(paths, sessionKey, projectId, userId),
    skills: skillStatusCounts
  };

  report.health = buildHealthSummary(report);
  report.adaptive_budget = buildAdaptiveBudget(DEFAULTS.skillActivationBudget, report);
  report.evidence = {
    session_skills: summarizeSkillEvidence(diagnostics.all.filter((skill) => skill.scope === 'session')),
    project_skills: summarizeSkillEvidence(diagnostics.all.filter((skill) => skill.scope === 'project')),
    user_skills: summarizeSkillEvidence(diagnostics.all.filter((skill) => skill.scope === 'user'))
  };

  if (options.writeSnapshot) {
    report.snapshot_file = writeStatusSnapshot(paths, sessionKey, report);
  }

  return report;
}

function main() {
  const result = runStatusReport(
    process.argv[2],
    process.argv[3],
    process.argv[4],
    process.argv[5],
    {
      writeSnapshot: process.argv[6] === 'snapshot'
    }
  );
  console.log(JSON.stringify(result, null, 2));
}

if (require.main === module) {
  main();
}

module.exports = {
  runStatusReport
};
