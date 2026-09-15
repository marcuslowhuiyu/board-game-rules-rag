import { App } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { describe, it } from 'vitest';
import { DevStack } from '../lib/dev-stack.js';
import { GithubOidcStack } from '../lib/github-oidc.js';

describe('DevStack', () => {
  const app = new App();
  const stack = new DevStack(app, 'TestDev');
  const template = Template.fromStack(stack);

  it('provisions the health Lambda on Node.js 22', () => {
    template.hasResourceProperties('AWS::Lambda::Function', {
      Runtime: 'nodejs22.x',
    });
  });

  it('provisions an HTTP API', () => {
    template.resourceCountIs('AWS::ApiGatewayV2::Api', 1);
  });

  it('provisions a private S3 site bucket with SSL enforced', () => {
    template.hasResourceProperties('AWS::S3::Bucket', {
      BucketEncryption: {
        ServerSideEncryptionConfiguration: [
          { ServerSideEncryptionByDefault: { SSEAlgorithm: 'AES256' } },
        ],
      },
      PublicAccessBlockConfiguration: {
        BlockPublicAcls: true,
        BlockPublicPolicy: true,
        IgnorePublicAcls: true,
        RestrictPublicBuckets: true,
      },
    });
  });

  it('provisions a CloudFront distribution', () => {
    template.resourceCountIs('AWS::CloudFront::Distribution', 1);
  });
});

describe('GithubOidcStack', () => {
  const app = new App();
  const stack = new GithubOidcStack(app, 'TestOidc', {
    githubRepo: 'example-owner/example-repo',
  });
  const template = Template.fromStack(stack);

  it('creates a GitHub OIDC provider (via the CDK custom resource)', () => {
    template.hasResourceProperties('Custom::AWSCDKOpenIdConnectProvider', {
      Url: 'https://token.actions.githubusercontent.com',
      ClientIDList: ['sts.amazonaws.com'],
    });
  });

  it('creates a deployment role restricted to the given repository', () => {
    template.hasResourceProperties('AWS::IAM::Role', {
      RoleName: 'bgr-github-deploy-dev',
    });
  });
});
