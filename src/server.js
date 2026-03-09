'use strict';

const express = require('express');
const path = require('path');
const net = require('net');
const { execSync } = require('child_process');
const { getCommits, getDiff } = require('./git');
const { submitReview } = require('./claude');

/**
 * Find an available port starting from the preferred port.
 */
function findAvailablePort(preferred) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.listen(preferred, () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
    server.on('error', () => {
      // Port in use, try next
      resolve(findAvailablePort(preferred + 1));
    });
  });
}

/**
 * Start the review web server.
 */
async function startServer({ bugId, worktreePath, mainRepoPath }) {
  const app = express();
  app.use(express.json());
  app.use(express.static(path.join(__dirname, '..', 'public')));

  // Cache diff and commits so we only compute once
  let diffCache = null;
  let commitsCache = null;

  function loadData() {
    if (diffCache && commitsCache) return;
    console.log('Computing git diff...');
    try {
      commitsCache = getCommits(worktreePath, mainRepoPath);
      diffCache = getDiff(worktreePath, mainRepoPath);
      console.log(
        `Found ${commitsCache.length} commit(s), ${diffCache.length} changed file(s).`
      );
    } catch (err) {
      console.error('Error computing diff:', err.message);
      throw err;
    }
  }

  // GET /api/diff — return parsed diff and commits
  app.get('/api/diff', (req, res) => {
    try {
      loadData();
      res.json({
        bugId,
        worktreePath,
        commits: commitsCache,
        files: diffCache,
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // POST /api/submit — write REVIEW_FEEDBACK.md and return the claude command
  app.post('/api/submit', (req, res) => {
    const { comments } = req.body;

    if (!comments || !Array.isArray(comments) || comments.length === 0) {
      return res.status(400).json({ error: 'No comments provided.' });
    }

    try {
      loadData();
      const { feedbackPath, command } = submitReview(
        worktreePath,
        bugId,
        commitsCache,
        comments
      );
      res.json({ ok: true, feedbackPath, command });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  const preferredPort = 7777;
  const port = await findAvailablePort(preferredPort);

  app.listen(port, '127.0.0.1', () => {
    const url = `http://localhost:${port}`;
    console.log(`\nfirefox-review server running at ${url}`);
    console.log(`Reviewing bug ${bugId} — worktree: ${worktreePath}\n`);

    // Open browser on macOS
    try {
      execSync(`open "${url}"`);
    } catch {
      console.log(`Open your browser at: ${url}`);
    }
  });
}

module.exports = { startServer };
