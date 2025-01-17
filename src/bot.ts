import { Context, Probot } from 'probot';
import { fetch } from 'cross-fetch';
import * as Sentry from '@sentry/node';
import { generateComment, generateIssueComment, parseComment, CommentParseResult } from './utils';
import { sendBotMentionedMessage } from './slack';

/* @probot/pino automatically picks up SENTRY_DSN from .env */
Sentry.init({
  environment: process.env.NODE_ENV,
  /* Do not send errors to sentry if app is in development mode */
  enabled: process.env.NODE_ENV !== 'development',
  tracesSampleRate: 1.0,
  attachStacktrace: true,
  maxValueLength: 500,
});

export default (app: Probot) => {
  app.on('pull_request.closed', async (context: Context<'pull_request.closed'>) => {
    // Don't handle closed but not merged PRs
    if (!context.payload.pull_request.merged) {
      return;
    }

    const repo = context.payload.repository.name;
    const owner = context.payload.repository.owner.login;
    const pullRequestNumber = context.payload.number;
    const senderId = context.payload.pull_request.user.id;

    context.log.info(
      `Handling newly merged PR: https://github.com/${owner}/${repo}/${pullRequestNumber}`,
    );

    // Skip claims creation API request if the creator of the PR is a bot
    if (context.payload.pull_request.user.type === 'Bot') {
      context.log.info(
        `Skipping creating claims for PR made by bot "${context.payload.pull_request.user.login}"`,
      );
      return;
    }
    // Check if owner is valid
    if (!owner) {
      Sentry.setExtra(
        'pull_request',
        `repo: ${repo} owner: ${owner} pullRequestNumber: ${pullRequestNumber} senderId: ${senderId}`,
      );
      context.log.error(`Owner of '${repo}' repository is empty`);
      return;
    }

    const octokit = await app.auth(); // Not passing an id returns a JWT-authenticated client
    const jwt = (await octokit.auth({ type: 'app' })) as { token: string };

    const body = JSON.stringify({
      pullRequest: {
        organization: owner,
        repo,
        pullRequestNumber: pullRequestNumber,
        contributorGithubIds: [senderId],
        wasEarnedByMention: false,
      },
    });

    context.log.info(
      `Attempting to create new claims via /claims/gitpoap-bot/create for ${owner}/${repo}/pulls/${pullRequestNumber} with the following body: ${body}.`,
    );

    const res = await fetch(`${process.env.API_URL}/claims/gitpoap-bot/create`, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        Authorization: `Bearer ${jwt.token}`,
      },
      body,
    });

    if (res.status !== 200) {
      if (res.status === 404) {
        context.log.warn(
          `An issue occurred when attempting to create new claims - (response code: ${
            res.status
          }): ${await res.text()} - ${body}`,
        );
      } else {
        Sentry.setExtra('body', body);
        context.log.error(
          `An issue occurred when attempting to create new claims - (response code: ${
            res.status
          }): ${await res.text()} - ${body}`,
        );
      }
      return;
    }

    const response = await res.json();

    if (response.newClaims.length === 0) {
      context.log.info('No new claims were created by this PR');
      return;
    }

    context.log.info(`${response.newClaims.length} new Claims were created by this PR`);

    const issueComment = context.issue({
      body: generateComment(response.newClaims),
    });

    const result = await context.octokit.issues.createComment(issueComment);

    context.log.info(`Posted comment about new claims: ${result.data.html_url}`);
  });

  app.on('issue_comment.created', async (context: Context<'issue_comment.created'>) => {
    const repo = context.payload.repository.name;
    const owner = context.payload.repository.owner.login;
    const sender = context.payload.sender.login;
    const comment = context.payload.comment.body;
    const issueNumber = context.payload.issue.number;
    const htmlURL = context.payload.issue.html_url;
    const isPR = htmlURL?.includes(`/pull/${issueNumber}`);

    // parse comment
    const parseResult: CommentParseResult = await parseComment(comment, context);
    // Check if comment tagged gitpoap-bot
    if (!parseResult.isBotMentioned) {
      context.log.info(`Sender didn't tag @gitpoap-bot explicitly in this comment`);
      return;
    }
    // Check if owner is valid
    if (!owner) {
      Sentry.setExtra(
        'issue_comment',
        `repo: ${repo} owner: ${owner} sender: ${sender} comment: ${comment} issueNumber: ${issueNumber} link: ${htmlURL}`,
      );
      context.log.error(`Owner of '${repo}' repository is empty`);
      return;
    }

    // Fetch permission to check if commenter has appropriate permissions to use @gitpoap-bot
    const permissionRes = await context.octokit.rest.repos.getCollaboratorPermissionLevel({
      owner,
      repo,
      username: sender,
    });
    const permissions = permissionRes.data.user?.permissions;

    // Check if commenter has admin, maintain or push permissions
    if (!permissions || (!permissions.admin && !permissions.push && !permissions.maintain)) {
      context.log.info(`Sender doesn't have admin, maintain or push permission`);
      return;
    }

    // Check if there are valid tagged users
    const contributorGithubIds = parseResult.contributorIds;
    if (contributorGithubIds.length === 0) {
      context.log.info(`Sender didn't tag any users`);
      return;
    }

    // Create claims for these contributors via API endpoint
    const octokit = await app.auth(); // Not passing an id returns a JWT-authenticated client
    const jwt = (await octokit.auth({ type: 'app' })) as { token: string };

    const body = JSON.stringify(
      isPR
        ? {
            pullRequest: {
              organization: owner,
              repo,
              pullRequestNumber: issueNumber,
              contributorGithubIds,
              wasEarnedByMention: true,
            },
          }
        : {
            issue: {
              organization: owner,
              repo,
              issueNumber,
              contributorGithubIds,
              wasEarnedByMention: true,
            },
          },
    );

    context.log.info(
      `Attempting to create new claims via /claims/gitpoap-bot/create for ${owner}/${repo} with the following body: ${body}.`,
    );

    const res = await fetch(`${process.env.API_URL}/claims/gitpoap-bot/create`, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        Authorization: `Bearer ${jwt.token}`,
      },
      body,
    });

    if (res.status !== 200) {
      Sentry.setExtra('body', body);
      context.log.error(
        `An issue occurred when attempting to create new claims (response code: ${
          res.status
        }): ${await res.text()} - ${body}`,
      );
      return;
    }

    // Create a comment to show info about gitpoap
    const response = await res.json();

    if (response.newClaims.length === 0) {
      context.log.info(
        'No new claims were created through the tagging of @gitpoap-bot in this comment.',
      );
      return;
    }

    context.log.info(
      `${response.newClaims.length} new claims were created through the tagging of @gitpoap-bot in this comment.`,
    );

    // Send slack notification
    sendBotMentionedMessage(comment, sender, htmlURL, repo);

    const issueComment = context.issue({
      body: generateIssueComment(response.newClaims),
    });

    const result = await context.octokit.issues.createComment(issueComment);

    context.log.info(
      `@gitpoap-bot posted a comment about the new claims here: ${result.data.html_url}`,
    );
  });
};
