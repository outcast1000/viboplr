#!/usr/bin/env node
// Generates a markdown changelog from conventional commits between two git tags.
// Usage: node scripts/generate-changelog.mjs [tag]
// If tag is omitted, uses the latest tag. Finds the previous tag automatically.
// Outputs markdown to stdout.

import { execSync } from 'child_process';

const CATEGORIES = [
  { prefix: 'feat',     title: 'Features' },
  { prefix: 'fix',      title: 'Bug Fixes' },
  { prefix: 'perf',     title: 'Performance' },
  { prefix: 'refactor', title: 'Refactoring' },
  { prefix: 'docs',     title: 'Documentation' },
  { prefix: 'test',     title: 'Tests' },
  { prefix: 'chore',    title: 'Chores' },
  { prefix: 'ci',       title: 'CI' },
  { prefix: 'style',    title: 'Style' },
  { prefix: 'build',    title: 'Build' },
];

function git(cmd) {
  return execSync(`git ${cmd}`, { encoding: 'utf-8' }).trim();
}

function getTags() {
  try {
    return git('tag --sort=-v:refname').split('\n').filter(Boolean);
  } catch {
    return [];
  }
}

function getCommits(from, to) {
  const range = from ? `${from}..${to}` : to;
  const log = git(`log ${range} --pretty=format:"%s"`);
  if (!log) return [];
  return log.split('\n').filter(Boolean);
}

function parseCommit(message) {
  // Match: type(scope): description  or  type: description
  const match = message.match(/^(\w+)(?:\(([^)]+)\))?:\s*(.+)/);
  if (!match) return null;
  return {
    type: match[1],
    scope: match[2] || null,
    description: match[3].replace(/\s*\(#\d+\)$/, ''), // strip PR refs
  };
}

function generateChangelog(commits) {
  const categorized = new Map();
  const uncategorized = [];

  for (const msg of commits) {
    const parsed = parseCommit(msg);
    if (!parsed) {
      // Skip release commits and merge commits
      if (msg.startsWith('release:') || msg.startsWith('Merge ')) continue;
      uncategorized.push(msg);
      continue;
    }

    const category = CATEGORIES.find(c => c.prefix === parsed.type);
    if (!category) {
      if (!msg.startsWith('release:')) uncategorized.push(msg);
      continue;
    }

    if (!categorized.has(category.title)) {
      categorized.set(category.title, []);
    }

    const scopePrefix = parsed.scope ? `**${parsed.scope}**: ` : '';
    categorized.get(category.title).push(`${scopePrefix}${parsed.description}`);
  }

  const lines = [];
  for (const { title } of CATEGORIES) {
    const items = categorized.get(title);
    if (!items || items.length === 0) continue;
    lines.push(`### ${title}`);
    for (const item of items) {
      lines.push(`- ${item}`);
    }
    lines.push('');
  }

  if (uncategorized.length > 0) {
    lines.push('### Other');
    for (const item of uncategorized) {
      lines.push(`- ${item}`);
    }
    lines.push('');
  }

  return lines.join('\n').trim() || 'Maintenance release.';
}

function main() {
  const currentTag = process.argv[2] || getTags()[0];
  if (!currentTag) {
    console.log('Initial release.');
    process.exit(0);
  }

  const tags = getTags();
  const currentIdx = tags.indexOf(currentTag);
  const previousTag = currentIdx >= 0 && currentIdx < tags.length - 1
    ? tags[currentIdx + 1]
    : null;

  const range = previousTag
    ? `${previousTag}..${currentTag}`
    : `all commits up to ${currentTag}`;
  process.stderr.write(`Generating changelog for ${currentTag} (${range})\n`);

  const commits = getCommits(previousTag, currentTag);
  process.stderr.write(`Found ${commits.length} commit(s)\n`);

  const changelog = generateChangelog(commits);
  process.stdout.write(changelog + '\n');
}

main();
