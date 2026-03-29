const fs = require('fs');
const path = require('path');
const {
  createPaths,
  loadSessionState,
  readText,
  sanitizeKey,
  sessionCheckpointFile
} = require('./context-anchor');

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

function buildBootstrapCacheContent(summary) {
  const pendingCommitments = summary.recovery.pending_commitments || [];
  const effectiveSkills = Array.isArray(summary.effective_skills) ? summary.effective_skills.slice(0, 6) : [];
  const recommendedExperiences = Array.isArray(summary.recommended_reuse?.experiences)
    ? summary.recommended_reuse.experiences.slice(0, 4)
    : [];
  const recommendedSkills = Array.isArray(summary.recommended_reuse?.skills)
    ? summary.recommended_reuse.skills.slice(0, 4)
    : [];
  const lines = [
    '# Context Anchor Session Memory',
    '',
    `- Session key: ${summary.session.key}`,
    `- Project: ${summary.session.project}`,
    `- User: ${summary.session.user}`,
    summary.session.restored ? '- Restored persistent session context is available.' : '- This is a fresh session context.',
    summary.session.continued_from ? `- Continued from: ${summary.session.continued_from}` : null,
    summary.recovery.active_task ? `- Active task: ${summary.recovery.active_task}` : null,
    pendingCommitments.length > 0 ? `- Pending commitments: ${pendingCommitments.length}` : null,
    '',
    'Use the persisted context below to continue work without re-asking for already-known state.'
  ].filter(Boolean);

  if (pendingCommitments.length > 0) {
    lines.push('', '## Pending Commitments');
    pendingCommitments.slice(0, 5).forEach((entry) => {
      lines.push(`- ${entry.what}${entry.when ? ` (${entry.when})` : ''}`);
    });
  }

  if (summary.recovery.checkpoint_excerpt) {
    lines.push('', '## Checkpoint Excerpt', summary.recovery.checkpoint_excerpt);
  }

  if (effectiveSkills.length > 0) {
    lines.push('', '## Active Skills');
    effectiveSkills.forEach((skill) => {
      lines.push(`- [${skill.scope}] ${skill.name}`);
    });
  }

  if (Array.isArray(summary.memories_to_inject) && summary.memories_to_inject.length > 0) {
    lines.push('', '## Memory Highlights');
    summary.memories_to_inject.slice(0, 4).forEach((group) => {
      lines.push(`### ${group.source}`);
      (group.entries || []).slice(0, 3).forEach((entry) => {
        const summaryText =
          entry.summary ||
          entry.decision ||
          entry.what ||
          entry.key ||
          entry.id ||
          JSON.stringify(entry);
        lines.push(`- ${summaryText}`);
      });
    });
  }

  if (Array.isArray(summary.related_sessions) && summary.related_sessions.length > 0) {
    lines.push('', '## Related Sessions');
    summary.related_sessions.slice(0, 3).forEach((entry) => {
      lines.push(`- ${entry.session_key} (${entry.project_id})`);
    });
  }

  if (recommendedExperiences.length > 0 || recommendedSkills.length > 0) {
    lines.push('', '## Suggested Reuse');
    recommendedExperiences.forEach((entry) => {
      lines.push(`- [experience][${entry.scope}] ${entry.summary}${entry.reasons?.length ? ` (${entry.reasons.join(', ')})` : ''}`);
    });
    recommendedSkills.forEach((entry) => {
      lines.push(`- [skill][${entry.scope}] ${entry.name}${entry.reasons?.length ? ` (${entry.reasons.join(', ')})` : ''}`);
    });
  }

  return lines.join('\n');
}

function buildMinimalBootstrapContent(workspace, sessionKey, ownership) {
  const paths = createPaths(workspace);
  const sessionState = loadSessionState(paths, sessionKey, ownership.project_id, {
    createIfMissing: false,
    touch: false
  });
  if (!sessionState) {
    return '';
  }

  const pendingCommitments = (sessionState.commitments || []).filter((entry) => entry.status === 'pending');
  const checkpoint = readText(sessionCheckpointFile(paths, sessionKey), '');

  return [
    '# Context Anchor Session Memory',
    '',
    `- Session key: ${sessionState.session_key}`,
    `- Project: ${sessionState.project_id}`,
    `- User: ${sessionState.user_id}`,
    sessionState.active_task ? `- Active task: ${sessionState.active_task}` : null,
    pendingCommitments.length > 0 ? `- Pending commitments: ${pendingCommitments.length}` : null,
    '',
    checkpoint ? `## Checkpoint Excerpt\n${checkpoint.split('\n').slice(0, 10).join('\n')}` : null
  ]
    .filter(Boolean)
    .join('\n');
}

module.exports = {
  buildBootstrapCacheContent,
  buildBootstrapCachePath,
  buildMinimalBootstrapContent,
  writeBootstrapCache
};
