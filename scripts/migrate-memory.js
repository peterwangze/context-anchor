#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { createPaths, resolveProjectId } = require('./lib/context-anchor');
const { runMemorySave } = require('./memory-save');

function parseEntries(content) {
  const entries = [];
  const regex = /## (MEM-[^\n]+)\n([\s\S]*?)(?=## MEM-|## TOOL-|$)/g;
  let match;

  while ((match = regex.exec(content)) !== null) {
    const id = match[1];
    const body = match[2];
    const typeMatch = body.match(/type:\s*(\w+)/);
    const heatMatch = body.match(/heat:\s*(\d+)/);
    const tagsMatch = body.match(/tags:\s*\[([^\]]+)\]/);
    const lines = body.split('\n');
    const contentStart = lines.findIndex((line) => !line.match(/^(type|heat|created|tags|frozen|last_accessed):/));
    const summary = lines.slice(Math.max(contentStart, 0)).join('\n').trim();

    entries.push({
      id,
      type: typeMatch ? typeMatch[1] : 'fact',
      heat: heatMatch ? Number(heatMatch[1]) : undefined,
      tags: tagsMatch ? tagsMatch[1].split(',').map((tag) => tag.trim()) : [],
      summary
    });
  }

  return entries;
}

function runMigrateMemory(workspaceArg, projectIdArg) {
  const paths = createPaths(workspaceArg);
  const projectId = resolveProjectId(paths.workspace, projectIdArg);
  const memoryFile = path.join(paths.workspace, 'MEMORY.md');
  const memoryDir = path.join(paths.workspace, 'memory');
  const result = {
    status: 'migrated',
    decisions: 0,
    experiences: 0,
    facts: 0,
    errors: []
  };

  if (fs.existsSync(memoryFile)) {
    try {
      parseEntries(fs.readFileSync(memoryFile, 'utf8')).forEach((entry) => {
        const type = entry.type === 'decision' ? 'decision' : entry.type;
        const saved = runMemorySave(
          paths.workspace,
          'migration',
          'project',
          type,
          entry.summary,
          JSON.stringify({
            project_id: projectId,
            summary: entry.summary,
            heat: entry.heat,
            tags: entry.tags,
            source: 'migrate-memory'
          })
        );

        if (saved.type === 'decision') {
          result.decisions += 1;
        } else if (saved.type === 'fact') {
          result.facts += 1;
        } else {
          result.experiences += 1;
        }
      });
    } catch (error) {
      result.errors.push(`MEMORY.md: ${error.message}`);
    }
  }

  if (fs.existsSync(memoryDir)) {
    try {
      fs.readdirSync(memoryDir)
        .filter((file) => file.endsWith('.md'))
        .forEach((file) => {
          parseEntries(fs.readFileSync(path.join(memoryDir, file), 'utf8')).forEach((entry) => {
            const saved = runMemorySave(
              paths.workspace,
              'migration',
              'project',
              entry.type,
              entry.summary,
              JSON.stringify({
                project_id: projectId,
                summary: entry.summary,
                heat: entry.heat,
                tags: entry.tags,
                source: 'migrate-memory'
              })
            );

            if (saved.type === 'fact') {
              result.facts += 1;
            } else {
              result.experiences += 1;
            }
          });
        });
    } catch (error) {
      result.errors.push(`memory/: ${error.message}`);
    }
  }

  return result;
}

function main() {
  const result = runMigrateMemory(process.argv[2], process.argv[3]);
  console.log(JSON.stringify(result, null, 2));
}

if (require.main === module) {
  main();
}

module.exports = {
  runMigrateMemory
};
