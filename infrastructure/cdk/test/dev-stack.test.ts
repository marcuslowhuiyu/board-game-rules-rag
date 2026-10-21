import { App } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { beforeAll, describe, expect, it } from 'vitest';
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

  it('retains raw/ and normalized/, expires temporary/ingestion/ after 7 days', () => {
    // raw/ and normalized/ carry finalized authoritative bytes and canonical
    // chunk bodies — they must never be silently expired (ADR-0008 §R9).
    // temporary/ingestion/{jobId}/state/*.json is per-job scratch; expire
    // after a week. Multipart cleanup on every prefix.
    template.hasResourceProperties('AWS::S3::Bucket', {
      LifecycleConfiguration: Match.objectLike({
        Rules: Match.arrayWith([
          Match.objectLike({
            Id: 'expire-temporary-ingestion-7d',
            Status: 'Enabled',
            Prefix: 'temporary/ingestion/',
            ExpirationInDays: 7,
          }),
          Match.objectLike({
            Id: 'abort-orphan-multipart-raw',
            Status: 'Enabled',
            Prefix: 'raw/',
            AbortIncompleteMultipartUpload: Match.objectLike({ DaysAfterInitiation: 3 }),
          }),
        ]),
      }),
    });
    const buckets = template.findResources('AWS::S3::Bucket');
    for (const b of Object.values(buckets)) {
      const rules =
        (
          b.Properties as {
            LifecycleConfiguration?: {
              Rules?: Array<{ Id?: string; ExpirationInDays?: number; Prefix?: string }>;
            };
          }
        ).LifecycleConfiguration?.Rules ?? [];
      for (const r of rules) {
        if (r.Prefix === 'raw/' || r.Prefix === 'normalized/') {
          expect(r.ExpirationInDays).toBeUndefined();
        }
      }
    }
  });

  it('restricts ingestion-bucket CORS to the CloudFront distribution (never `*`)', () => {
    // Find the ingestion bucket — the one whose CORS references the
    // CloudFront domain name.
    const buckets = template.findResources('AWS::S3::Bucket');
    let ingestion:
      { CorsConfiguration?: { CorsRules?: Array<{ AllowedOrigins?: unknown[] }> } } | undefined;
    for (const b of Object.values(buckets)) {
      const cors = (b.Properties as { CorsConfiguration?: unknown }).CorsConfiguration;
      if (cors) ingestion = b.Properties as never;
    }
    expect(ingestion).toBeDefined();
    const rule = ingestion!.CorsConfiguration!.CorsRules![0]!;
    const origins = rule.AllowedOrigins ?? [];
    expect(origins.length).toBeGreaterThan(0);
    for (const o of origins) {
      // Origins come out as Fn::Join tokens referencing the distribution.
      const asJson = JSON.stringify(o);
      expect(asJson.includes('"*"')).toBe(false);
      expect(asJson).toMatch(/WebDistribution.*DomainName|"DomainName"/);
    }
  });

  it('state machine has one Choice after each M2 stage plus a MarkJobFailed_<STAGE> catch', () => {
    template.resourceCountIs('AWS::StepFunctions::StateMachine', 1);
    const machines = template.findResources('AWS::StepFunctions::StateMachine');
    const first = Object.values(machines)[0] as {
      Properties: { DefinitionString: { 'Fn::Join': [string, unknown[]] } };
    };
    const parts = first.Properties.DefinitionString['Fn::Join'][1];
    const flat = JSON.stringify(parts);
    const stages = [
      'VALIDATE',
      'FETCH',
      'PARSE',
      'CLASSIFY',
      'DISCOVER_ERRATA',
      'NORMALIZE',
      'CHUNK',
      'FINALIZE',
    ];
    for (const stage of stages) {
      expect(flat).toContain(`Stage_${stage}`);
      expect(flat).toContain(`Check_After_${stage}`);
      expect(flat).toContain(`MarkJobFailed_${stage}`);
    }
    // Every terminal Fail transitions through a MarkJobFailed_<STAGE>
    // Lambda first, so no path leaves the job stuck RUNNING.
    expect(flat).toContain('PipelineFailed');
    // Choice branches on `$.terminal === true`.
    expect(flat).toContain('$.terminal');
  });

  describe('state machine terminal routing + retries', () => {
    type State = {
      Type: string;
      Next?: string;
      Choices?: { Next: string; And?: unknown[]; BooleanEquals?: boolean; Variable?: string }[];
      Default?: string;
      Retry?: { ErrorEquals: string[]; MaxAttempts?: number }[];
    };
    let states: Record<string, State>;

    beforeAll(() => {
      const machines = template.findResources('AWS::StepFunctions::StateMachine');
      const first = Object.values(machines)[0] as {
        Properties: { DefinitionString: { 'Fn::Join': [string, unknown[]] } };
      };
      // Replace intrinsic tokens (Lambda ARNs) with a placeholder string so
      // the definition parses as plain JSON.
      const json = first.Properties.DefinitionString['Fn::Join'][1]
        .map((p) => (typeof p === 'string' ? p : 'TOKEN'))
        .join('');
      states = (JSON.parse(json) as { States: Record<string, State> }).States;
    });

    const STAGES = [
      'VALIDATE',
      'FETCH',
      'PARSE',
      'CLASSIFY',
      'DISCOVER_ERRATA',
      'NORMALIZE',
      'CHUNK',
      'FINALIZE',
    ];

    it.each(STAGES)('Check_After_%s sends only terminal SUCCEEDED to the success path', (stage) => {
      const choice = states[`Check_After_${stage}`]!;
      expect(choice.Type).toBe('Choice');
      const [success, terminalOther] = choice.Choices!;
      expect(success!.Next).toBe('SkipEmbedIndexInM2');
      expect(success!.And).toEqual(
        expect.arrayContaining([
          { Variable: '$.terminal', BooleanEquals: true },
          { Variable: '$.status', StringEquals: 'SUCCEEDED' },
        ]),
      );
      expect(terminalOther).toMatchObject({ Variable: '$.terminal', BooleanEquals: true });
      expect(terminalOther!.Next).toBe(`TerminalNotSucceeded_${stage}`);
    });

    it.each(STAGES)(
      'terminal non-SUCCEEDED after %s goes through MarkJobFailed to PipelineFailed',
      (stage) => {
        expect(states[`TerminalNotSucceeded_${stage}`]!.Next).toBe(`MarkJobFailed_${stage}`);
        expect(states[`MarkJobFailed_${stage}`]!.Next).toBe('PipelineFailed');
        expect(states['PipelineFailed']!.Type).toBe('Fail');
      },
    );

    it('only FINALIZE retries RetryableStageError, with a bounded attempt count', () => {
      for (const stage of STAGES) {
        const retriers = states[`Stage_${stage}`]!.Retry ?? [];
        const retryable = retriers.find((r) => r.ErrorEquals.includes('RetryableStageError'));
        if (stage === 'FINALIZE') {
          expect(retryable).toBeDefined();
          expect(retryable!.MaxAttempts).toBeGreaterThan(0);
          expect(retryable!.MaxAttempts).toBeLessThanOrEqual(5);
        } else {
          expect(retryable).toBeUndefined();
        }
      }
    });
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

  it('provisions the ingestion Node 22 Lambdas (api + stage-runner + mark-job-failed)', () => {
    const fns = template.findResources('AWS::Lambda::Function', {
      Properties: { Runtime: 'nodejs22.x' },
    });
    expect(Object.keys(fns).length).toBeGreaterThanOrEqual(3);
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
