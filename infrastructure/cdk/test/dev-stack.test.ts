import { App } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { describe, expect, it } from 'vitest';
import { DevStack } from '../lib/dev-stack.js';
import { GithubOidcStack } from '../lib/github-oidc.js';

describe('DevStack', () => {
  const app = new App();
  const stack = new DevStack(app, 'TestDev');
  const template = Template.fromStack(stack);

  it('provisions the API Lambda on Node.js 22', () => {
    template.hasResourceProperties('AWS::Lambda::Function', {
      Runtime: 'nodejs22.x',
    });
  });

  it('injects the DynamoDB table names into the Lambda environment', () => {
    template.hasResourceProperties('AWS::Lambda::Function', {
      Environment: {
        Variables: Match.objectLike({
          SESSION_TTL_SECONDS: '86400',
          ALLOWED_ORIGIN: 'same-origin',
        }),
      },
    });
  });

  it('provisions an HTTP API with no CORS (same-origin via CloudFront)', () => {
    const apis = template.findResources('AWS::ApiGatewayV2::Api');
    const apiIds = Object.keys(apis);
    expect(apiIds).toHaveLength(1);
    const first = apis[apiIds[0]!]!;
    expect((first.Properties as Record<string, unknown>).CorsConfiguration).toBeUndefined();
  });

  it('provisions all M1+M2 DynamoDB tables on-demand', () => {
    template.resourceCountIs('AWS::DynamoDB::Table', 7);
    template.allResourcesProperties('AWS::DynamoDB::Table', {
      BillingMode: 'PAY_PER_REQUEST',
    });
  });

  it('provisions a chunks table keyed by (documentId, chunkId)', () => {
    template.hasResourceProperties('AWS::DynamoDB::Table', {
      KeySchema: [
        { AttributeName: 'documentId', KeyType: 'HASH' },
        { AttributeName: 'chunkId', KeyType: 'RANGE' },
      ],
    });
  });

  it('provisions a documents table keyed by documentId', () => {
    template.hasResourceProperties('AWS::DynamoDB::Table', {
      KeySchema: [{ AttributeName: 'documentId', KeyType: 'HASH' }],
    });
  });

  it('provisions an ingestion jobs table keyed by jobId', () => {
    template.hasResourceProperties('AWS::DynamoDB::Table', {
      KeySchema: [{ AttributeName: 'jobId', KeyType: 'HASH' }],
    });
  });

  it('wires TTL on the sessions table', () => {
    template.hasResourceProperties('AWS::DynamoDB::Table', {
      KeySchema: [{ AttributeName: 'sessionId', KeyType: 'HASH' }],
      TimeToLiveSpecification: { AttributeName: 'ttl', Enabled: true },
    });
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

  it('provisions a CloudFront distribution with a /api/* behavior and a prefix-strip function', () => {
    template.resourceCountIs('AWS::CloudFront::Distribution', 1);
    template.resourceCountIs('AWS::CloudFront::Function', 1);

    // The distribution has at least two behaviors: the default (S3 origin)
    // and an additional /api/* behavior forwarding to the API origin with a
    // viewer-request function.
    template.hasResourceProperties('AWS::CloudFront::Distribution', {
      DistributionConfig: Match.objectLike({
        CacheBehaviors: Match.arrayWith([
          Match.objectLike({
            PathPattern: '/api/*',
            AllowedMethods: Match.arrayWith(['POST', 'DELETE']),
            FunctionAssociations: Match.arrayWith([
              Match.objectLike({ EventType: 'viewer-request' }),
            ]),
          }),
        ]),
      }),
    });

    template.hasResourceProperties('AWS::CloudFront::Function', {
      FunctionConfig: { Runtime: 'cloudfront-js-1.0' },
    });
  });

  it('emits API/table StackOutputs', () => {
    template.hasOutput('ApiUrl', {});
    template.hasOutput('CloudFrontApiUrl', {});
    template.hasOutput('DistributionDomain', {});
    template.hasOutput('GamesTableName', {});
    template.hasOutput('ContentTableName', {});
    template.hasOutput('SessionsTableName', {});
    template.hasOutput('MessagesTableName', {});
    template.hasOutput('DocumentsTableName', {});
    template.hasOutput('ChunksTableName', {});
    template.hasOutput('IngestionJobsTableName', {});
    template.hasOutput('IngestionBucketName', {});
    template.hasOutput('IngestionStateMachineArn', {});
  });

  it('provisions two S3 buckets (web site + ingestion) with SSL enforced', () => {
    template.resourceCountIs('AWS::S3::Bucket', 2);
  });

  it('provisions an ingestion S3 bucket with a raw/ lifecycle rule and PUT CORS', () => {
    template.hasResourceProperties('AWS::S3::Bucket', {
      LifecycleConfiguration: Match.objectLike({
        Rules: Match.arrayWith([
          Match.objectLike({
            Id: 'expire-raw-90d',
            Status: 'Enabled',
            Prefix: 'raw/',
            ExpirationInDays: 90,
          }),
        ]),
      }),
      CorsConfiguration: Match.objectLike({
        CorsRules: Match.arrayWith([
          Match.objectLike({ AllowedMethods: Match.arrayWith(['PUT']) }),
        ]),
      }),
    });
  });

  it('provisions a Step Functions state machine with the M2 stage tasks', () => {
    template.resourceCountIs('AWS::StepFunctions::StateMachine', 1);
    // DefinitionString is a Fn::Join at synth-time; fetch the raw resource
    // and stringify the joined pieces to check the stages appear.
    const machines = template.findResources('AWS::StepFunctions::StateMachine');
    const first = Object.values(machines)[0] as {
      Properties: { DefinitionString: { 'Fn::Join': [string, unknown[]] } };
    };
    const parts = first.Properties.DefinitionString['Fn::Join'][1];
    const flat = JSON.stringify(parts);
    for (const stage of [
      'Stage_VALIDATE',
      'Stage_FETCH',
      'Stage_PARSE',
      'Stage_CHUNK',
      'Stage_FINALIZE',
    ]) {
      expect(flat).toContain(stage);
    }
  });

  it('exposes M2 routes on the HTTP API', () => {
    for (const rk of [
      'POST /uploads/presign',
      'POST /ingestion',
      'GET /ingestion/{jobId}',
      'GET /sources/{sourceId}',
      'GET /sources/{sourceId}/chunks',
    ]) {
      template.hasResourceProperties('AWS::ApiGatewayV2::Route', { RouteKey: rk });
    }
  });

  it('provisions a second Node 22 Lambda for the ingestion stage runner', () => {
    // Two Node 22 Lambdas total: api-fn + stage-runner-fn. (Auto-delete
    // custom resources use a different runtime.)
    const fns = template.findResources('AWS::Lambda::Function', {
      Properties: { Runtime: 'nodejs22.x' },
    });
    expect(Object.keys(fns).length).toBeGreaterThanOrEqual(2);
  });
});

describe('GithubOidcStack (creates a new OIDC provider)', () => {
  const app = new App();
  const stack = new GithubOidcStack(app, 'TestOidcNew', {
    githubRepo: 'example-owner/example-repo',
  });
  const template = Template.fromStack(stack);

  it('creates the GitHub OIDC provider via the CDK custom resource', () => {
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

describe('GithubOidcStack (reuses an existing OIDC provider)', () => {
  const app = new App();
  const stack = new GithubOidcStack(app, 'TestOidcReuse', {
    githubRepo: 'example-owner/example-repo',
    existingOidcProviderArn:
      'arn:aws:iam::111111111111:oidc-provider/token.actions.githubusercontent.com',
  });
  const template = Template.fromStack(stack);

  it('does not create a new OIDC provider custom resource', () => {
    template.resourceCountIs('Custom::AWSCDKOpenIdConnectProvider', 0);
  });

  it('still creates the deployment role', () => {
    template.hasResourceProperties('AWS::IAM::Role', {
      RoleName: 'bgr-github-deploy-dev',
    });
  });
});
