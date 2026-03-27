#!/usr/bin/env node
// Generates a markdown changelog from conventional commits between two git tags.
// Usage: node scripts/generate-changelog.mjs [tag]
// If tag is omitted, uses the latest tag. Finds the previous tag automatically.
// Outputs markdown to stdout.

import { execSync } from 'child_process';
import { generateChangelog } from './lib/changelog.mjs';

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
