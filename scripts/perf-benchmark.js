#!/usr/bin/env node

const fs = require('fs');
const os = require('os');
const path = require('path');

const { createPaths, writeProjectExperienceArchive, writeProjectExperiences } = require('./lib/context-anchor');
const { runMemorySearch } = require('./memory-search');
const { runMirrorRebuild } = require('./mirror-rebuild');
const { runSessionStart } = require('./session-start');
const { runStorageGovernance } = require('./storage-governance');

function nowMs() {
  return Number(process.hrtime.bigint()) / 1e6;
}

function measure(fn) {
  const started = nowMs();
  const result = fn();
  return {
    duration_ms: Number((nowMs() - started).toFixed(3)),
    result
  };
}

function parseArgs(argv) {
  const options = {
    workspaceRoot: null,
    workspaceCount: 1,
    activeItems: 1000,
    archiveItems: 1000,
    keepData: false
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === '--workspace-root') {
      options.workspaceRoot = argv[index + 1] || null;
      index += 1;
      continue;
    }

    if (arg === '--workspace-count') {
      options.workspaceCount = Number(argv[index + 1] || options.workspaceCount);
      index += 1;
      continue;
    }

    if (arg === '--active-items') {
      options.activeItems = Number(argv[index + 1] || options.activeItems);
      index += 1;
      continue;
    }

    if (arg === '--archive-items') {
      options.archiveItems = Number(argv[index + 1] || options.archiveItems);
      index += 1;
      continue;
    }

    if (arg === '--keep-data') {
      options.keepData = true;
    }
  }

  return options;
}

function buildExperience(kind, workspaceIndex, itemIndex, options = {}) {
  return {
    id: `bench-${kind}-${workspaceIndex}-${itemIndex}`,
    type: 'best_practice',
    summary: `${kind} benchmark ${workspaceIndex}-${itemIndex}`,
    details: `${kind} details `.repeat(options.repeat || 30).trim(),
    solution: `${kind} solution `.repeat(options.repeat || 20).trim(),
    source: 'perf-benchmark',
    created_at: `2026-04-${String((itemIndex % 28) + 1).padStart(2, '0')}T00:00:00.000Z`,
    last_accessed: `2026-04-${String((itemIndex % 28) + 1).padStart(2, '0')}T12:00:00.000Z`,
    heat: Math.max(10, 100 - (itemIndex % 90)),
    access_count: (itemIndex % 8) + 1,
    access_sessions: [`bench-session-${workspaceIndex}`, `bench-session-${workspaceIndex}-${itemIndex % 3}`],
    validation: {
      status: itemIndex % 4 === 0 ? 'validated' : 'pending'
    },
    archived: kind === 'archive',
    archived_at: kind === 'archive' ? '2026-04-01T00:00:00.000Z' : null,
    archive_reason: kind === 'archive' ? 'benchmark_seed' : null
  };
}

function seedWorkspaceDataset(workspaceRoot, openClawHome, workspaceIndex, options) {
  const workspace = path.join(workspaceRoot, `workspace-${workspaceIndex + 1}`);
  fs.mkdirSync(workspace, { recursive: true });

  const previousOpenClawHome = process.env.OPENCLAW_HOME;
  process.env.OPENCLAW_HOME = openClawHome;
  try {
    const sessionKey = `bench-session-${workspaceIndex + 1}`;
    const projectId = `bench-project-${workspaceIndex + 1}`;
    runSessionStart(workspace, sessionKey, projectId);
    const paths = createPaths(workspace);

    const activeEntries = Array.from({ length: options.activeItems }, (_, itemIndex) =>
      buildExperience('active', workspaceIndex + 1, itemIndex + 1, {
        repeat: 12
      })
    );
    const archiveEntries = Array.from({ length: options.archiveItems }, (_, itemIndex) =>
      buildExperience('archive', workspaceIndex + 1, itemIndex + 1, {
        repeat: 40
      })
    );

    if (activeEntries.length > 0) {
      activeEntries[0].summary = `active exact needle workspace ${workspaceIndex + 1}`;
      activeEntries[0].details = 'active exact needle details';
    }
    if (archiveEntries.length > 0) {
      archiveEntries[0].summary = `archive sentinel workspace ${workspaceIndex + 1}`;
      archiveEntries[0].details = 'archive sentinel details';
    }

    writeProjectExperiences(paths, projectId, activeEntries);
    writeProjectExperienceArchive(paths, projectId, archiveEntries);

    return {
      workspace,
      session_key: sessionKey,
      project_id: projectId,
      user_id: 'default-user',
      active_items: activeEntries.length,
      archive_items: archiveEntries.length
    };
  } finally {
    if (previousOpenClawHome === undefined) {
      delete process.env.OPENCLAW_HOME;
    } else {
      process.env.OPENCLAW_HOME = previousOpenClawHome;
    }
  }
}

function runPerfBenchmark(workspaceRootArg, options = {}) {
  const workspaceRoot =
    workspaceRootArg ||
    options.workspaceRoot ||
    fs.mkdtempSync(path.join(os.tmpdir(), 'context-anchor-benchmark-'));
  const openClawHome = path.join(workspaceRoot, 'openclaw-home');
  const workspaceCount = Number(options.workspaceCount || 1);
  const activeItems = Number(options.activeItems || 1000);
  const archiveItems = Number(options.archiveItems || 1000);
  const keepData = Boolean(options.keepData);
  const previousOpenClawHome = process.env.OPENCLAW_HOME;

  fs.mkdirSync(workspaceRoot, { recursive: true });
  fs.mkdirSync(openClawHome, { recursive: true });

  process.env.OPENCLAW_HOME = openClawHome;

  try {
    const datasets = Array.from({ length: workspaceCount }, (_, workspaceIndex) =>
      seedWorkspaceDataset(workspaceRoot, openClawHome, workspaceIndex, {
        activeItems,
        archiveItems
      })
    );
    const primary = datasets[0];
    const archiveProbe = seedWorkspaceDataset(workspaceRoot, openClawHome, workspaceCount, {
      activeItems: 0,
      archiveItems
    });

    const activeSearch = measure(() =>
      runMemorySearch(primary.workspace, primary.session_key, 'active exact needle')
    );
    const governance = measure(() =>
      runStorageGovernance(primary.workspace, primary.session_key, {
        projectId: primary.project_id,
        userId: primary.user_id,
        reason: 'perf-benchmark'
      })
    );
    const archiveSearch = measure(() =>
      runMemorySearch(archiveProbe.workspace, archiveProbe.session_key, 'archive sentinel')
    );

    [...datasets, archiveProbe].forEach((dataset) => {
      const dbFile = path.join(dataset.workspace, '.context-anchor', 'catalog.sqlite');
      if (fs.existsSync(dbFile)) {
        fs.rmSync(dbFile, { force: true });
      }
    });
    const userDbFile = path.join(openClawHome, 'context-anchor', 'users', 'catalog.sqlite');
    if (fs.existsSync(userDbFile)) {
      fs.rmSync(userDbFile, { force: true });
    }

    const rebuild = measure(() =>
      datasets.map((dataset) => runMirrorRebuild(dataset.workspace, openClawHome, {}))
    );

    return {
      status: 'ok',
      workspace_root: workspaceRoot,
      openclaw_home: openClawHome,
      keep_data: keepData,
      generated: {
        workspace_count: datasets.length,
        active_items_per_workspace: activeItems,
        archive_items_per_workspace: archiveItems,
        total_items:
          datasets.reduce((sum, dataset) => sum + dataset.active_items + dataset.archive_items, 0) +
          archiveProbe.active_items +
          archiveProbe.archive_items,
        archive_probe_items: archiveProbe.active_items + archiveProbe.archive_items
      },
      metrics: {
        active_search_ms: activeSearch.duration_ms,
        archive_fallback_search_ms: archiveSearch.duration_ms,
        governance_ms: governance.duration_ms,
        mirror_rebuild_ms: rebuild.duration_ms
      },
      targets: {
        active_search_ms: 100,
        archive_fallback_search_ms: 300
      },
      evaluations: {
        active_search_within_target: activeSearch.duration_ms < 100,
        archive_fallback_within_target: archiveSearch.duration_ms < 300
      },
      samples: {
        active_search_returned: activeSearch.result.returned,
        active_search_tier: activeSearch.result.results[0]?.tier || null,
        archive_search_returned: archiveSearch.result.returned,
        archive_search_tier: archiveSearch.result.results[0]?.tier || null,
        governance_archived: governance.result.totals.archived,
        mirror_rebuild_workspaces: rebuild.result.length
      }
    };
  } finally {
    if (previousOpenClawHome === undefined) {
      delete process.env.OPENCLAW_HOME;
    } else {
      process.env.OPENCLAW_HOME = previousOpenClawHome;
    }

    if (!keepData && fs.existsSync(workspaceRoot)) {
      fs.rmSync(workspaceRoot, { recursive: true, force: true });
    }
  }
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const result = runPerfBenchmark(options.workspaceRoot, options);
  console.log(JSON.stringify(result, null, 2));
}

if (require.main === module) {
  main();
}

module.exports = {
  parseArgs,
  runPerfBenchmark
};
