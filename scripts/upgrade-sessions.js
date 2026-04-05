#!/usr/bin/env node

const path = require('path');
const readline = require('readline');
const {
  createPaths,
  getOpenClawHome,
  readMirroredDocumentSnapshot,
  sanitizeKey,
  sessionStateFile
} = require('./lib/context-anchor');
const { buildBootstrapCacheContent, buildBootstrapCachePath, writeBootstrapCache } = require('./lib/bootstrap-cache');
const { buildOpenClawSessionStatusReport } = require('./lib/openclaw-session-status');
const {
  ensureWorkspaceRegistration,
  findSession,
  readHostConfig,
  resolveOwnership
} = require('./lib/host-config');
const { collectSessionCandidates, normalizeWorkspaceKey } = require('./lib/openclaw-session-candidates');
const { runConfigureHost } = require('./configure-host');
const { buildTakeoverAudit, runDoctor } = require('./doctor');
const { buildRemediationSummary } = require('./lib/remediation-summary');
const { runMirrorRebuild } = require('./mirror-rebuild');
const { runSessionStart } = require('./session-start');
const { runStorageGovernance } = require('./storage-governance');

function parseArgs(argv) {
  const options = {
    openclawHome: null,
    skillsRoot: null,
    workspace: null,
    sessionKey: null,
    includeSubagents: false,
    includeHiddenSessions: false,
    includeClosed: false,
    rebuildMirror: false,
    runGovernance: false,
    memoryTakeover: undefined,
    governanceMode: null,
    governancePrune: undefined
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === '--openclaw-home') {
      options.openclawHome = argv[index + 1] || null;
      index += 1;
      continue;
    }

    if (arg === '--skills-root') {
      options.skillsRoot = argv[index + 1] || null;
      index += 1;
      continue;
    }

    if (arg === '--workspace') {
      options.workspace = argv[index + 1] || null;
      index += 1;
      continue;
    }

    if (arg === '--session-key') {
      options.sessionKey = argv[index + 1] || null;
      index += 1;
      continue;
    }

    if (arg === '--include-subagents') {
      options.includeSubagents = true;
      continue;
    }

    if (arg === '--include-hidden-sessions') {
      options.includeHiddenSessions = true;
      continue;
    }

    if (arg === '--include-closed') {
      options.includeClosed = true;
      continue;
    }

    if (arg === '--rebuild-mirror') {
      options.rebuildMirror = true;
      continue;
    }

    if (arg === '--run-governance') {
      options.runGovernance = true;
      continue;
    }

    if (arg === '--enforce-memory-takeover') {
      options.memoryTakeover = true;
      continue;
    }

    if (arg === '--no-enforce-memory-takeover') {
      options.memoryTakeover = false;
      continue;
    }

    if (arg === '--governance-mode') {
      options.governanceMode = argv[index + 1] || null;
      index += 1;
      continue;
    }

    if (arg === '--governance-prune') {
      const rawValue = String(argv[index + 1] || '').trim();
      options.governancePrune = !(rawValue === '0' || /^false$/i.test(rawValue));
      index += 1;
      continue;
    }
  }

  return options;
}

function emitProgress(progress, event) {
  if (typeof progress === 'function') {
    progress(event);
  }
}

function quoteArg(value) {
  return `"${String(value).replace(/"/g, '\\"')}"`;
}

function buildUpgradeRecheckCommand(openClawHome, skillsRoot, options = {}) {
  const forwarded = [
    '--openclaw-home',
    quoteArg(openClawHome),
    '--skills-root',
    quoteArg(skillsRoot)
  ];

  if (options.workspace) {
    forwarded.push('--workspace', quoteArg(options.workspace));
  }
  if (options.sessionKey) {
    forwarded.push('--session-key', quoteArg(options.sessionKey));
  }

  return `npm run status:sessions -- ${forwarded.join(' ')}`;
}

function buildUpgradeRepairStrategy(verification = {}) {
  if (verification.configuration_required_targets > 0) {
    return {
      type: 'configure_sessions_then_recheck',
      label: 'configure sessions -> recheck',
      execution_mode: 'automatic',
      requires_manual_confirmation: false,
      summary: 'Workspace configuration is still missing; repair session linkage first, then rerun session status.'
    };
  }

  if (verification.unresolved_targets > 0) {
    return {
      type: 'resolve_workspace_then_recheck',
      label: 'resolve workspace -> recheck',
      execution_mode: 'manual',
      manual_subtype: 'external_environment',
      external_issue_type: 'workspace_path_unresolved',
      requires_manual_confirmation: true,
      summary: 'Resolve the missing workspace paths first, then rerun session status.',
      resolution_hint:
        'This upgrade target could not recover a workspace path from the discovered session metadata. Re-run the upgrade with an explicit --workspace, or repair the session registration under the correct workspace first.',
      command_examples: [
        verification.example_session_key
          ? buildUpgradeRecheckCommand(verification.openclawHome, verification.skillsRoot, {
              workspace: '<workspace>',
              sessionKey: verification.example_session_key
            }).replace('status:sessions', 'upgrade:sessions')
          : null,
        verification.example_session_key
          ? `npm run configure:sessions -- --openclaw-home ${quoteArg(verification.openclawHome)} --skills-root ${quoteArg(verification.skillsRoot)} --workspace ${quoteArg('<workspace>')} --session-key ${quoteArg(verification.example_session_key)} --yes`
          : null
      ].filter(Boolean)
    };
  }

  if (verification.remaining_attention_sessions > 0) {
    return {
      type: 'repair_sessions_then_recheck',
      label: 'repair sessions -> recheck',
      execution_mode: 'automatic',
      requires_manual_confirmation: false,
      summary: 'Repair the remaining session linkage issues, then rerun session status.'
    };
  }

  return {
    type: 'recheck_upgrade_state',
    label: 'recheck upgraded sessions',
    execution_mode: 'automatic',
    requires_manual_confirmation: false,
    summary: 'The upgrade path is currently healthy; rerun session status after the next environment change.'
  };
}

function formatUpgradeStrategyLabel(strategy) {
  if (!strategy?.label) {
    return null;
  }

  if (strategy.execution_mode === 'manual') {
    const subtype =
      (strategy.manual_subtype || 'confirm_only') === 'external_environment'
        ? strategy.external_issue_type === 'workspace_path_unresolved'
          ? 'external-env/workspace-path'
          : strategy.external_issue_type === 'workspace_registration_missing'
          ? 'external-env/workspace-registration'
          : 'external-env'
        : 'confirm';
    return `manual/${subtype}:${strategy.label}`;
  }

  return `auto:${strategy.label}`;
}

function summarizeUpgradeVerificationState(sessionReport = {}) {
  const summary = sessionReport.summary || {};
  return {
    report_status: sessionReport.status || 'warning',
    total_sessions: Number(summary.total_sessions || 0),
    ready_sessions: Number(summary.ready_sessions || 0),
    attention_sessions: Number(summary.attention_sessions || 0),
    unresolved_sessions: Number(summary.unresolved_sessions || 0),
    drift_workspaces: Number(summary.drift_workspaces || 0)
  };
}

function summarizeUpgradeTargetState(sessionReport = {}, sessionKeys = new Set()) {
  const scopedSessions = Array.isArray(sessionReport.sessions)
    ? sessionReport.sessions.filter((entry) => sessionKeys.has(sanitizeKey(entry.session_key)))
    : [];
  const targetAttention = scopedSessions.filter((entry) => {
    const skill = entry.classification?.skill || 'missing';
    return skill === 'missing' || skill === 'unknown';
  }).length;

  return {
    target_sessions: scopedSessions.length,
    target_ready_sessions: scopedSessions.length - targetAttention,
    target_attention_sessions: targetAttention
  };
}

function buildUpgradeVerification({
  openClawHome,
  skillsRoot,
  options,
  results,
  beforeSessionReport,
  sessionReport
}) {
  const upgradedResults = results.filter((entry) => entry.action === 'upgraded');
  const upgradedKeys = new Set(upgradedResults.map((entry) => sanitizeKey(entry.session_key)));
  const verifiedSessions = sessionReport.sessions.filter((entry) => upgradedKeys.has(sanitizeKey(entry.session_key)));
  const remainingAttention = verifiedSessions.filter((entry) => {
    const skill = entry.classification?.skill || 'missing';
    return skill === 'missing' || skill === 'unknown';
  });
  const unresolvedTargets = results.filter((entry) => entry.reason === 'workspace_unresolved');
  const configurationRequiredTargets = results.filter((entry) => entry.reason === 'workspace_needs_configuration');
  const issues = [];
  let status = 'verified';
  let summary = 'Upgrade-sessions recheck passed.';
  const before = {
    ...summarizeUpgradeVerificationState(beforeSessionReport),
    ...summarizeUpgradeTargetState(beforeSessionReport, upgradedKeys)
  };
  const after = {
    ...summarizeUpgradeVerificationState(sessionReport),
    ...summarizeUpgradeTargetState(sessionReport, upgradedKeys)
  };
  const changed =
    before.target_ready_sessions !== after.target_ready_sessions ||
    before.target_attention_sessions !== after.target_attention_sessions ||
    before.unresolved_sessions !== after.unresolved_sessions ||
    before.drift_workspaces !== after.drift_workspaces;

  if (remainingAttention.length > 0) {
    issues.push('upgraded_session_not_materialized');
    status = 'needs_attention';
  }
  if (unresolvedTargets.length > 0) {
    issues.push('workspace_unresolved');
    status = 'needs_attention';
  }
  if (configurationRequiredTargets.length > 0) {
    issues.push('workspace_needs_configuration');
    status = 'needs_attention';
  }

  if (status === 'needs_attention') {
    if (remainingAttention.length > 0) {
      summary = `${remainingAttention.length} upgraded session(s) still did not materialize into context-anchor state after recheck.`;
    } else if (configurationRequiredTargets.length > 0) {
      summary = `${configurationRequiredTargets.length} session target(s) still need workspace configuration before they can be upgraded.`;
    } else {
      summary = `${unresolvedTargets.length} session target(s) still have unresolved workspace paths.`;
    }
  } else if (upgradedResults.length === 0) {
    summary = 'No sessions were upgraded in this run, so only the current status snapshot was rechecked.';
  }

  if (status === 'needs_attention' && !changed) {
    summary = `${summary} Recheck did not improve the visible upgrade issues yet.`;
  } else if (status === 'verified' && changed) {
    summary = `${summary} Recheck confirms session availability improved.`;
  } else if (status === 'verified' && upgradedResults.length > 0 && !changed) {
    summary = `${summary} Recheck did not show a visible delta because the upgraded targets already looked materialized in status checks.`;
  }

  return {
    status,
    summary,
    issues,
    repair_strategy: buildUpgradeRepairStrategy({
      remaining_attention_sessions: remainingAttention.length,
      unresolved_targets: unresolvedTargets.length,
      configuration_required_targets: configurationRequiredTargets.length,
      openClawHome,
      skillsRoot,
      example_session_key: unresolvedTargets[0]?.session_key || options.sessionKey || null
    }),
    readiness_transition: {
      changed,
      improved:
        after.target_attention_sessions < before.target_attention_sessions ||
        after.target_ready_sessions > before.target_ready_sessions ||
        after.unresolved_sessions < before.unresolved_sessions ||
        after.drift_workspaces < before.drift_workspaces,
      before,
      after
    },
    upgraded_sessions: upgradedResults.length,
    verified_sessions: verifiedSessions.length,
    remaining_attention_sessions: remainingAttention.length,
    unresolved_targets: unresolvedTargets.length,
    configuration_required_targets: configurationRequiredTargets.length,
    session_report_status: sessionReport.status,
    remediation_summary: buildRemediationSummary([
      {
        source: 'upgrade_verification',
        action: {
          type: 'upgrade_verification',
          summary,
          recheck_command: buildUpgradeRecheckCommand(openClawHome, skillsRoot, {
            workspace: options.workspace || null,
            sessionKey: options.sessionKey || null
          }),
          repair_strategy: buildUpgradeRepairStrategy({
            remaining_attention_sessions: remainingAttention.length,
            unresolved_targets: unresolvedTargets.length,
            configuration_required_targets: configurationRequiredTargets.length,
            openClawHome,
            skillsRoot,
            example_session_key: unresolvedTargets[0]?.session_key || options.sessionKey || null
          })
        }
      }
    ]),
    recheck_command: buildUpgradeRecheckCommand(openClawHome, skillsRoot, {
      workspace: options.workspace || null,
      sessionKey: options.sessionKey || null
    })
  };
}

function askYesNo(prompt, defaultYes = true) {
  const suffix = defaultYes ? ' [Y/n] ' : ' [y/N] ';
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });

  return new Promise((resolve) => {
    rl.question(`${prompt}${suffix}`, (answer) => {
      rl.close();
      const normalized = String(answer || '').trim().toLowerCase();
      if (!normalized) {
        resolve(defaultYes);
        return;
      }

      resolve(normalized === 'y' || normalized === 'yes');
    });
  });
}

function buildMemoryTakeoverPrompt(openClawHome, skillsRoot) {
  return [
    '[Recommended] Force-enable context-anchor memory takeover before upgrading sessions?',
    '',
    `This will update ${path.join(getOpenClawHome(openClawHome), 'openclaw.json')} so this OpenClaw profile keeps internal hooks enabled${skillsRoot ? ' and keeps the context-anchor skill path registered' : ''}.`,
    '',
    'If you do NOT enable this:',
    '- some models or profiles may continue using their own MEMORY.md or private memory files',
    '- memory may remain fragmented across multiple sources after the upgrade',
    '- continuity restore, experience accumulation, and later retrieval may still feel inconsistent',
    '',
    'Enable memory takeover now?'
  ].join('\n');
}

function formatCandidateLabel(workspace, sessionKey) {
  const workspaceLabel = workspace ? path.basename(path.resolve(workspace)) : 'unresolved';
  return `${sanitizeKey(sessionKey)} @ ${workspaceLabel}`;
}

function createCliProgressReporter(stream = process.stderr) {
  return (event = {}) => {
    if (!stream || typeof stream.write !== 'function') {
      return;
    }

    let line = null;

    switch (event.type) {
      case 'scan:start':
        line = '[upgrade] scanning registered and discovered sessions';
        break;
      case 'scan:done':
        line = `[upgrade] selected ${event.selected || 0} session(s) for processing${
          event.excluded_subagent_sessions ? `, skipped ${event.excluded_subagent_sessions} subagent session(s)` : ''
        }${
          event.excluded_hidden_sessions ? `, skipped ${event.excluded_hidden_sessions} hidden session(s)` : ''
        }`;
        break;
      case 'session:start':
        line = `[upgrade] session ${event.index}/${event.total}: ${formatCandidateLabel(event.workspace, event.session_key)}`;
        break;
      case 'session:done':
        line = `[upgrade] session ${event.index}/${event.total}: ${event.action} ${formatCandidateLabel(event.workspace, event.session_key)}${event.reason ? ` (${event.reason})` : ''}`;
        break;
      case 'mirror:start':
        line = '[upgrade] mirror rebuild: starting';
        break;
      case 'mirror:done':
        line = `[upgrade] mirror rebuild: done workspaces=${(event.result?.workspaces_processed || []).length} users=${(event.result?.users_processed || []).length}`;
        break;
      case 'governance:start':
        line = `[upgrade] governance: running ${event.total || 0} target(s)`;
        break;
      case 'governance:target:start':
        line = `[upgrade] governance ${event.index}/${event.total}: ${formatCandidateLabel(event.workspace, event.session_key)}`;
        break;
      case 'governance:target:done':
        line = `[upgrade] governance ${event.index}/${event.total}: archived=${event.result?.totals?.archived || 0} pruned=${event.result?.totals?.pruned || 0}`;
        break;
      case 'finish':
        line = `[upgrade] complete upgraded=${event.upgraded_sessions || 0} skipped=${event.skipped_sessions || 0} unresolved=${event.unresolved_sessions || 0}${event.strategy_label ? ` | strategy=${event.strategy_label}` : ''}${event.next_step_label ? ` | next=${event.next_step_label}` : ''}`;
        break;
      case 'verification:strategy':
        line = `[upgrade] verification strategy: ${event.label}${event.summary ? ` - ${event.summary}` : ''}`;
        break;
      default:
        break;
    }

    if (line) {
      stream.write(`${line}\n`);
    }
  };
}

function matchesFilters(candidate, options = {}) {
  if (options.workspace) {
    if (!candidate.workspace) {
      return false;
    }

    if (normalizeWorkspaceKey(candidate.workspace) !== normalizeWorkspaceKey(options.workspace)) {
      return false;
    }
  }

  if (options.sessionKey && sanitizeKey(candidate.session_key) !== sanitizeKey(options.sessionKey)) {
    return false;
  }

  return true;
}

function classifyClosedCandidate(candidate, existingState) {
  if (candidate.discovered) {
    return false;
  }

  return candidate.host_status === 'closed' || Boolean(existingState?.closed_at);
}

function upgradeCandidate(openClawHome, candidate, options = {}) {
  if (!candidate.workspace) {
    return {
      session_key: candidate.session_key,
      workspace: null,
      action: 'skipped',
      reason: 'workspace_unresolved',
      status: 'unresolved',
      sources: candidate.sources
    };
  }

  const paths = createPaths(candidate.workspace);
  const existingState = readMirroredDocumentSnapshot(sessionStateFile(paths, candidate.session_key), null);
  const closed = classifyClosedCandidate(candidate, existingState);
  if (closed && !options.includeClosed) {
    return {
      session_key: candidate.session_key,
      workspace: candidate.workspace,
      action: 'skipped',
      reason: 'closed_session',
      status: 'closed',
      sources: candidate.sources
    };
  }

  const ownership = resolveOwnership(openClawHome, {
    workspace: candidate.workspace,
    sessionKey: candidate.session_key,
    projectId: candidate.project_id,
    userId: candidate.user_id
  });
  const ensured = ensureWorkspaceRegistration(openClawHome, candidate.workspace, {
    userId: ownership.userId,
    projectId: ownership.projectId,
    reason: 'upgrade_sessions'
  });

  if (ensured.status === 'blocked') {
    return {
      session_key: candidate.session_key,
      workspace: candidate.workspace,
      action: 'skipped',
      reason: 'workspace_needs_configuration',
      status: 'needs_configuration',
      sources: candidate.sources,
      onboarding: ensured
    };
  }

  const summary = runSessionStart(candidate.workspace, candidate.session_key, ownership.projectId, {
    userId: ownership.userId,
    openClawSessionId: candidate.session_id || existingState?.metadata?.openclaw_session_id || null,
    reopenClosed: !closed
  });
  const bootstrapCache = buildBootstrapCachePath(candidate.workspace, candidate.session_key);
  writeBootstrapCache(bootstrapCache, buildBootstrapCacheContent(summary));

  return {
    session_key: candidate.session_key,
    workspace: candidate.workspace,
    action: 'upgraded',
    status: closed ? 'closed' : 'active',
    sources: candidate.sources,
    bootstrap_cache: bootstrapCache,
    session_id: candidate.session_id || existingState?.metadata?.openclaw_session_id || null,
    recovered_continuity: Boolean(summary.recovery?.continuity?.recovered_before_restore),
    restored: Boolean(summary.session?.restored),
    continued_from: summary.session?.continued_from || null,
    effective_skills: (summary.effective_skills || []).length
  };
}

function runUpgradeSessions(openClawHomeArg, skillsRootArg, options = {}) {
  const openClawHome = getOpenClawHome(openClawHomeArg || options.openclawHome || null);
  const skillsRoot = path.resolve(
    skillsRootArg ||
      options.skillsRoot ||
      process.env.CONTEXT_ANCHOR_SKILLS_ROOT ||
      path.join(openClawHome, 'skills')
  );
  const progress = options.progress;
  emitProgress(progress, {
    type: 'scan:start'
  });
  const collected = collectSessionCandidates(openClawHome, options);
  const candidates = collected.candidates.filter((candidate) => matchesFilters(candidate, options));
  emitProgress(progress, {
    type: 'scan:done',
    selected: candidates.length,
    excluded_subagent_sessions: collected.excluded_subagent_sessions.length,
    excluded_hidden_sessions: collected.excluded_hidden_sessions.length
  });
  const beforeSessionReport = buildOpenClawSessionStatusReport(openClawHome, skillsRoot, {
    workspace: options.workspace || null,
    sessionKey: options.sessionKey || null,
    includeSubagents: Boolean(options.includeSubagents)
  });
  const results = candidates.map((candidate, index) => {
    emitProgress(progress, {
      type: 'session:start',
      index: index + 1,
      total: candidates.length,
      session_key: candidate.session_key,
      workspace: candidate.workspace
    });
    const result = upgradeCandidate(openClawHome, candidate, options);
    emitProgress(progress, {
      type: 'session:done',
      index: index + 1,
      total: candidates.length,
      session_key: candidate.session_key,
      workspace: candidate.workspace,
      action: result.action,
      reason: result.reason || null
    });
    return result;
  });
  const rebuildWorkspace =
    options.workspace ||
    ([...new Set(results.map((entry) => entry.workspace).filter(Boolean))].length === 1
      ? results.map((entry) => entry.workspace).filter(Boolean)[0]
      : null);
  let mirrorRebuild = null;
  if (options.rebuildMirror) {
    emitProgress(progress, {
      type: 'mirror:start'
    });
    mirrorRebuild = runMirrorRebuild(rebuildWorkspace, openClawHome, {});
    emitProgress(progress, {
      type: 'mirror:done',
      result: mirrorRebuild
    });
  }
  const governanceTargets = [...new Map(
    results
      .filter((entry) => entry.action === 'upgraded' && entry.workspace)
      .map((entry) => [`${normalizeWorkspaceKey(entry.workspace)}::${sanitizeKey(entry.session_key)}`, entry])
  ).values()];
  let governanceRuns = [];
  if (options.runGovernance) {
    emitProgress(progress, {
      type: 'governance:start',
      total: governanceTargets.length
    });
    governanceRuns = governanceTargets.map((entry, index) => {
      emitProgress(progress, {
        type: 'governance:target:start',
        index: index + 1,
        total: governanceTargets.length,
        session_key: entry.session_key,
        workspace: entry.workspace
      });
      const result = runStorageGovernance(entry.workspace, entry.session_key, {
        reason: 'upgrade-sessions',
        mode: options.governanceMode || undefined,
        pruneArchive: options.governancePrune
      });
      emitProgress(progress, {
        type: 'governance:target:done',
        index: index + 1,
        total: governanceTargets.length,
        session_key: entry.session_key,
        workspace: entry.workspace,
        result
      });
      return result;
    });
  }

  const auditWorkspace =
    options.workspace ||
    results.find((entry) => entry.workspace && entry.action === 'upgraded')?.workspace ||
    results.find((entry) => entry.workspace)?.workspace ||
    null;
  const doctorAudit = runDoctor({
    openClawHome,
    skillsRoot,
    workspace: auditWorkspace
  });
  const takeoverAudit = buildTakeoverAudit(doctorAudit);
  const verificationReport = buildOpenClawSessionStatusReport(openClawHome, skillsRoot, {
    workspace: options.workspace || null,
    sessionKey: options.sessionKey || null
  });
  const verification = buildUpgradeVerification({
    openClawHome,
    skillsRoot,
    options,
    results,
    beforeSessionReport,
    sessionReport: verificationReport
  });
  const summary = {
    status: 'ok',
    openclaw_home: openClawHome,
    selected_sessions: candidates.length,
    excluded_subagent_sessions: collected.excluded_subagent_sessions.length,
    excluded_hidden_sessions: collected.excluded_hidden_sessions.length,
    upgraded_sessions: results.filter((entry) => entry.action === 'upgraded').length,
    skipped_sessions: results.filter((entry) => entry.action === 'skipped').length,
    unresolved_sessions: results.filter((entry) => entry.reason === 'workspace_unresolved').length,
    configuration_required_sessions: results.filter((entry) => entry.reason === 'workspace_needs_configuration').length,
    mirror_rebuild: mirrorRebuild,
    governance_runs: governanceRuns,
    verification,
    verification_report: verificationReport,
    takeover_audit: takeoverAudit,
    host_takeover_audit: doctorAudit.host_takeover_audit,
    profile_takeover_audit: doctorAudit.profile_takeover_audit,
    results
  };
  if (takeoverAudit.status !== 'ok') {
    emitProgress(progress, {
      type: 'takeover:audit',
      status: takeoverAudit.status,
      message: `[upgrade] takeover audit: ${takeoverAudit.summary}`
    });
  }
  if (doctorAudit.host_takeover_audit.status !== 'ok') {
    emitProgress(progress, {
      type: 'host:audit',
      status: doctorAudit.host_takeover_audit.status,
      message: `[upgrade] host audit: ${doctorAudit.host_takeover_audit.summary}`
    });
  }
  if (doctorAudit.profile_takeover_audit.status !== 'ok') {
    emitProgress(progress, {
      type: 'profile:audit',
      status: doctorAudit.profile_takeover_audit.status,
      message: `[upgrade] profile audit: ${doctorAudit.profile_takeover_audit.summary}`
    });
  }
  emitProgress(progress, {
    type: 'finish',
    upgraded_sessions: summary.upgraded_sessions,
    skipped_sessions: summary.skipped_sessions,
    unresolved_sessions: summary.unresolved_sessions,
    strategy_label: formatUpgradeStrategyLabel(verification?.repair_strategy) || null,
    next_step_label: verification?.remediation_summary?.next_step?.label || null
  });
  if (verification?.repair_strategy?.label) {
    emitProgress(progress, {
      type: 'verification:strategy',
      label: formatUpgradeStrategyLabel(verification.repair_strategy),
      summary: verification.repair_strategy.summary
    });
  }
  return summary;
}

async function main() {
  try {
    const options = parseArgs(process.argv.slice(2));
    let memoryTakeover = options.memoryTakeover;
    if (typeof memoryTakeover !== 'boolean' && process.stdin.isTTY) {
      memoryTakeover = await askYesNo(
        buildMemoryTakeoverPrompt(options.openclawHome, options.skillsRoot),
        true
      );
    }
    if (memoryTakeover) {
      await runConfigureHost(options.openclawHome, options.skillsRoot, {
        assumeYes: true,
        applyConfig: true,
        memoryTakeover: true,
        enableScheduler: false
      });
    }
    const result = runUpgradeSessions(options.openclawHome, options.skillsRoot, {
      ...options,
      memoryTakeover,
      progress: createCliProgressReporter(process.stderr)
    });
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    console.log(
      JSON.stringify(
        {
          status: 'error',
          message: error.message
        },
        null,
        2
      )
    );
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  collectUpgradeCandidates: collectSessionCandidates,
  createCliProgressReporter,
  main,
  parseArgs,
  runUpgradeSessions
};
