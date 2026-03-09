#!/usr/bin/env node
'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');
const { startServer } = require('../src/server');

const bugId = process.argv[2];

if (!bugId) {
  console.error('Usage: firefox-review <bug-id>');
  console.error('Example: firefox-review bugABC');
  process.exit(1);
}

const worktreePath = path.join(os.homedir(), `firefox-${bugId}`);

if (!fs.existsSync(worktreePath)) {
  console.error(`Error: Worktree not found at ${worktreePath}`);
  console.error('Make sure the Firefox worktree exists for this bug ID.');
  process.exit(1);
}

const mainRepoPath = path.join(os.homedir(), 'firefox');

if (!fs.existsSync(mainRepoPath)) {
  console.error(`Warning: Main Firefox repo not found at ${mainRepoPath}`);
  console.error('Diff computation may fail without the base repo.');
}

startServer({ bugId, worktreePath, mainRepoPath });
