#!/usr/bin/env node
import { App } from 'aws-cdk-lib';
import { DevStack } from '../lib/dev-stack.js';
import { GithubOidcStack } from '../lib/github-oidc.js';

const app = new App();

const account = process.env.CDK_DEFAULT_ACCOUNT;
const region = process.env.CDK_DEFAULT_REGION ?? 'ap-southeast-1';

const rawRepo = (app.node.tryGetContext('githubRepo') as string | undefined) ?? '';
const githubRepo =
  rawRepo && rawRepo !== 'REPLACE_ME/board-game-rules-rag'
    ? rawRepo
    : (() => {
        console.warn(
          '[cdk] githubRepo context is not set; using placeholder. Real deploy requires -c githubRepo=owner/repo.',
        );
        return 'example-owner/example-repo';
      })();

new GithubOidcStack(app, 'BgrGithubOidcStack', {
  env: { account, region },
  githubRepo,
  environmentName: 'dev',
});

new DevStack(app, 'BgrDevStack', {
  env: { account, region },
});
