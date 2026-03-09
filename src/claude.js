'use strict';

const fs = require('fs');
const path = require('path');

/**
 * Format the structured review prompt from comments.
 *
 * @param {string} bugId
 * @param {Array<{hash: string, message: string}>} commits
 * @param {Array<{file: string, line: number, lineContent: string, text: string}>} comments
 * @returns {string}
 */
function formatPrompt(bugId, commits, comments) {
  const commitList = commits.map((c) => `- ${c.hash} ${c.message}`).join('\n');

  const feedbackItems = comments
    .map((c) => {
      return [
        `### ${c.file} : line ${c.line}`,
        `[YOUR CODE] : ${c.lineContent}`,
        `[FEEDBACK]  : ${c.text}`,
      ].join('\n');
    })
    .join('\n\n');

  return `You are being asked to revise your implementation of Bug ${bugId}.

## Your commits under review:
${commitList}

## Reviewer feedback:

${feedbackItems}

## Instructions:
Address each FEEDBACK item above. Modify only the files and lines mentioned unless a fix strictly requires touching other code. After making changes, summarize what you changed for each feedback item.
`;
}

/**
 * Write REVIEW_FEEDBACK.md to the worktree and return the command to run.
 *
 * @param {string} worktreePath
 * @param {string} bugId
 * @param {Array} commits
 * @param {Array} comments
 * @returns {{ feedbackPath: string, command: string }}
 */
function submitReview(worktreePath, bugId, commits, comments) {
  const prompt = formatPrompt(bugId, commits, comments);
  const feedbackPath = path.join(worktreePath, 'REVIEW_FEEDBACK.md');
  fs.writeFileSync(feedbackPath, prompt, 'utf8');

  const command = `cd "${worktreePath}" && claude --print "$(cat REVIEW_FEEDBACK.md)"`;

  return { feedbackPath, command };
}

module.exports = { formatPrompt, submitReview };
