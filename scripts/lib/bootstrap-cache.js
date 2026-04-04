const fs = require('fs');
const path = require('path');
const {
  DEFAULTS,
  createPaths,
  readRuntimeStateSnapshot,
  loadSessionState,
  readText,
  sanitizeKey,
  sessionCheckpointFile
} = require('./context-anchor');

const RENDER_PROFILES = [
  {
    name: 'rich',
    include: {
      checkpoint: true,
      continuity: true,
      taskState: true,
      reuse: true,
      related: true
    },
    limits: {
      pending: 5,
      preferences: 5,
      hot: 4,
      skills: 4,
      reuseExperiences: 2,
      reuseSkills: 2,
      catalogs: 5,
      related: 2,
      checkpointLines: 6
    },
    widths: {
      header: 260,
      task: 260,
      pending: 180,
      preference: 180,
      hot: 260,
      checkpoint: 220,
      skill: 140,
      reuse: 220,
      catalog: 220,
      related: 140
    }
  },
  {
    name: 'compact',
    include: {
      checkpoint: true,
      continuity: true,
      taskState: true,
      reuse: true,
      related: false
    },
    limits: {
      pending: 4,
      preferences: 4,
      hot: 4,
      skills: 4,
      reuseExperiences: 1,
      reuseSkills: 1,
      catalogs: 5,
      related: 1,
      checkpointLines: 4
    },
    widths: {
      header: 220,
      task: 220,
      pending: 150,
      preference: 150,
      hot: 220,
      checkpoint: 180,
      skill: 120,
      reuse: 180,
      catalog: 180,
      related: 120
    }
  },
  {
    name: 'dense',
    include: {
      checkpoint: true,
      continuity: false,
      taskState: false,
      reuse: false,
      related: false
    },
    limits: {
      pending: 3,
      preferences: 3,
      hot: 3,
      skills: 3,
      reuseExperiences: 0,
      reuseSkills: 0,
      catalogs: 4,
      related: 0,
      checkpointLines: 3
    },
    widths: {
      header: 180,
      task: 180,
      pending: 120,
      preference: 120,
      hot: 180,
      checkpoint: 140,
      skill: 96,
      reuse: 140,
      catalog: 140,
      related: 96
    }
  },
  {
    name: 'emergency',
    include: {
      checkpoint: false,
      continuity: false,
      taskState: false,
      reuse: false,
      related: false
    },
    limits: {
      pending: 2,
      preferences: 2,
      hot: 2,
      skills: 2,
      reuseExperiences: 0,
      reuseSkills: 0,
      catalogs: 3,
      related: 0,
      checkpointLines: 0
    },
    widths: {
      header: 140,
      task: 140,
      pending: 96,
      preference: 96,
      hot: 140,
      checkpoint: 0,
      skill: 80,
      reuse: 0,
      catalog: 120,
      related: 0
    }
  },
  {
    name: 'micro',
    include: {
      checkpoint: false,
      continuity: false,
      taskState: false,
      reuse: false,
      related: false
    },
    limits: {
      pending: 1,
      preferences: 1,
      hot: 1,
      skills: 1,
      reuseExperiences: 0,
      reuseSkills: 0,
      catalogs: 2,
      related: 0,
      checkpointLines: 0
    },
    widths: {
      header: 110,
      task: 110,
      pending: 80,
      preference: 80,
      hot: 110,
      checkpoint: 0,
      skill: 72,
      reuse: 0,
      catalog: 96,
      related: 0
    }
  }
];

function utf8Bytes(value) {
  return Buffer.byteLength(String(value || ''), 'utf8');
}

function normalizeInlineText(value) {
  return String(value || '')
    .replace(/\r\n/g, '\n')
    .replace(/\s+/g, ' ')
    .trim();
}

function splitSemanticUnits(value) {
  const normalized = normalizeInlineText(value);
  if (!normalized) {
    return [];
  }

  return normalized
    .split(/(?<=[。！？!?;；])\s*|\s*[|/]\s*|\s*[,，:：]\s*/u)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function packUnits(units, maxBytes, options = {}) {
  if (!Array.isArray(units) || units.length === 0 || maxBytes <= 0) {
    return '';
  }

  const separator = options.separator || ' / ';
  let output = '';
  let used = 0;

  for (const unit of units) {
    const next = output ? `${output}${separator}${unit}` : unit;
    if (utf8Bytes(next) > maxBytes) {
      break;
    }

    output = next;
    used += 1;
  }

  if (!output) {
    return '';
  }

  const remaining = units.length - used;
  if (remaining <= 0) {
    return output;
  }

  const suffix = options.overflowFormatter ? options.overflowFormatter(remaining) : ` (+${remaining})`;
  return utf8Bytes(`${output}${suffix}`) <= maxBytes ? `${output}${suffix}` : output;
}

function compactText(value, maxBytes, options = {}) {
  const normalized = normalizeInlineText(value);
  if (!normalized || maxBytes <= 0) {
    return '';
  }

  if (utf8Bytes(normalized) <= maxBytes) {
    return normalized;
  }

  const compacted = packUnits(splitSemanticUnits(normalized), maxBytes, {
    separator: options.separator || ' / ',
    overflowFormatter: options.overflowFormatter
  });
  if (compacted) {
    return compacted;
  }

  const tokens = normalized.match(/[\p{L}\p{N}_-]+/gu) || [];
  const tokenPacked = packUnits(tokens, maxBytes, {
    separator: ' ',
    overflowFormatter: (remaining) => ` (+${remaining})`
  });
  if (tokenPacked) {
    return tokenPacked;
  }

  for (const char of normalized) {
    if (utf8Bytes(char) <= maxBytes) {
      return char;
    }
  }

  return '';
}

function renderSection(title, lines) {
  const filtered = (lines || []).filter(Boolean);
  if (filtered.length === 0) {
    return '';
  }

  return `${title}\n${filtered.join('\n')}`;
}

function renderOverflowLine(count, label) {
  if (count <= 0) {
    return null;
  }

  return `- +${count} more ${label}`;
}

function formatList(items, limit, formatter) {
  const source = Array.isArray(items) ? items : [];
  const lines = source.slice(0, limit).map((entry) => formatter(entry)).filter(Boolean);
  const overflowLine = renderOverflowLine(source.length - Math.min(source.length, limit), 'items');
  if (overflowLine) {
    lines.push(overflowLine);
  }
  return lines;
}

function findMemoryGroup(summary, source) {
  return Array.isArray(summary.memories_to_inject)
    ? summary.memories_to_inject.find((entry) => entry.source === source)
    : null;
}

function buildLookupHint(summary) {
  return `node scripts/memory-search.js <workspace> ${summary.session.key} <query>`;
}

function summarizeCheckpoint(checkpointExcerpt, profile) {
  if (!checkpointExcerpt || profile.limits.checkpointLines <= 0) {
    return [];
  }

  const lines = String(checkpointExcerpt)
    .split('\n')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .filter((entry) => !/^#\s*Context Checkpoint/i.test(entry))
    .map((entry) => entry.replace(/^#+\s*/, ''))
    .map((entry) => (entry.startsWith('- ') ? entry : `- ${entry}`));

  const rendered = lines
    .slice(0, profile.limits.checkpointLines)
    .map((entry) => compactText(entry, profile.widths.checkpoint));
  const overflow = renderOverflowLine(lines.length - Math.min(lines.length, profile.limits.checkpointLines), 'checkpoint lines');
  if (overflow) {
    rendered.push(overflow);
  }
  return rendered;
}

function renderHeader(summary, profile, budgetBytes) {
  return renderSection('# Context Anchor Session Memory', [
    `- session: ${compactText(summary.session.key, profile.widths.header)}`,
    `- project: ${compactText(summary.session.project, profile.widths.header)}`,
    `- user: ${compactText(summary.session.user, profile.widths.header)}`,
    `- state: ${summary.session.restored ? 'restored' : 'fresh'}`,
    summary.session.continued_from
      ? `- Continued from: ${compactText(summary.session.continued_from, Math.max(72, Math.floor(profile.widths.header / 2)))}`
      : null,
    summary.recovery.active_task ? `- task: ${compactText(summary.recovery.active_task, profile.widths.task)}` : null,
    summary.recovery.pending_commitments?.length
      ? `- pending: ${summary.recovery.pending_commitments.length}`
      : null,
    `- policy: hot-only preload; long-term lookup; budget<=${budgetBytes}B`
  ]);
}

function renderPendingCommitments(summary, profile) {
  const pending = summary.recovery.pending_commitments || [];
  return renderSection(
    '## Pending Commitments',
    formatList(pending, profile.limits.pending, (entry) =>
      `- ${compactText(
        `${entry.what}${entry.when ? ` (${entry.when})` : ''}`,
        profile.widths.pending
      )}`
    )
  );
}

function renderCurrentTaskState(summary, profile) {
  if (profile.include?.taskState === false) {
    return '';
  }

  const taskState = summary.recovery?.task_state_summary || summary.boot_packet?.task_state_summary || null;
  if (!taskState || taskState.visible !== true) {
    return '';
  }

  return renderSection('## Current Task State', [
    taskState.current_goal
      ? `- goal: ${compactText(taskState.current_goal, profile.widths.task)}`
      : null,
    taskState.latest_verified_result
      ? `- latest result: ${compactText(taskState.latest_verified_result, profile.widths.hot)}`
      : null,
    taskState.last_user_visible_progress
      ? `- progress: ${compactText(taskState.last_user_visible_progress, profile.widths.hot)}`
      : null,
    taskState.next_step
      ? `- next step: ${compactText(taskState.next_step, profile.widths.pending)}`
      : null,
    taskState.blocked_by
      ? `- blocked by: ${compactText(taskState.blocked_by, profile.widths.pending)}`
      : null,
    taskState.pending_commitments?.length
      ? `- pending commitments: ${taskState.pending_commitments.length}`
      : null
  ]);
}

function renderRecoveredContinuity(summary, profile) {
  if (profile.include?.continuity === false) {
    return '';
  }

  const continuity = summary.recovery?.continuity_summary || summary.boot_packet?.continuity_summary || null;
  if (!continuity || continuity.visible !== true) {
    return '';
  }

  const recoveredAssets = [];
  if (continuity.recovered_assets?.summary) {
    recoveredAssets.push('summary');
  }
  if (continuity.recovered_assets?.compact_packet) {
    recoveredAssets.push('compact-packet');
  }
  if (continuity.recovered_assets?.checkpoint) {
    recoveredAssets.push('checkpoint');
  }

  return renderSection('## Recovered Continuity', [
    continuity.source_session_key
      ? `- source: ${compactText(continuity.source_session_key, profile.widths.pending)}`
      : null,
    continuity.restored_goal
      ? `- goal: ${compactText(continuity.restored_goal, profile.widths.task)}`
      : null,
    continuity.latest_result
      ? `- latest result: ${compactText(continuity.latest_result, profile.widths.hot)}`
      : null,
    continuity.last_user_visible_progress
      ? `- progress: ${compactText(continuity.last_user_visible_progress, profile.widths.hot)}`
      : null,
    continuity.next_step
      ? `- next step: ${compactText(continuity.next_step, profile.widths.pending)}`
      : null,
    continuity.blocked_by
      ? `- blocked by: ${compactText(continuity.blocked_by, profile.widths.pending)}`
      : null,
    recoveredAssets.length > 0
      ? `- recovered: ${compactText(recoveredAssets.join(', '), profile.widths.preference)}`
      : null,
    continuity.reference_only ? '- mode: reference-only continuity' : null
  ]);
}

function renderUserPreferences(summary, profile) {
  const preferences = findMemoryGroup(summary, 'user_preferences')?.entries || [];
  return renderSection(
    '## User Preferences',
    formatList(preferences, profile.limits.preferences, (entry) =>
      `- ${compactText(`${entry.key}=${entry.value}`, profile.widths.preference)}`
    )
  );
}

function renderHotMemories(summary, profile) {
  const hotMemories = findMemoryGroup(summary, 'short_term_hot_memories')?.entries || [];
  return renderSection(
    '## Short-Term Hot Memory',
    formatList(hotMemories, profile.limits.hot, (entry) => {
      const prefix = `${entry.source || 'session'}/${entry.type || 'memory'} h${entry.heat}`;
      const sessionNote = entry.source_session ? ` @${entry.source_session}` : '';
      const summaryText = compactText(entry.summary, profile.widths.hot);
      return `- ${prefix}${sessionNote}: ${summaryText}`;
    })
  );
}

function renderActiveSkills(summary, profile) {
  const skills = Array.isArray(summary.effective_skills) ? summary.effective_skills : [];
  return renderSection(
    '## Active Skills',
    formatList(skills, profile.limits.skills, (skill) =>
      `- ${compactText(`[${skill.scope}] ${skill.name}`, profile.widths.skill)}`
    )
  );
}

function renderSuggestedReuse(summary, profile) {
  if (!profile.include.reuse) {
    return '';
  }

  const experiences = Array.isArray(summary.recommended_reuse?.experiences)
    ? summary.recommended_reuse.experiences.slice(0, profile.limits.reuseExperiences)
    : [];
  const skills = Array.isArray(summary.recommended_reuse?.skills)
    ? summary.recommended_reuse.skills.slice(0, profile.limits.reuseSkills)
    : [];
  const lines = [
    ...experiences.map((entry) =>
      `- exp/${entry.scope}: ${compactText(entry.summary, profile.widths.reuse)}${
        entry.reasons?.length ? ` [${entry.reasons.slice(0, 2).join(',')}]` : ''
      }`
    ),
    ...skills.map((entry) =>
      `- skill/${entry.scope}: ${compactText(entry.name, profile.widths.reuse)}${
        entry.reasons?.length ? ` [${entry.reasons.slice(0, 2).join(',')}]` : ''
      }`
    )
  ];

  return renderSection('## Suggested Reuse', lines);
}

function renderCheckpoint(summary, profile) {
  if (!profile.include.checkpoint || !summary.recovery.checkpoint_excerpt) {
    return '';
  }

  return renderSection('## Checkpoint Excerpt', summarizeCheckpoint(summary.recovery.checkpoint_excerpt, profile));
}

function renderPersistentMemory(summary, profile) {
  const catalogs = Array.isArray(summary.persistent_memory?.catalogs) ? summary.persistent_memory.catalogs : [];
  let lines;

  if (profile.name === 'dense' || profile.name === 'emergency' || profile.name === 'micro') {
    const totals = catalogs.reduce(
      (acc, entry) => {
        acc.catalogs += 1;
        acc.items += Number(entry.count || 0);
        acc[entry.tier] = Number(acc[entry.tier] || 0) + Number(entry.count || 0);
        return acc;
      },
      {
        catalogs: 0,
        items: 0,
        warm: 0,
        cold: 0,
        hot: 0
      }
    );

    lines = [
      `- persisted: ${compactText(
        `${totals.catalogs} catalogs ${totals.items} items warm=${totals.warm} cold=${totals.cold}`,
        profile.widths.catalog,
        {
          separator: ' '
        }
      )}`,
      `- lookup: ${buildLookupHint(summary)}`
    ];
  } else {
    lines = [
      ...formatList(catalogs, profile.limits.catalogs, (entry) => {
        const parts = [`[${entry.tier}]`, `[${entry.scope}]`, `${entry.source}`, `${entry.count} items`];
        if (entry.hot_count) {
          parts.push(`${entry.hot_count} hot`);
        }
        if (entry.validated_count) {
          parts.push(`${entry.validated_count} validated`);
        }

        return `- ${compactText(parts.join(' '), profile.widths.catalog, {
          separator: ' '
        })}`;
      }),
      `- lookup: ${buildLookupHint(summary)}`
    ];
  }

  return renderSection('## Long-Term Memory', lines);
}

function renderRelatedSessions(summary, profile) {
  if (!profile.include.related) {
    return '';
  }

  const sessions = Array.isArray(summary.related_sessions) ? summary.related_sessions : [];
  return renderSection(
    '## Related Sessions',
    formatList(sessions, profile.limits.related, (entry) =>
      `- ${compactText(`${entry.session_key} (${entry.project_id})`, profile.widths.related)}`
    )
  );
}

function renderSummaryWithProfile(summary, profile, budgetBytes) {
  return [
    renderHeader(summary, profile, budgetBytes),
    renderCurrentTaskState(summary, profile),
    renderRecoveredContinuity(summary, profile),
    renderPendingCommitments(summary, profile),
    renderUserPreferences(summary, profile),
    renderHotMemories(summary, profile),
    renderCheckpoint(summary, profile),
    renderActiveSkills(summary, profile),
    renderSuggestedReuse(summary, profile),
    renderPersistentMemory(summary, profile),
    renderRelatedSessions(summary, profile)
  ]
    .filter(Boolean)
    .join('\n\n');
}

function chooseBudgetedRender(renderers, budgetBytes) {
  const normalizedBudget = Number(budgetBytes || DEFAULTS.bootstrapContextBudget);
  const candidates = renderers
    .map((renderer) =>
      String(renderer() || '')
        .replace(/\r\n/g, '\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim()
    )
    .filter(Boolean);

  for (const candidate of candidates) {
    if (utf8Bytes(candidate) <= normalizedBudget) {
      return candidate;
    }
  }

  return candidates[candidates.length - 1] || '';
}

function buildBootstrapCachePath(workspace, sessionKey) {
  const paths = createPaths(workspace);
  return path.join(paths.sessionsDir, sanitizeKey(sessionKey), 'openclaw-bootstrap.md');
}

function ensureParentDir(targetFile) {
  fs.mkdirSync(path.dirname(targetFile), { recursive: true });
}

function writeBootstrapCache(targetFile, content) {
  ensureParentDir(targetFile);
  fs.writeFileSync(targetFile, `${String(content || '').trim()}\n`, 'utf8');
}

function buildBootstrapCacheContent(summary, options = {}) {
  const budgetBytes = Number(options.budgetBytes || DEFAULTS.bootstrapContextBudget);
  return chooseBudgetedRender(
    RENDER_PROFILES.map((profile) => () => renderSummaryWithProfile(summary, profile, budgetBytes)),
    budgetBytes
  );
}

function buildMinimalSummary(sessionState, pendingCommitments, checkpoint, budgetBytes) {
  return {
    session: {
      key: sessionState.session_key,
      project: sessionState.project_id,
      user: sessionState.user_id,
      restored: Boolean(sessionState.active_task || pendingCommitments.length > 0 || checkpoint.trim())
    },
    recovery: {
      active_task: sessionState.active_task,
      pending_commitments: pendingCommitments,
      checkpoint_excerpt: checkpoint ? checkpoint.split('\n').slice(0, 10).join('\n') : null,
      task_state_summary: {
        current_goal: sessionState.active_task || null,
        latest_verified_result: null,
        next_step: pendingCommitments[0]?.what || null,
        blocked_by: null,
        last_user_visible_progress: null,
        pending_commitments: pendingCommitments,
        visible:
          Boolean(sessionState.active_task) ||
          pendingCommitments.length > 0
      },
      continuity_summary: {
        source_session_key: sessionState.metadata?.continued_from_session || null,
        restored_goal: sessionState.active_task || null,
        latest_result: null,
        next_step: pendingCommitments[0]?.what || null,
        recovered_assets: {
          checkpoint: Boolean(checkpoint.trim()),
          summary: false,
          compact_packet: false
        },
        reference_only: false,
        visible:
          Boolean(sessionState.active_task) ||
          pendingCommitments.length > 0 ||
          Boolean(sessionState.metadata?.continued_from_session)
      }
    },
    memories_to_inject: [],
    effective_skills: [],
    recommended_reuse: {
      experiences: [],
      skills: []
    },
    boot_packet: {
      task_state_summary: {
        current_goal: sessionState.active_task || null,
        latest_verified_result: null,
        next_step: pendingCommitments[0]?.what || null,
        blocked_by: null,
        last_user_visible_progress: null,
        pending_commitments: pendingCommitments,
        visible:
          Boolean(sessionState.active_task) ||
          pendingCommitments.length > 0
      }
    },
    persistent_memory: {
      catalogs: [],
      lookup_command: `node scripts/memory-search.js "<workspace>" "${sessionState.session_key}" "<query>"`
    },
    related_sessions: [],
    memory_policy: {
      bootstrap_context_budget: budgetBytes
    }
  };
}

function buildMinimalBootstrapContent(workspace, sessionKey, ownership, options = {}) {
  const paths = createPaths(workspace);
  const budgetBytes = Number(options.budgetBytes || DEFAULTS.bootstrapContextBudget);
  const sessionState = loadSessionState(paths, sessionKey, ownership.project_id, {
    createIfMissing: false,
    touch: false
  });
  const runtimeState = readRuntimeStateSnapshot(paths, sessionKey, ownership.project_id, {
    userId: ownership.user_id || sessionState?.user_id || null
  });
  if (!sessionState && !runtimeState) {
    return '';
  }

  const pendingCommitments = Array.isArray(runtimeState?.pending_commitments)
    ? runtimeState.pending_commitments
    : (sessionState?.commitments || []).filter((entry) => entry.status === 'pending');
  const checkpoint = readText(sessionCheckpointFile(paths, sessionKey), '');
  const summary = buildMinimalSummary(
    {
      ...(sessionState || {}),
      session_key: runtimeState?.session_key || sessionState?.session_key || sanitizeKey(sessionKey),
      project_id: runtimeState?.project_id || sessionState?.project_id || ownership.project_id || null,
      user_id: runtimeState?.user_id || sessionState?.user_id || ownership.user_id || null,
      active_task:
        Object.prototype.hasOwnProperty.call(runtimeState || {}, 'active_task')
          ? runtimeState.active_task
          : sessionState?.active_task || null
    },
    pendingCommitments,
    checkpoint,
    budgetBytes
  );

  return chooseBudgetedRender(
    RENDER_PROFILES.map((profile) => () => renderSummaryWithProfile(summary, profile, budgetBytes)),
    budgetBytes
  );
}

module.exports = {
  buildBootstrapCacheContent,
  buildBootstrapCachePath,
  buildMinimalBootstrapContent,
  writeBootstrapCache
};
