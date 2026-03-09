#!/usr/bin/env node
'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');
const readline = require('readline');
const { startServer } = require('../src/server');
const { discoverWorktrees } = require('../src/git');

const mainRepoPath = path.join(os.homedir(), 'firefox');

/**
 * Build the full list of reviewable entries:
 * the main repo first, then all registered worktrees.
 */
function buildEntries() {
  const entries = [];

  // Always include the main repo itself as an option
  if (fs.existsSync(mainRepoPath)) {
    entries.push({
      path: mainRepoPath,
      branch: null,
      worktreeName: path.basename(mainRepoPath),
      isMain: true,
    });
  }

  // Append all worktrees registered with the main repo
  if (fs.existsSync(mainRepoPath)) {
    try {
      entries.push(...discoverWorktrees(mainRepoPath));
    } catch {
      // Ignore if worktree list can't be read
    }
  }

  return entries;
}

/**
 * Show a numbered list and prompt the user to pick one.
 */
async function promptSelection(entries) {
  console.log('\nAvailable repos / worktrees:\n');
  entries.forEach((entry, i) => {
    const label = entry.isMain
      ? `${entry.worktreeName}  (main repo)`
      : `firefox-${entry.worktreeName}`;
    const branch = entry.branch ? `  (${entry.branch})` : '';
    console.log(`  ${i + 1}.  ${label}${branch}`);
  });
  console.log('');

  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(`Select [1-${entries.length}]: `, (answer) => {
      rl.close();
      const idx = parseInt(answer, 10) - 1;
      if (isNaN(idx) || idx < 0 || idx >= entries.length) {
        console.error(`Invalid selection: "${answer}"`);
        process.exit(1);
      }
      resolve(entries[idx]);
    });
  });
}

async function main() {
  const argName = process.argv[2];

  let worktreeName;
  let worktreePath;

  if (argName) {
    // Explicit name given — reconstruct path as ~/firefox-<name>
    worktreeName = argName;
    worktreePath = path.join(os.homedir(), `firefox-${worktreeName}`);
  } else {
    // No arg — show picker with main repo + all worktrees
    const entries = buildEntries();

    if (entries.length === 0) {
      console.error('No Firefox repos or worktrees found under ~/firefox.');
      console.error('Usage: firefox-review <worktree-name>');
      process.exit(1);
    }

    const selected = await promptSelection(entries);
    worktreeName = selected.worktreeName;
    worktreePath = selected.path;
    console.log('');
  }

  if (!fs.existsSync(worktreePath)) {
    console.error(`Error: Worktree not found at ${worktreePath}`);
    process.exit(1);
  }

  if (!fs.existsSync(mainRepoPath)) {
    console.error(`Warning: Main Firefox repo not found at ${mainRepoPath}`);
    console.error('Diff computation may fail without the base repo.');
  }

  startServer({ worktreeName, worktreePath, mainRepoPath });
}

main();
