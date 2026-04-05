#!/usr/bin/env node

const { spawnSync } = require('child_process');
const readline = require('readline');
const { decodeAutoFixSequence, filterAutoFixSequence, normalizeRiskThreshold } = require('./lib/auto-fix');
const { command, field, renderCliError, section, status } = require('./lib/terminal-format');

function parseArgs(argv) {
  const options = {
    steps: null,
    assumeYes: false,
    dryRun: false,
    json: false,
    until: null,
    skipRecheck: false,
    riskThreshold: null
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
    }
  }

  return options;
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
  const sequence = filterAutoFixSequence(decodedSequence, options);
  if (sequence.length === 0) {
    throw new Error('No auto-fix steps remain after applying the selected strategy.');
  }

  if (options.dryRun) {
    return {
      status: 'planned',
      total_steps: sequence.length,
      high_risk_steps: sequence.filter((entry) => entry.risk_level === 'high').length,
      strategy: {
        until: options.until || null,
        skip_recheck: Boolean(options.skipRecheck),
        risk_threshold: options.riskThreshold || null
      },
      steps: sequence
    };
  }

  if (process.stdout.isTTY) {
    console.log(renderPlan(sequence, options));
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
          until: options.until || null,
          skip_recheck: Boolean(options.skipRecheck),
          risk_threshold: options.riskThreshold || null
        },
        steps: sequence
      };
    }
  }

  const result = await executeSequence(sequence, options);
  return {
    ...result,
    high_risk_steps: sequence.filter((entry) => entry.risk_level === 'high').length,
    strategy: {
      until: options.until || null,
      skip_recheck: Boolean(options.skipRecheck),
      risk_threshold: options.riskThreshold || null
    }
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
