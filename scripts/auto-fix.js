#!/usr/bin/env node

const { spawnSync } = require('child_process');
const readline = require('readline');
const { decodeAutoFixSequence, filterAutoFixSequence, normalizeRiskThreshold } = require('./lib/auto-fix');
const { createPaths, DEFAULTS, loadUserState, resolveUserId, writeUserState } = require('./lib/context-anchor');
const { command, field, renderCliError, section, status } = require('./lib/terminal-format');

function parseArgs(argv) {
  const options = {
    steps: null,
    assumeYes: false,
    dryRun: false,
    json: false,
    until: null,
    skipRecheck: null,
    riskThreshold: null,
    workspace: null,
    userId: null,
    saveDefaults: false,
    clearDefaults: false
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === '--steps') {
      options.steps = argv[index + 1] || null;
      index += 1;
      continue;
    }

    if (arg === '--yes') {
      options.assumeYes = true;
      continue;
    }

    if (arg === '--dry-run') {
      options.dryRun = true;
      continue;
    }

    if (arg === '--json') {
      options.json = true;
      continue;
    }

    if (arg === '--until') {
      options.until = argv[index + 1] || null;
      index += 1;
      continue;
    }

    if (arg === '--skip-recheck') {
      options.skipRecheck = true;
      continue;
    }

    if (arg === '--risk-threshold') {
      options.riskThreshold = normalizeRiskThreshold(argv[index + 1] || null);
      index += 1;
      continue;
    }

    if (arg === '--workspace') {
      options.workspace = argv[index + 1] || null;
      index += 1;
      continue;
    }

    if (arg === '--user-id') {
      options.userId = argv[index + 1] || null;
      index += 1;
      continue;
    }

    if (arg === '--save-defaults') {
      options.saveDefaults = true;
      continue;
    }

    if (arg === '--clear-defaults') {
      options.clearDefaults = true;
    }
  }

  return options;
}

function loadAutoFixDefaults(options = {}) {
  const paths = createPaths(options.workspace || process.cwd());
  const userId = resolveUserId(options.userId || DEFAULTS.userId);
  const userState = loadUserState(paths, userId);
  const stored = userState.preferences?.auto_fix_defaults || {};
  return {
    paths,
    userId,
    userState,
    defaults: {
      until: stored.until || null,
      skipRecheck: Boolean(stored.skip_recheck),
      riskThreshold: normalizeRiskThreshold(stored.risk_threshold) || null
    }
  };
}

function persistAutoFixDefaults(context, strategy) {
  const userState = context.userState || {};
  userState.preferences = userState.preferences || {};
  userState.preferences.auto_fix_defaults = {
    until: strategy.until || null,
    skip_recheck: Boolean(strategy.skipRecheck),
    risk_threshold: strategy.riskThreshold || null
  };
  userState.last_updated = new Date().toISOString();
  writeUserState(context.paths, context.userId, userState);
}

function clearAutoFixDefaults(context) {
  const userState = context.userState || {};
  userState.preferences = userState.preferences || {};
  delete userState.preferences.auto_fix_defaults;
  userState.last_updated = new Date().toISOString();
  writeUserState(context.paths, context.userId, userState);
}

function resolveEffectiveStrategy(options = {}, defaults = {}) {
  return {
    until: options.until || defaults.until || null,
    skipRecheck: options.skipRecheck === null ? Boolean(defaults.skipRecheck) : Boolean(options.skipRecheck),
    riskThreshold: options.riskThreshold || defaults.riskThreshold || null
  };
}

function renderPlan(sequence = [], options = {}) {
  const lines = [];
  lines.push(section('Context-Anchor Auto Fix'));
  const highRiskCount = sequence.filter((entry) => entry.risk_level === 'high').length;
  lines.push(
    field(
      'Plan',
      `${status('READY', 'info')} | steps=${sequence.length} | high-risk=${highRiskCount}`,
      { kind: 'info' }
    )
  );
  const strategyParts = [];
  if (options.until) {
    strategyParts.push(`until=${options.until}`);
  }
  if (options.skipRecheck || options.skip_recheck) {
    strategyParts.push('skip-recheck');
  }
  if (options.riskThreshold || options.risk_threshold) {
    strategyParts.push(`risk-threshold<=${options.riskThreshold || options.risk_threshold}`);
  }
  if (strategyParts.length > 0) {
    lines.push(field('Strategy', strategyParts.join(' | '), { kind: 'muted' }));
  }
  if (options.defaultsSource) {
    lines.push(field('Defaults', options.defaultsSource, { kind: 'muted' }));
  }
  sequence.forEach((entry, index) => {
    const riskLabel = `${String(entry.risk_level || 'medium').toUpperCase()}${entry.requires_confirmation ? '/confirm' : ''}`;
    const riskKind = entry.risk_level === 'high' ? 'warning' : entry.risk_level === 'low' ? 'muted' : 'info';
    lines.push(
      field(
        `Step ${index + 1}`,
        `[${riskLabel}] ${entry.step} -> ${command(entry.command)}`,
        { kind: riskKind }
      )
    );
  });
  return lines.join('\n');
}

function askYesNo(prompt) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout
    });
    rl.question(`${prompt} [Y/n] `, (answer) => {
      rl.close();
      const normalized = String(answer || '').trim().toLowerCase();
      resolve(normalized === '' || normalized === 'y' || normalized === 'yes');
    });
  });
}

function formatRiskPrompt(entry, index, total) {
  const riskLabel = String(entry.risk_level || 'medium').toUpperCase();
  return `Run high-risk step ${index + 1}/${total} now? [${riskLabel}] ${entry.step} -> ${entry.command}`;
}

async function executeSequence(sequence = [], options = {}) {
  const results = [];

  for (let index = 0; index < sequence.length; index += 1) {
    const entry = sequence[index];
    if (!options.assumeYes && entry.requires_confirmation && process.stdin.isTTY) {
      const approved = await askYesNo(formatRiskPrompt(entry, index, sequence.length));
      if (!approved) {
        return {
          status: 'cancelled',
          total_steps: sequence.length,
          completed_steps: results.length,
          steps: results,
          skipped_step: {
            index,
            step: entry.step,
            command: entry.command,
            risk_level: entry.risk_level
          }
        };
      }
    }
    console.log(
      field(
        'Run',
        `${index + 1}/${sequence.length} [${String(entry.risk_level || 'medium').toUpperCase()}] ${entry.step} -> ${command(entry.command)}`,
        { kind: entry.risk_level === 'high' ? 'warning' : 'command' }
      )
    );

    const startedAt = Date.now();
    const outcome = spawnSync(entry.command, {
      shell: true,
      stdio: 'inherit'
    });
    const durationMs = Date.now() - startedAt;
    const exitCode = typeof outcome.status === 'number' ? outcome.status : 1;
    results.push({
      step: entry.step,
      command: entry.command,
      exit_code: exitCode,
      duration_ms: durationMs
    });

    if (exitCode !== 0) {
      throw Object.assign(new Error(`Auto fix step failed: ${entry.step}`), {
        results
      });
    }
  }

  return {
    status: 'completed',
    total_steps: sequence.length,
    completed_steps: results.length,
    steps: results
  };
}

async function runAutoFix(options = {}) {
  const decodedSequence = decodeAutoFixSequence(options.steps);
  if (decodedSequence.length === 0) {
    throw new Error('No automatic remediation steps were provided.');
  }
  const defaultsContext = loadAutoFixDefaults(options);
  const strategy = resolveEffectiveStrategy(options, defaultsContext.defaults);
  const sequence = filterAutoFixSequence(decodedSequence, strategy);
  if (sequence.length === 0) {
    throw new Error('No auto-fix steps remain after applying the selected strategy.');
  }
  const defaultsChanged = options.saveDefaults || options.clearDefaults;

  if (options.dryRun) {
    return {
      status: 'planned',
      total_steps: sequence.length,
      high_risk_steps: sequence.filter((entry) => entry.risk_level === 'high').length,
      strategy: {
        until: strategy.until || null,
        skip_recheck: Boolean(strategy.skipRecheck),
        risk_threshold: strategy.riskThreshold || null
      },
      defaults: defaultsContext.defaults,
      defaults_source:
        defaultsContext.defaults.until || defaultsContext.defaults.skipRecheck || defaultsContext.defaults.riskThreshold
          ? 'user preferences'
          : 'none',
      defaults_change:
        defaultsChanged
          ? options.clearDefaults
            ? 'pending_clear'
            : 'pending_save'
          : null,
      steps: sequence
    };
  }

  if (options.clearDefaults) {
    clearAutoFixDefaults(defaultsContext);
  } else if (options.saveDefaults) {
    persistAutoFixDefaults(defaultsContext, strategy);
  }

  if (process.stdout.isTTY) {
    console.log(
      renderPlan(sequence, {
        ...strategy,
        defaultsSource:
          defaultsContext.defaults.until || defaultsContext.defaults.skipRecheck || defaultsContext.defaults.riskThreshold
            ? 'user preferences'
            : 'none'
      })
    );
    console.log('');
  }

  if (!options.assumeYes && process.stdin.isTTY) {
    const approved = await askYesNo(`Run ${sequence.length} automatic remediation step(s) now?`);
    if (!approved) {
      return {
        status: 'cancelled',
        total_steps: sequence.length,
        completed_steps: 0,
        high_risk_steps: sequence.filter((entry) => entry.risk_level === 'high').length,
        strategy: {
          until: strategy.until || null,
          skip_recheck: Boolean(strategy.skipRecheck),
          risk_threshold: strategy.riskThreshold || null
        },
        defaults: defaultsContext.defaults,
        defaults_source:
          defaultsContext.defaults.until || defaultsContext.defaults.skipRecheck || defaultsContext.defaults.riskThreshold
            ? 'user preferences'
            : 'none',
        defaults_change:
          defaultsChanged
            ? options.clearDefaults
              ? 'cleared'
              : 'saved'
            : null,
        steps: sequence
      };
    }
  }

  const result = await executeSequence(sequence, options);
  return {
    ...result,
    high_risk_steps: sequence.filter((entry) => entry.risk_level === 'high').length,
    strategy: {
      until: strategy.until || null,
      skip_recheck: Boolean(strategy.skipRecheck),
      risk_threshold: strategy.riskThreshold || null
    },
    defaults: defaultsContext.defaults,
    defaults_source:
      defaultsContext.defaults.until || defaultsContext.defaults.skipRecheck || defaultsContext.defaults.riskThreshold
        ? 'user preferences'
        : 'none',
    defaults_change:
      defaultsChanged
        ? options.clearDefaults
          ? 'cleared'
          : 'saved'
        : null
  };
}

function renderResult(result) {
  const lines = [];
  lines.push(section('Context-Anchor Auto Fix', { kind: result.status === 'completed' ? 'success' : 'info' }));
  lines.push(
    field(
      'Status',
      `${status(String(result.status || 'unknown').toUpperCase(), result.status === 'completed' ? 'success' : 'info')} | steps=${Number(result.total_steps || 0)} | high-risk=${Number(result.high_risk_steps || 0)}`,
      { kind: result.status === 'completed' ? 'success' : 'info' }
    )
  );
  const strategyParts = [];
  if (result.strategy?.until) {
    strategyParts.push(`until=${result.strategy.until}`);
  }
  if (result.strategy?.skip_recheck) {
    strategyParts.push('skip-recheck');
  }
  if (result.strategy?.risk_threshold) {
    strategyParts.push(`risk-threshold<=${result.strategy.risk_threshold}`);
  }
  if (strategyParts.length > 0) {
    lines.push(field('Strategy', strategyParts.join(' | '), { kind: 'muted' }));
  }
  if (result.defaults_source) {
    lines.push(field('Defaults', result.defaults_source, { kind: 'muted' }));
  }
  if (result.defaults_change) {
    lines.push(field('Defaults update', String(result.defaults_change).replace(/_/g, '-'), { kind: 'info' }));
  }
  const steps = Array.isArray(result.steps) ? result.steps : [];
  steps.forEach((entry, index) => {
    const riskLabel = entry.risk_level ? ` [${String(entry.risk_level).toUpperCase()}]` : '';
    lines.push(
      field(
        `Step ${index + 1}`,
        `${riskLabel} ${entry.step} -> ${command(entry.command)}${typeof entry.exit_code === 'number' ? ` | exit=${entry.exit_code}` : ''}`.trim(),
        { kind: typeof entry.exit_code === 'number' && entry.exit_code !== 0 ? 'danger' : entry.risk_level === 'high' ? 'warning' : 'command' }
      )
    );
  });
  if (result.skipped_step) {
    lines.push(
      field(
        'Skipped',
        `[${String(result.skipped_step.risk_level || 'unknown').toUpperCase()}] ${result.skipped_step.step} -> ${command(result.skipped_step.command)}`,
        { kind: 'warning' }
      )
    );
  }
  return lines.join('\n');
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const result = await runAutoFix(options);
  if (options.json || !process.stdout.isTTY) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  console.log(renderResult(result));
}

if (require.main === module) {
  main().catch((error) => {
    const payload = {
      status: 'error',
      message: error.message,
      steps: Array.isArray(error.results) ? error.results : []
    };
    if (!process.stdout.isTTY) {
      console.log(JSON.stringify(payload, null, 2));
    } else {
      console.log(
        renderCliError('Context-Anchor Auto Fix Failed', error.message, {
          nextStep: 'Review the failed step above, then rerun auto-fix or the individual repair command.'
        })
      );
    }
    process.exit(1);
  });
}

module.exports = {
  executeSequence,
  parseArgs,
  renderPlan,
  renderResult,
  runAutoFix
};
