#!/usr/bin/env node
'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');
const { startServer } = require('../src/server');
const { discoverWorktrees } = require('../src/git');

const mainRepoPath = path.join(os.homedir(), 'firefox');

let bugId = process.argv[2];

if (!bugId) {
  // Auto-detect from worktrees registered with ~/firefox
  if (!fs.existsSync(mainRepoPath)) {
    console.error(`Error: Main Firefox repo not found at ${mainRepoPath}`);
    console.error('Usage: firefox-review <bug-id>');
    process.exit(1);
  }

  let worktrees;
  try {
    worktrees = discoverWorktrees(mainRepoPath);
  } catch (err) {
    console.error(`Error reading worktrees: ${err.message}`);
    console.error('Usage: firefox-review <bug-id>');
    process.exit(1);
  }

  if (worktrees.length === 0) {
    console.error('No Firefox worktrees found.');
    console.error('Create a worktree first, or specify a bug ID:');
    console.error('  firefox-review <bug-id>');
    process.exit(1);
  }

  if (worktrees.length === 1) {
    bugId = worktrees[0].bugId;
    console.log(`Auto-detected worktree: ${worktrees[0].path}`);
  } else {
    console.error('Multiple worktrees found. Specify which one to review:\n');
    worktrees.forEach((wt) => {
      console.error(`  firefox-review ${wt.bugId.padEnd(20)} ${wt.path}`);
    });
    process.exit(1);
  }
}

const worktreePath = path.join(os.homedir(), `firefox-${bugId}`);

if (!fs.existsSync(worktreePath)) {
  console.error(`Error: Worktree not found at ${worktreePath}`);
  console.error('Make sure the Firefox worktree exists for this bug ID.');
  process.exit(1);
}

if (!fs.existsSync(mainRepoPath)) {
  console.error(`Warning: Main Firefox repo not found at ${mainRepoPath}`);
  console.error('Diff computation may fail without the base repo.');
}

startServer({ bugId, worktreePath, mainRepoPath });
