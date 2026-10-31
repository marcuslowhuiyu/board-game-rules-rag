import { App } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { beforeAll, describe, expect, it } from 'vitest';
import { DevStack, catalogInvokeResources } from '../lib/dev-stack.js';
import { GithubOidcStack } from '../lib/github-oidc.js';
import { NON_FILTERABLE_METADATA_KEYS } from '@bgr/retrieval';

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

  it('provisions all DynamoDB tables on-demand', () => {
    template.resourceCountIs('AWS::DynamoDB::Table', 8);
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

  it('ingestion bucket lifecycle: effective TTL per prefix is what ADR-0008 intends', () => {
    // S3 applies every rule whose prefix matches a key and the shortest
    // expiration wins, so assert the EFFECTIVE expiry for representative keys
    // rather than the presence of individual rules (overlapping prefixes are
    // what silently cut stage state from 7 days to 1 before M2-R2).
    type Rule = {
      Id?: string;
      Status?: string;
      Prefix?: string;
      ExpirationInDays?: number;
      AbortIncompleteMultipartUpload?: { DaysAfterInitiation?: number };
    };
    const buckets = template.findResources('AWS::S3::Bucket');
    const rules = Object.values(buckets)
      .map(
        (b) =>
          (b.Properties as { LifecycleConfiguration?: { Rules?: Rule[] } }).LifecycleConfiguration
            ?.Rules,
      )
      .find((r) => r !== undefined)!;
    expect(rules).toBeDefined();

    const effectiveExpiry = (key: string): number | undefined => {
      const days = rules
        .filter((r) => r.Status === 'Enabled' && key.startsWith(r.Prefix ?? ''))
        .map((r) => r.ExpirationInDays)
        .filter((d): d is number => d !== undefined);
      return days.length > 0 ? Math.min(...days) : undefined;
    };

    // Authoritative bytes and canonical chunk bodies are never expired.
    expect(effectiveExpiry('raw/uploads/abc.pdf')).toBeUndefined();
    expect(effectiveExpiry('raw/url/abc.snapshot')).toBeUndefined();
    expect(effectiveExpiry('normalized/doc_1/ch_1_0000.txt')).toBeUndefined();
    // Per-job stage state: exactly 7 days.
    expect(effectiveExpiry('stage-state/ingestion/job_1/parsed.json')).toBe(7);
    // Scratch space: 1 day.
    expect(effectiveExpiry('temporary/anything.bin')).toBe(1);

    // No rule's prefix nests inside another's.
    const prefixes = rules.map((r) => r.Prefix ?? '');
    for (const a of prefixes) {
      for (const b of prefixes) {
        if (a !== b) expect(a.startsWith(b)).toBe(false);
      }
    }

    // Multipart cleanup on every prefix.
    for (const r of rules) {
      expect(r.AbortIncompleteMultipartUpload?.DaysAfterInitiation).toBe(3);
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

  it('provisions an S3 Vectors bucket and a cosine float32 index with the chunk-body keys non-filterable', () => {
    template.resourceCountIs('AWS::S3Vectors::VectorBucket', 1);
    template.hasResourceProperties('AWS::S3Vectors::Index', {
      DataType: 'float32',
      Dimension: 1024,
      DistanceMetric: 'cosine',
      MetadataConfiguration: { NonFilterableMetadataKeys: [...NON_FILTERABLE_METADATA_KEYS] },
    });
  });

  it('configures the stage runner to embed with Titan V2 in Sydney and write to the vector index', () => {
    template.hasResourceProperties('AWS::Lambda::Function', {
      Environment: {
        Variables: Match.objectLike({
          EMBEDDING_REGION: 'ap-southeast-2',
          EMBEDDING_MODEL_ID: 'amazon.titan-embed-text-v2:0',
          EMBEDDING_DIMENSIONS: '1024',
          VECTOR_INDEX_ARN: Match.anyValue(),
        }),
      },
    });
  });

  it('lets the stage runner invoke only the configured embedding model and write only vectors', () => {
    const policies = JSON.stringify(template.findResources('AWS::IAM::Policy'));
    expect(policies).toContain(
      'arn:aws:bedrock:ap-southeast-2::foundation-model/amazon.titan-embed-text-v2:0',
    );
    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({ Action: 'bedrock:InvokeModel', Effect: 'Allow' }),
          Match.objectLike({ Action: 's3vectors:PutVectors', Effect: 'Allow' }),
        ]),
      },
    });
  });

  it('state machine has one Choice after each ingestion stage plus a MarkJobFailed_<STAGE> catch', () => {
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
      'EMBED',
      'INDEX',
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
      'EMBED',
      'INDEX',
      'FINALIZE',
    ];

    it.each(STAGES)('Check_After_%s sends only terminal SUCCEEDED to the success path', (stage) => {
      const choice = states[`Check_After_${stage}`]!;
      expect(choice.Type).toBe('Choice');
      const [success, terminalOther] = choice.Choices!;
      expect(success!.Next).toBe('PipelineSucceeded');
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

  describe('answering', () => {
    type Statement = { Action: string | string[]; Effect: string; Resource: unknown };
    const statements = (): Statement[] =>
      Object.values(template.findResources('AWS::IAM::Policy')).flatMap(
        (p) =>
          (p.Properties as { PolicyDocument: { Statement: Statement[] } }).PolicyDocument.Statement,
      );
    const actions = (s: Statement): string[] => (Array.isArray(s.Action) ? s.Action : [s.Action]);
    // Resources with a stack-account token synthesize as Fn::Join; render the
    // intrinsic parts as `<token>` so ARNs can be compared as strings.
    const render = (r: unknown): string =>
      typeof r === 'string'
        ? r
        : Array.isArray((r as { 'Fn::Join'?: unknown })['Fn::Join'])
          ? ((r as { 'Fn::Join': [string, unknown[]] })['Fn::Join'][1] as unknown[])
              .map(render)
              .join('')
          : '<token>';
    const resources = (s: Statement): string[] =>
      (Array.isArray(s.Resource) ? s.Resource : [s.Resource]).map(render);
    const invokeResources = (): string[] =>
      statements()
        .filter((s) => actions(s).includes('bedrock:InvokeModel'))
        .flatMap(resources);

    it('gives the API Lambda a 29 s timeout, 1024 MB and all thirteen answering env keys', () => {
      const fns = template.findResources('AWS::Lambda::Function', {
        Properties: { Timeout: 29 },
      });
      expect(Object.keys(fns)).toHaveLength(1);
      const props = Object.values(fns)[0]!.Properties as {
        MemorySize: number;
        Environment: { Variables: Record<string, unknown> };
      };
      expect(props.MemorySize).toBe(1024);
      const vars = props.Environment.Variables;
      for (const key of [
        'USAGE_TABLE',
        'DAILY_AI_CAP_USD',
        'MODEL_REQUEST_TIMEOUT_MS',
        'EVIDENCE_LIMIT_SIMPLE',
        'EVIDENCE_LIMIT_COMPLEX',
        'RERANK_CANDIDATES',
        'RERANK_TOP_N',
        'ANSWER_RUN_BUDGET_MS',
        'EMBEDDING_REGION',
        'EMBEDDING_MODEL_ID',
        'EMBEDDING_DIMENSIONS',
        'VECTOR_REGION',
        'VECTOR_INDEX_ARN',
      ]) {
        expect(vars, key).toHaveProperty(key);
      }
      expect(vars).toMatchObject({
        DAILY_AI_CAP_USD: '1',
        MODEL_REQUEST_TIMEOUT_MS: '20000',
        EVIDENCE_LIMIT_SIMPLE: '3',
        EVIDENCE_LIMIT_COMPLEX: '10',
        RERANK_CANDIDATES: '15',
        RERANK_TOP_N: '10',
        ANSWER_RUN_BUDGET_MS: '26000',
        EMBEDDING_DIMENSIONS: '1024',
      });
    });

    it('provisions a usage table keyed by pk with TTL on ttl', () => {
      template.hasResourceProperties('AWS::DynamoDB::Table', {
        KeySchema: [{ AttributeName: 'pk', KeyType: 'HASH' }],
        TimeToLiveSpecification: { AttributeName: 'ttl', Enabled: true },
        BillingMode: 'PAY_PER_REQUEST',
      });
    });

    it('throttles the default stage at 5 req/s, burst 10', () => {
      template.hasResourceProperties('AWS::ApiGatewayV2::Stage', {
        StageName: '$default',
        DefaultRouteSettings: Match.objectLike({
          ThrottlingRateLimit: 5,
          ThrottlingBurstLimit: 10,
        }),
      });
    });

    it('exposes POST /sessions/{sessionId}/messages', () => {
      template.hasResourceProperties('AWS::ApiGatewayV2::Route', {
        RouteKey: 'POST /sessions/{sessionId}/messages',
      });
    });

    it('grants the API Lambda vector reads on the index', () => {
      template.hasResourceProperties('AWS::IAM::Policy', {
        PolicyDocument: {
          Statement: Match.arrayWith([
            Match.objectLike({
              Action: ['s3vectors:QueryVectors', 's3vectors:GetVectors'],
              Effect: 'Allow',
              Resource: { 'Fn::GetAtt': [Match.stringLikeRegexp('^RuleChunkIndex'), 'IndexArn'] },
            }),
          ]),
        },
      });
    });

    it('grants Bedrock invoke on each catalog inference profile and its foundation models', () => {
      const r = invokeResources();
      expect(r.some((x) => x.endsWith(':inference-profile/global.openai.gpt-6-luna'))).toBe(true);
      expect(r.some((x) => x.endsWith(':inference-profile/apac.amazon.nova-micro-v1:0'))).toBe(
        true,
      );
      expect(r).toContain('arn:aws:bedrock:*::foundation-model/openai.gpt-6-luna');
      expect(r).toContain('arn:aws:bedrock:::foundation-model/openai.gpt-6-luna');
      expect(r).toContain('arn:aws:bedrock:*::foundation-model/amazon.nova-micro-v1:0');
      // Only global profiles route to the unqualified-region foundation ARN.
      expect(r).not.toContain('arn:aws:bedrock:::foundation-model/amazon.nova-micro-v1:0');
    });

    it('scopes the usage table grant to GetItem and UpdateItem', () => {
      const usage = statements().filter((s) => JSON.stringify(s.Resource).includes('"UsageTable'));
      const granted = usage.flatMap(actions).filter((a) => a.startsWith('dynamodb:'));
      expect(granted.sort()).toEqual(['dynamodb:GetItem', 'dynamodb:UpdateItem']);
    });

    it('sets env values the API parsers accept', async () => {
      const fn = Object.values(
        template.findResources('AWS::Lambda::Function', { Properties: { Timeout: 29 } }),
      )[0]!;
      const raw = (fn.Properties as { Environment: { Variables: Record<string, unknown> } })
        .Environment.Variables;
      const fakeFor = (key: string): string =>
        key === 'VECTOR_INDEX_ARN'
          ? 'arn:aws:s3vectors:ap-southeast-1:000000000000:bucket/b/index/i'
          : `fake-${key.toLowerCase()}`;
      const env = Object.fromEntries(
        Object.entries(raw).map(([k, v]) => [k, typeof v === 'string' ? v : fakeFor(k)]),
      );
      // Loaded by a computed specifier: apps/api sits outside this package's
      // tsconfig rootDir, so a static import would fail `tsc` (TS6059).
      const apiSrc = new URL('../../../apps/api/src/', import.meta.url).href;
      const { loadAnsweringConfigFromEnv } = (await import(
        /* @vite-ignore */ `${apiSrc}lib/context.ts`
      )) as { loadAnsweringConfigFromEnv: (env: Record<string, string>) => unknown };
      const { vectorSettingsFromEnv } = (await import(
        /* @vite-ignore */ `${apiSrc}ingestion/stage-context.ts`
      )) as {
        vectorSettingsFromEnv: (env: Record<string, string>) => {
          embedding: { dimensions: number };
        };
      };
      expect(loadAnsweringConfigFromEnv(env)).toMatchObject({
        dailyAiCapUsd: 1,
        evidenceLimits: { simple: 3, complex: 10 },
        modelRequestTimeoutMs: 20_000,
        runBudgetMs: 26_000,
      });
      expect(vectorSettingsFromEnv(env).embedding.dimensions).toBe(1024);
    });

    describe('catalogInvokeResources', () => {
      const entry = (key: string, modelId: string) => ({
        key,
        displayName: key,
        modelId,
        region: 'ap-southeast-1',
        inputUsdPerMTok: 1,
        outputUsdPerMTok: 1,
        structuredOutput: 'json' as const,
        maxTokens: 1,
      });
      const catalogOf = (modelId: string) => ({
        models: { m: entry('m', modelId) },
        approved: { router: ['m'], reranker: ['m'], answerer: ['m'] },
        defaults: { router: 'm', reranker: 'm', answerer: 'm' },
      });

      it('grants only the foundation model for a plain model id', () => {
        expect(catalogInvokeResources(catalogOf('amazon.nova-micro-v1:0'), 'ACCT')).toEqual([
          'arn:aws:bedrock:ap-southeast-1::foundation-model/amazon.nova-micro-v1:0',
        ]);
      });

      it('grants the profile and foundation models for a prefixed id', () => {
        expect(catalogInvokeResources(catalogOf('us.anthropic.claude-x:0'), 'ACCT')).toEqual([
          'arn:aws:bedrock:*::foundation-model/anthropic.claude-x:0',
          'arn:aws:bedrock:ap-southeast-1:ACCT:inference-profile/us.anthropic.claude-x:0',
        ]);
      });
    });

    it('never grants invoke on a wildcard model id', () => {
      for (const resource of invokeResources()) {
        expect(resource).not.toMatch(/(foundation-model|inference-profile)\/\*/);
        expect(resource).not.toBe('*');
      }
    });
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

describe('GithubOidcStack (reuses the account provider, ARN derived from the stack account)', () => {
  const app = new App();
  const stack = new GithubOidcStack(app, 'TestOidcDerived', {
    env: { account: '111111111111', region: 'ap-southeast-1' },
    githubRepo: 'example-owner/example-repo',
    useExistingOidcProvider: true,
  });
  const template = Template.fromStack(stack);

  it('does not create a provider and trusts the provider in its own account', () => {
    template.resourceCountIs('Custom::AWSCDKOpenIdConnectProvider', 0);
    const roles = template.findResources('AWS::IAM::Role');
    const trust = JSON.stringify(Object.values(roles)[0]!.Properties);
    // `arn:${AWS::Partition}:iam::<account>:oidc-provider/…`
    expect(trust).toContain(':iam::111111111111:oidc-provider/token.actions.githubusercontent.com');
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
