#!/usr/bin/env node
'use strict';

const path = require('path');
const fs = require('fs');
const { startServer } = require('../src/server');

const bugId = process.argv[2];

if (!bugId) {
  console.error('Usage: firefox-review <bug-id>');
  console.error('Example: firefox-review 1874041');
  process.exit(1);
}

if (!/^\d+$/.test(bugId)) {
  console.error(`Error: bug-id must be a number, got: ${bugId}`);
  process.exit(1);
}

const worktreePath = path.join(process.env.HOME, `firefox-${bugId}`);

if (!fs.existsSync(worktreePath)) {
  console.error(`Error: Worktree not found at ${worktreePath}`);
  console.error('Make sure the Firefox worktree exists for this bug ID.');
  process.exit(1);
}

const mainRepoPath = path.join(process.env.HOME, 'firefox');

if (!fs.existsSync(mainRepoPath)) {
  console.error(`Warning: Main Firefox repo not found at ${mainRepoPath}`);
  console.error('Diff computation may fail without the base repo.');
}

startServer({ bugId, worktreePath, mainRepoPath });
