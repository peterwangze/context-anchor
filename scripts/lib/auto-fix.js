const path = require('path');
const RISK_ORDER = {
  low: 0,
  medium: 1,
  high: 2
};

function recommendAutoFixStrategy(options = {}) {
  const strategyType = String(options.strategyType || '').toLowerCase();
  const actionType = String(options.actionType || '').toLowerCase();
  const issues = Array.isArray(options.issues) ? options.issues.map((entry) => String(entry).toLowerCase()) : [];
  const hasFollowUp = Boolean(options.hasFollowUp);
  const hasRecheck = Boolean(options.hasRecheck);

  const defaults = {
    until: null,
    skipRecheck: false,
    riskThreshold: 'high'
  };

  const isDriftFlow =
    actionType === 'sync_legacy_memory' ||
    actionType === 'repair_registered_workspaces' ||
    actionType === 'repair_profile_family' ||
    issues.includes('legacy_memory_never_synced') ||
    issues.includes('legacy_memory_changed_since_sync') ||
    strategyType.includes('migrate_then') ||
    strategyType.includes('repair_registered_workspaces_then_recheck') ||
    strategyType.includes('repair_profile_family_then_recheck');

  if (isDriftFlow) {
    return {
      until: hasFollowUp ? 'follow_up' : 'repair',
      skipRecheck: hasRecheck,
      riskThreshold: 'high'
    };
  }

  const isHostConfigFlow =
    strategyType.includes('configure_host') ||
    issues.includes('hook_not_configured') ||
    issues.includes('monitor_not_configured') ||
    issues.includes('monitor_legacy_window');

  if (isHostConfigFlow) {
    return {
      until: hasRecheck ? 'recheck' : hasFollowUp ? 'follow_up' : null,
      skipRecheck: false,
      riskThreshold: 'high'
    };
  }

  const isUpgradeRecoveryFlow =
    actionType === 'upgrade_verification' ||
    issues.includes('upgraded_session_not_materialized') ||
    issues.includes('workspace_needs_configuration');

  if (isUpgradeRecoveryFlow) {
    if (issues.includes('workspace_needs_configuration')) {
      return {
        until: 'repair',
        skipRecheck: hasRecheck,
        riskThreshold: 'medium'
      };
    }

    if (issues.includes('upgraded_session_not_materialized')) {
      return {
        until: hasRecheck ? 'recheck' : 'repair',
        skipRecheck: false,
        riskThreshold: 'high'
      };
    }

    return {
      until: hasRecheck ? 'recheck' : null,
      skipRecheck: false,
      riskThreshold: 'high'
    };
  }

  const isSessionLinkRepairFlow =
    strategyType.includes('configure_sessions') ||
    issues.includes('session_not_ready');

  if (isSessionLinkRepairFlow) {
    return {
      until: hasRecheck ? 'repair' : null,
      skipRecheck: hasRecheck,
      riskThreshold: 'medium'
    };
  }

  return defaults;
}

function classifyAutoFixRisk(command = '', step = '') {
  const normalizedCommand = String(command || '').toLowerCase();
  const normalizedStep = String(step || '').toLowerCase();

  if (normalizedStep === 'recheck' || /(?:^|\s)(doctor|status:sessions|status-report)(?:\s|$)/.test(normalizedCommand)) {
    return {
      risk_level: 'low',
      requires_confirmation: false,
      risk_reason: 'read_only_verification'
    };
  }

  if (
    /--enable-scheduler/.test(normalizedCommand) ||
    /(?:^|\s)configure:host(?:\s|$)/.test(normalizedCommand) ||
    /(?:^|\s)install-one-click(?:\s|$)/.test(normalizedCommand) ||
    /(?:^|\s)install:host(?:\s|$)/.test(normalizedCommand)
  ) {
    return {
      risk_level: 'high',
      requires_confirmation: true,
      risk_reason: 'host_configuration_change'
    };
  }

  if (
    /(?:^|\s)(migrate:memory|configure:sessions|upgrade:sessions)(?:\s|$)/.test(normalizedCommand) ||
    /--apply-config/.test(normalizedCommand) ||
    /--enforce-memory-takeover/.test(normalizedCommand)
  ) {
    return {
      risk_level: 'medium',
      requires_confirmation: false,
      risk_reason: 'workspace_state_change'
    };
  }

  return {
    risk_level: 'medium',
    requires_confirmation: false,
    risk_reason: 'automatic_remediation'
  };
}

function normalizeCommandSequence(sequence = []) {
  return (Array.isArray(sequence) ? sequence : [])
    .map((entry) =>
      entry?.command
        ? (() => {
            const step = entry.step || 'repair';
            const command = String(entry.command);
            const risk = classifyAutoFixRisk(command, step);
            return {
              step,
              command,
              risk_level: entry.risk_level || risk.risk_level,
              requires_confirmation:
                typeof entry.requires_confirmation === 'boolean'
                  ? entry.requires_confirmation
                  : risk.requires_confirmation,
              risk_reason: entry.risk_reason || risk.risk_reason
            };
          })()
        : null
    )
    .filter(Boolean);
}

function normalizeRiskThreshold(value) {
  const normalized = String(value || '').toLowerCase();
  return Object.prototype.hasOwnProperty.call(RISK_ORDER, normalized) ? normalized : null;
}

function filterAutoFixSequence(sequence = [], options = {}) {
  const normalized = normalizeCommandSequence(sequence);
  const until = options.until ? String(options.until).toLowerCase() : null;
  const skipRecheck = Boolean(options.skipRecheck);
  const riskThreshold = normalizeRiskThreshold(options.riskThreshold);

  let filtered = normalized;

  if (until) {
    const index = filtered.findIndex((entry) => String(entry.step || '').toLowerCase() === until);
    if (index >= 0) {
      filtered = filtered.slice(0, index + 1);
    }
  }

  if (skipRecheck) {
    filtered = filtered.filter((entry) => String(entry.step || '').toLowerCase() !== 'recheck');
  }

  if (riskThreshold) {
    filtered = filtered.filter((entry) => RISK_ORDER[String(entry.risk_level || 'medium').toLowerCase()] <= RISK_ORDER[riskThreshold]);
  }

  return filtered;
}

function encodeAutoFixSequence(sequence = []) {
  const normalized = normalizeCommandSequence(sequence);
  if (normalized.length === 0) {
    return null;
  }

  return Buffer.from(JSON.stringify(normalized), 'utf8').toString('base64url');
}

function decodeAutoFixSequence(token) {
  if (!token) {
    return [];
  }

  const payload = Buffer.from(String(token), 'base64url').toString('utf8');
  return normalizeCommandSequence(JSON.parse(payload));
}

function buildAutoFixCommand(sequence = [], options = {}) {
  const token = encodeAutoFixSequence(sequence);
  if (!token) {
    return null;
  }

  const scriptPath = options.scriptPath || path.join(__dirname, '..', 'auto-fix.js');
  const args = ['node', `"${scriptPath}"`, '--steps', token];

  if (options.assumeYes === true) {
    args.push('--yes');
  }

  if (options.workspace) {
    args.push('--workspace', `"${String(options.workspace)}"`);
  }

  if (options.userId) {
    args.push('--user-id', `"${String(options.userId)}"`);
  }

  if (options.dryRun) {
    args.push('--dry-run');
  }

  const recommendedStrategy = recommendAutoFixStrategy({
    strategyType: options.strategyType,
    actionType: options.actionType,
    issues: options.issues,
    hasFollowUp: normalizeCommandSequence(sequence).some((entry) => entry.step === 'follow_up'),
    hasRecheck: normalizeCommandSequence(sequence).some((entry) => entry.step === 'recheck')
  });
  const effectiveUntil = options.until || recommendedStrategy.until;
  const effectiveSkipRecheck =
    typeof options.skipRecheck === 'boolean' ? options.skipRecheck : recommendedStrategy.skipRecheck;
  const effectiveRiskThreshold = normalizeRiskThreshold(options.riskThreshold || recommendedStrategy.riskThreshold);

  if (effectiveUntil) {
    args.push('--until', String(effectiveUntil));
  }

  if (effectiveSkipRecheck) {
    args.push('--skip-recheck');
  }

  if (effectiveRiskThreshold) {
    args.push('--risk-threshold', effectiveRiskThreshold);
  }

  return args.join(' ');
}

module.exports = {
  buildAutoFixCommand,
  classifyAutoFixRisk,
  decodeAutoFixSequence,
  encodeAutoFixSequence,
  filterAutoFixSequence,
  normalizeCommandSequence,
  normalizeRiskThreshold,
  recommendAutoFixStrategy
};
