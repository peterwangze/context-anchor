const path = require('path');

const { DEFAULTS, loadUserState, writeUserState } = require('./context-anchor');

const TRACKED_RESUME_INPUTS = new Set([
  'workspace',
  'session-key',
  'project-id',
  'user-id',
  'openclaw-home',
  'skills-root'
]);
const MAX_VALUES_PER_INPUT = 12;

function nowIso() {
  return new Date().toISOString();
}

function normalizeResumePreferences(store = {}) {
  const inputs = {};

  Object.entries(store?.inputs || {}).forEach(([input, entry]) => {
    const key = String(input || '').toLowerCase();
    if (!TRACKED_RESUME_INPUTS.has(key)) {
      return;
    }
    const values = {};
    Object.entries(entry?.values || {}).forEach(([valueKey, valueEntry]) => {
      const normalizedKey = String(valueKey || '').trim();
      if (!normalizedKey) {
        return;
      }
      values[normalizedKey] = {
        count: Math.max(0, Number(valueEntry?.count || 0)),
        last_selected_at: valueEntry?.last_selected_at || null
      };
    });
    if (Object.keys(values).length > 0) {
      inputs[key] = {
        values
      };
    }
  });

  return {
    version: 1,
    updated_at: store?.updated_at || null,
    inputs
  };
}

function canonicalizeResumeValue(input, value) {
  const key = String(input || '').toLowerCase();
  const normalized = String(value || '').trim();
  if (!normalized || /^<[^>]+>$/.test(normalized)) {
    return null;
  }

  if (key === 'workspace' || key === 'openclaw-home' || key === 'skills-root') {
    const resolved = path.normalize(path.resolve(normalized));
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
  }

  return normalized;
}

function getResumePreferenceStats(store = {}, input, value) {
  const canonical = canonicalizeResumeValue(input, value);
  if (!canonical) {
    return {
      count: 0,
      last_selected_at: null
    };
  }

  const normalizedStore = normalizeResumePreferences(store);
  const entry = normalizedStore.inputs[String(input || '').toLowerCase()]?.values?.[canonical];
  return {
    count: Math.max(0, Number(entry?.count || 0)),
    last_selected_at: entry?.last_selected_at || null
  };
}

function loadResumePreferences(paths, userId = DEFAULTS.userId) {
  if (!paths) {
    return normalizeResumePreferences({});
  }
  const userState = loadUserState(paths, userId);
  return normalizeResumePreferences(userState?.metadata?.resume_candidate_preferences || {});
}

function pruneResumePreferences(store = {}) {
  const normalizedStore = normalizeResumePreferences(store);
  const prunedInputs = {};

  Object.entries(normalizedStore.inputs).forEach(([input, entry]) => {
    const rankedValues = Object.entries(entry.values)
      .sort((left, right) => {
        const countDelta = Number(right[1]?.count || 0) - Number(left[1]?.count || 0);
        if (countDelta !== 0) {
          return countDelta;
        }
        const rightTs = Date.parse(right[1]?.last_selected_at || 0) || 0;
        const leftTs = Date.parse(left[1]?.last_selected_at || 0) || 0;
        if (rightTs !== leftTs) {
          return rightTs - leftTs;
        }
        return left[0].localeCompare(right[0]);
      })
      .slice(0, MAX_VALUES_PER_INPUT);

    if (rankedValues.length === 0) {
      return;
    }

    prunedInputs[input] = {
      values: Object.fromEntries(rankedValues)
    };
  });

  return {
    version: 1,
    updated_at: normalizedStore.updated_at || nowIso(),
    inputs: prunedInputs
  };
}

function recordResumeSelections(paths, userId = DEFAULTS.userId, selections = {}) {
  if (!paths) {
    return normalizeResumePreferences({});
  }

  const userState = loadUserState(paths, userId);
  const store = normalizeResumePreferences(userState?.metadata?.resume_candidate_preferences || {});
  let changed = false;

  Object.entries(selections || {}).forEach(([input, rawValue]) => {
    const key = String(input || '').toLowerCase();
    if (!TRACKED_RESUME_INPUTS.has(key)) {
      return;
    }

    const canonical = canonicalizeResumeValue(key, rawValue);
    if (!canonical) {
      return;
    }

    if (key === 'session-key' && canonical === DEFAULTS.sessionKey) {
      return;
    }

    store.inputs[key] = store.inputs[key] || { values: {} };
    const current = store.inputs[key].values[canonical] || {};
    store.inputs[key].values[canonical] = {
      count: Math.max(0, Number(current.count || 0)) + 1,
      last_selected_at: nowIso()
    };
    changed = true;
  });

  if (!changed) {
    return store;
  }

  const nextStore = pruneResumePreferences({
    ...store,
    updated_at: nowIso()
  });
  userState.metadata = userState.metadata || {};
  userState.metadata.resume_candidate_preferences = nextStore;
  writeUserState(paths, userId, userState);
  return nextStore;
}

module.exports = {
  canonicalizeResumeValue,
  getResumePreferenceStats,
  loadResumePreferences,
  normalizeResumePreferences,
  recordResumeSelections
};
