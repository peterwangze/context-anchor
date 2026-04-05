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
const { buildRemediationSummary } = require('./lib/remediation-summary');
const { buildTaskStateSummary } = require('./lib/task-state');
const {
  command,
  field,
  renderCliError,
  section,
  status
} = require('./lib/terminal-format');
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

function buildStatusReportRecheckCommand(workspace, sessionKey, projectId, userId) {
  const args = [
    'node',
    quoteArg(path.join(__dirname, 'status-report.js')),
    quoteArg(workspace),
    quoteArg(sessionKey || DEFAULTS.sessionKey),
    quoteArg(projectId),
    quoteArg(userId)
  ];
  return args.join(' ');
}

function renderStatusReportText(report) {
  const lines = [];
  const memoryHealthKind =
    report.memory_source_health.status === 'drift_detected'
      ? 'warning'
      : report.memory_source_health.status === 'single_source'
      ? 'success'
      : 'info';
  lines.push(section('Context-Anchor Status Report'));
  lines.push(field('Workspace', report.workspace, { kind: 'info' }));
  lines.push(field('Scope', `User ${report.user.id} | Project ${report.project.id} | Session ${report.session.key}`, { kind: 'muted' }));
  lines.push(
    field(
      'Health',
      `Memory ${status(String(report.memory_source_health.status || 'unknown').toUpperCase(), memoryHealthKind)} | ` +
        `Governance active=${Number(report.governance.active || 0)} | budgeted_out=${Number(report.governance.budgeted_out || 0)}`,
      { kind: memoryHealthKind }
    )
  );
  if (report.session.task_state_summary?.visible) {
    lines.push(field('Task state', report.session.task_state_summary.summary, { kind: 'info' }));
  }
  if (report.session.last_benefit_summary?.visible) {
    lines.push(field('Last benefit', report.session.last_benefit_summary.summary, { kind: 'success' }));
  }
  if (report.remediation_summary?.next_step?.label) {
    lines.push(field(
      'Next step',
      `${report.remediation_summary.next_step.label}` +
        `${report.remediation_summary.next_step.summary ? ` - ${report.remediation_summary.next_step.summary}` : ''}`,
      { kind: report.remediation_summary.next_step.execution_mode === 'manual' ? 'warning' : 'info' }
    ));
  }
  if (report.recommended_action?.resolution_hint) {
    lines.push(field('Guidance', report.recommended_action.resolution_hint, { kind: 'muted' }));
  }
  if (Array.isArray(report.recommended_action?.command_examples) && report.recommended_action.command_examples.length > 0) {
    lines.push(field('Example command', command(report.recommended_action.command_examples[0]), { kind: 'command' }));
  }
  return lines.join('\n');
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
            resolution_hint:
              memorySourceHealth.memory_takeover_mode === 'enforced'
                ? 'Centralize the changed external memory files, then rerun status-report to confirm the canonical state is stable again.'
                : 'Centralize the changed external memory files first, then consider enforcing takeover so later sessions stop diverging again.',
            command_examples: [
              buildNpmScriptCommand('migrate:memory', {
                workspace: paths.workspace,
                projectId
              }),
              memorySourceHealth.memory_takeover_mode === 'enforced'
                ? buildStatusReportRecheckCommand(paths.workspace, sessionKey, projectId, userId)
                : buildNpmScriptCommand('configure:host', {
                    workspace: paths.workspace,
                    openclawHome: paths.openClawHome,
                    applyConfig: true,
                    enforceMemoryTakeover: true,
                    yes: true
                  })
            ],
            follow_up_command:
              memorySourceHealth.memory_takeover_mode === 'enforced'
              ? null
              : buildNpmScriptCommand('configure:host', {
                  workspace: paths.workspace,
                  openclawHome: paths.openClawHome,
                  applyConfig: true,
                  enforceMemoryTakeover: true,
                  yes: true
                }),
          repair_strategy: {
            type: memorySourceHealth.memory_takeover_mode === 'enforced' ? 'migrate_then_recheck' : 'migrate_then_enforce_then_recheck',
            label: memorySourceHealth.memory_takeover_mode === 'enforced' ? 'migrate -> recheck' : 'migrate -> enforce -> recheck',
            execution_mode: 'automatic',
            requires_manual_confirmation: false,
            summary:
              memorySourceHealth.memory_takeover_mode === 'enforced'
                ? 'Centralize external memory first, then rerun status-report.'
                : 'Centralize external memory, enforce takeover, then rerun status-report.'
          }
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
            resolution_hint:
              'This workspace is still in best-effort mode, so some models or profiles may bypass context-anchor. Enforce takeover, then rerun status-report.',
            command_examples: [
              buildNpmScriptCommand('configure:host', {
                workspace: paths.workspace,
                openclawHome: paths.openClawHome,
                applyConfig: true,
                enforceMemoryTakeover: true,
                yes: true
              }),
              buildStatusReportRecheckCommand(paths.workspace, sessionKey, projectId, userId)
            ],
            follow_up_command: null,
            repair_strategy: {
              type: 'enforce_then_recheck',
              label: 'enforce -> recheck',
              execution_mode: 'automatic',
              requires_manual_confirmation: false,
              summary: 'Enforce takeover first, then rerun status-report.'
            }
          }
        : {
            type: 'none',
            priority: 'low',
            summary: 'No repair action required.',
            command: null,
            follow_up_command: null,
            resolution_hint: 'No remediation is required right now.',
            command_examples: [buildStatusReportRecheckCommand(paths.workspace, sessionKey, projectId, userId)],
            repair_strategy: {
              type: 'recheck_only',
              label: 'recheck',
              execution_mode: 'automatic',
              requires_manual_confirmation: false,
              summary: 'No repair action is required right now; rerun status-report when the environment changes.'
            }
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
      last_benefit_summary: sessionSummary?.benefit_summary
        ? {
            visible: Boolean(sessionSummary.benefit_summary.visible),
            summary: sessionSummary.benefit_summary.summary || null,
            summary_lines: Array.isArray(sessionSummary.benefit_summary.summary_lines)
              ? sessionSummary.benefit_summary.summary_lines
              : []
          }
        : null,
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
    remediation_summary: buildRemediationSummary([
      {
        source: 'status_report',
        action: {
          ...recommendedAction,
          recheck_command: buildStatusReportRecheckCommand(paths.workspace, sessionKey, projectId, userId)
        }
      }
    ]),
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
  if (process.argv.includes('--json') || process.argv[6] === 'snapshot') {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(renderStatusReportText(result));
  }
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    if (process.stdout.isTTY) {
      console.log(renderCliError('Context-Anchor Status Report Failed', error.message, {
        nextStep: 'Check the workspace/session arguments, then rerun status-report.'
      }));
    } else {
      console.log(JSON.stringify({ status: 'error', message: error.message }, null, 2));
    }
    process.exit(1);
  }
}

module.exports = {
  renderStatusReportText,
  runStatusReport
};
