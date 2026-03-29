'use strict';

const { execSync } = require('child_process');

function git(cwd, cmd) {
  return execSync(`git ${cmd}`, { cwd, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
}

module.exports = { git };
