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
 * Show a numbered list of worktrees and prompt the user to pick one.
 * Returns the selected worktree object, or exits on invalid input.
 */
async function promptSelection(worktrees) {
  console.log('\nAvailable worktrees:\n');
  worktrees.forEach((wt, i) => {
    const branch = wt.branch ? `  (${wt.branch})` : '';
    console.log(`  ${i + 1}.  firefox-${wt.worktreeName}${branch}`);
  });
  console.log('');

  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(`Select a worktree [1-${worktrees.length}]: `, (answer) => {
      rl.close();
      const idx = parseInt(answer, 10) - 1;
      if (isNaN(idx) || idx < 0 || idx >= worktrees.length) {
        console.error(`Invalid selection: "${answer}"`);
        process.exit(1);
      }
      resolve(worktrees[idx]);
    });
  });
}

async function main() {
  let worktreeName = process.argv[2];

  if (!worktreeName) {
    if (!fs.existsSync(mainRepoPath)) {
      console.error(`Error: Main Firefox repo not found at ${mainRepoPath}`);
      console.error('Usage: firefox-review <worktree-name>');
      process.exit(1);
    }

    let worktrees;
    try {
      worktrees = discoverWorktrees(mainRepoPath);
    } catch (err) {
      console.error(`Error reading worktrees: ${err.message}`);
      process.exit(1);
    }

    if (worktrees.length === 0) {
      console.error('No Firefox worktrees found.');
      console.error('Create one first, or specify the name directly:');
      console.error('  firefox-review <worktree-name>');
      process.exit(1);
    }

    const selected = await promptSelection(worktrees);
    worktreeName = selected.worktreeName;
    console.log('');
  }

  const worktreePath = path.join(os.homedir(), `firefox-${worktreeName}`);

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
