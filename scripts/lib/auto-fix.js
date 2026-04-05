const path = require('path');
const RISK_ORDER = {
  low: 0,
  medium: 1,
  high: 2
};

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

  if (options.dryRun) {
    args.push('--dry-run');
  }

  if (options.until) {
    args.push('--until', String(options.until));
  }

  if (options.skipRecheck) {
    args.push('--skip-recheck');
  }

  if (normalizeRiskThreshold(options.riskThreshold)) {
    args.push('--risk-threshold', normalizeRiskThreshold(options.riskThreshold));
  }

  return args.join(' ');
}

module.exports = {
  buildAutoFixCommand,
  classifyAutoFixRisk,
  decodeAutoFixSequence,
  encodeAutoFixSequence,
  filterAutoFixSequence,
  normalizeCommandSequence
  ,
  normalizeRiskThreshold
};
