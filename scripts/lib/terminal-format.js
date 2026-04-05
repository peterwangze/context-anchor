const ANSI = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
  gray: '\x1b[90m'
};

function isColorEnabled(stream = process.stdout) {
  if (process.env.NO_COLOR) {
    return false;
  }

  if (process.env.FORCE_COLOR === '0') {
    return false;
  }

  if (process.env.FORCE_COLOR) {
    return true;
  }

  return Boolean(stream && stream.isTTY && process.env.TERM !== 'dumb');
}

function wrap(text, start, enabled = isColorEnabled()) {
  const value = String(text ?? '');
  if (!enabled || !start) {
    return value;
  }
  return `${start}${value}${ANSI.reset}`;
}

function bold(text, enabled) {
  return wrap(text, ANSI.bold, enabled);
}

function dim(text, enabled) {
  return wrap(text, ANSI.dim, enabled);
}

function color(text, tone, enabled) {
  const code = ANSI[tone] || '';
  return wrap(text, code, enabled);
}

function icon(kind) {
  switch (kind) {
    case 'success':
      return '✓';
    case 'warning':
      return '▲';
    case 'danger':
      return '✖';
    case 'muted':
      return '•';
    case 'command':
      return '›';
    default:
      return 'ℹ';
  }
}

function toneColor(kind) {
  switch (kind) {
    case 'success':
      return 'green';
    case 'warning':
      return 'yellow';
    case 'danger':
      return 'red';
    case 'muted':
      return 'gray';
    case 'command':
      return 'cyan';
    default:
      return 'blue';
  }
}

function bulletLabel(label, kind = 'info', enabled) {
  return color(`${icon(kind)} ${label}`, toneColor(kind), enabled);
}

function section(title, options = {}) {
  const enabled = Object.prototype.hasOwnProperty.call(options, 'enabled')
    ? options.enabled
    : isColorEnabled(options.stream);
  const kind = options.kind || 'info';
  return `${color(icon(kind), toneColor(kind), enabled)} ${bold(title, enabled)}`;
}

function field(label, value, options = {}) {
  const enabled = Object.prototype.hasOwnProperty.call(options, 'enabled')
    ? options.enabled
    : isColorEnabled(options.stream);
  const indent = ' '.repeat(Number(options.indent || 0));
  const kind = options.kind || 'info';
  const renderedValue = options.valueKind
    ? color(value, toneColor(options.valueKind), enabled)
    : value;
  return `${indent}${bulletLabel(`${label}:`, kind, enabled)} ${renderedValue}`;
}

function command(text, enabled) {
  return color(String(text ?? ''), 'cyan', enabled);
}

function status(text, kind = 'info', enabled) {
  return color(bold(String(text ?? ''), enabled), toneColor(kind), enabled);
}

function tag(text, kind = 'info', enabled) {
  return `${color('[', 'gray', enabled)}${status(text, kind, enabled)}${color(']', 'gray', enabled)}`;
}

function renderCliError(title, message, options = {}) {
  const lines = [];
  lines.push(section(title || 'Command Failed', { kind: 'danger' }));
  lines.push(field('Error', String(message || 'Unknown error'), { kind: 'danger' }));
  if (options.nextStep) {
    lines.push(field('Next step', String(options.nextStep), { kind: 'warning' }));
  }
  return lines.join('\n');
}

module.exports = {
  bold,
  command,
  color,
  dim,
  field,
  icon,
  isColorEnabled,
  renderCliError,
  section,
  status,
  tag
};
