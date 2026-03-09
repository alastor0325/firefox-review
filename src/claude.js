'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

/**
 * Format the structured review prompt for a single patch.
 *
 * @param {string} bugId
 * @param {{ hash: string, message: string }} patch  - the specific patch being reviewed
 * @param {Array<{ hash: string, message: string }>} allPatches - all patches in the series
 * @param {Array<{ file: string, line: number, lineContent: string, text: string }>} comments
 * @returns {string}
 */
function formatPrompt(bugId, patch, allPatches, comments) {
  const patchNum = allPatches.findIndex((p) => p.hash === patch.hash) + 1;
  const totalPatches = allPatches.length;

  const seriesList = allPatches
    .map((p, i) => `- ${p.hash} ${p.message}${p.hash === patch.hash ? '  ← THIS PATCH' : ''}`)
    .join('\n');

  const feedbackItems = comments
    .map((c) => {
      return [
        `### ${c.file} : line ${c.line}`,
        `[YOUR CODE] : ${c.lineContent}`,
        `[FEEDBACK]  : ${c.text}`,
      ].join('\n');
    })
    .join('\n\n');

  return `You are being asked to revise Part ${patchNum} of ${totalPatches} of your implementation of ${bugId}.

## Patch under review (Part ${patchNum}):
- ${patch.hash} ${patch.message}

## Full patch series for context:
${seriesList}

## Reviewer feedback:

${feedbackItems}

## Instructions:
Address each FEEDBACK item above. This feedback is for Part ${patchNum} only — modify only files changed in that commit unless a fix strictly requires touching other code. After making changes, summarize what you changed for each feedback item.
`;
}

/**
 * Write REVIEW_FEEDBACK_<hash>.md to the worktree and return the command to run.
 *
 * @param {string} worktreePath
 * @param {string} bugId
 * @param {{ hash: string, message: string }} patch
 * @param {Array} allPatches
 * @param {Array} comments
 * @returns {{ feedbackPath: string, command: string }}
 */
function submitReview(worktreePath, bugId, patch, allPatches, comments) {
  const prompt = formatPrompt(bugId, patch, allPatches, comments);
  const filename = `REVIEW_FEEDBACK_${patch.hash}.md`;
  const feedbackPath = path.join(worktreePath, filename);
  fs.writeFileSync(feedbackPath, prompt, 'utf8');

  let command;
  if (os.platform() === 'win32') {
    command = `cd /d "${worktreePath}" && powershell -Command "Get-Content '${filename}' -Raw | claude --print -"`;
  } else {
    command = `cd "${worktreePath}" && claude --print "$(cat ${filename})"`;
  }

  return { feedbackPath, command };
}

module.exports = { formatPrompt, submitReview };
