// Shared conventional-commit changelog utilities.
// Used by both generate-changelog.mjs (CLI) and bump.mjs (release orchestrator).

export const CATEGORIES = [
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

export function parseCommit(message) {
  // Match: type(scope): description  or  type: description
  const match = message.match(/^(\w+)(?:\(([^)]+)\))?:\s*(.+)/);
  if (!match) return null;
  return {
    type: match[1],
    scope: match[2] || null,
    description: match[3].replace(/\s*\(#\d+\)$/, ''), // strip PR refs
  };
}

export function generateChangelog(commits) {
  const categorized = new Map();
  const uncategorized = [];

  for (const msg of commits) {
    const parsed = parseCommit(msg);
    if (!parsed) {
      // Skip release commits and merge commits
      if (msg.startsWith('release:') || msg.startsWith('Merge ')) continue;
      if (!uncategorized.includes(msg)) uncategorized.push(msg);
      continue;
    }

    const category = CATEGORIES.find(c => c.prefix === parsed.type);
    if (!category) {
      if (!msg.startsWith('release:') && !uncategorized.includes(msg)) uncategorized.push(msg);
      continue;
    }

    if (!categorized.has(category.title)) {
      categorized.set(category.title, []);
    }

    const scopePrefix = parsed.scope ? `**${parsed.scope}**: ` : '';
    const entry = `${scopePrefix}${parsed.description}`;
    if (!categorized.get(category.title).includes(entry)) {
      categorized.get(category.title).push(entry);
    }
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
