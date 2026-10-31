import { fileURLToPath } from 'node:url';
import * as path from 'node:path';
import { CfnOutput, Duration, RemovalPolicy, Stack, type StackProps } from 'aws-cdk-lib';
import { HttpApi, HttpMethod, type CfnStage } from 'aws-cdk-lib/aws-apigatewayv2';
import { HttpLambdaIntegration } from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import {
  AllowedMethods,
  CachePolicy,
  Distribution,
  Function as CfFunction,
  FunctionCode,
  FunctionEventType,
  OriginRequestPolicy,
  ViewerProtocolPolicy,
} from 'aws-cdk-lib/aws-cloudfront';
import { HttpOrigin, S3BucketOrigin } from 'aws-cdk-lib/aws-cloudfront-origins';
import { AttributeType, BillingMode, Table, TableEncryption } from 'aws-cdk-lib/aws-dynamodb';
import { Runtime } from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction, OutputFormat } from 'aws-cdk-lib/aws-lambda-nodejs';
import { PolicyStatement } from 'aws-cdk-lib/aws-iam';
import { LogGroup, RetentionDays } from 'aws-cdk-lib/aws-logs';
import type { CfnBucket } from 'aws-cdk-lib/aws-s3';
import { CfnIndex, CfnVectorBucket } from 'aws-cdk-lib/aws-s3vectors';
import {
  BlockPublicAccess,
  Bucket,
  BucketEncryption,
  type LifecycleRule,
} from 'aws-cdk-lib/aws-s3';
import {
  Chain,
  Choice,
  Condition,
  DefinitionBody,
  Fail,
  JsonPath,
  LogLevel,
  Pass,
  StateMachine,
  Succeed,
  TaskInput,
  type IChainable,
} from 'aws-cdk-lib/aws-stepfunctions';
import { LambdaInvoke } from 'aws-cdk-lib/aws-stepfunctions-tasks';
import { MODEL_ROLES, loadModelCatalog, type ModelCatalog } from '@bgr/ai';
import { NON_FILTERABLE_METADATA_KEYS } from '@bgr/retrieval';
import type { Construct } from 'constructs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Shared by every Lambda. The ESM output has no `require`, but bundled
// CommonJS dependencies (e.g. the HTML parser's iconv-lite → safer-buffer)
// call `require` for Node built-ins; without this banner the bundle throws
// `Dynamic require of "buffer" is not supported` on load.
//
// The AWS SDK is bundled (`externalModules: []`) rather than taken from the
// runtime: the runtime's copy may predate newer services (S3 Vectors), and
// bundling ships exactly the SDK versions the tests ran against.
const LAMBDA_BUNDLING = {
  format: OutputFormat.ESM,
  externalModules: [],
  target: 'node22',
  sourceMap: true,
  minify: false,
  banner:
    "import { createRequire as __bgrCreateRequire } from 'node:module'; const require = __bgrCreateRequire(import.meta.url);",
};

const INGESTION_STAGES = [
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
] as const;

/** Embedding model settings (ADR-0002). Titan V2 is not offered in ap-southeast-1. */
export interface EmbeddingConfig {
  region: string;
  modelId: string;
  dimensions: 256 | 512 | 1024;
}

const DEFAULT_EMBEDDING: EmbeddingConfig = {
  region: 'ap-southeast-2',
  modelId: 'amazon.titan-embed-text-v2:0',
  dimensions: 1024,
};

/** Answering settings (M4 step 3); they reach the API Lambda as env vars. */
export interface AnsweringConfig {
  /** Daily AI spend cap in USD (Singapore calendar day). */
  dailyAiCapUsd: number;
  /** API Gateway default-stage throttle. */
  throttle: { rateLimit: number; burstLimit: number };
  /** Per-model-call request timeout. */
  modelRequestTimeoutMs: number;
  /** Evidence kept after reranking, by question tier. */
  evidenceLimits: { simple: number; complex: number };
  /** Candidates retrieved before reranking. */
  rerankCandidates: number;
  /** Most passages the reranker may keep. */
  rerankTopN: number;
}

const DEFAULT_ANSWERING: AnsweringConfig = {
  dailyAiCapUsd: 1,
  throttle: { rateLimit: 5, burstLimit: 10 },
  modelRequestTimeoutMs: 20_000,
  evidenceLimits: { simple: 3, complex: 10 },
  rerankCandidates: 15,
  rerankTopN: 10,
};

export interface DevStackProps extends StackProps {
  /** Session TTL in seconds. Defaults to 24h. */
  sessionTtlSeconds?: number;
  /** Upload size cap (bytes). Defaults to 50 MiB. */
  uploadMaxBytes?: number;
  /** Presigned URL expiry (seconds). Defaults to 10 minutes. */
  presignExpirySeconds?: number;
  /** Embedding model, region and dimension. Defaults to Titan V2, 1024, in Sydney. */
  embedding?: EmbeddingConfig;
  /** Answering settings. Defaults: $1/day cap, 5 req/s (burst 10), 3/10 evidence of 15 candidates. */
  answering?: Partial<AnsweringConfig>;
}

export class DevStack extends Stack {
  constructor(scope: Construct, id: string, props: DevStackProps = {}) {
    super(scope, id, props);

    const sessionTtlSeconds = props.sessionTtlSeconds ?? 60 * 60 * 24;
    const uploadMaxBytes = props.uploadMaxBytes ?? 50 * 1024 * 1024;
    const presignExpirySeconds = props.presignExpirySeconds ?? 600;
    const embedding = props.embedding ?? DEFAULT_EMBEDDING;
    const answering: AnsweringConfig = { ...DEFAULT_ANSWERING, ...props.answering };

    // ------ Application data (DynamoDB — see ADR-0006 / ADR-0008) --------
    const gamesTable = new Table(this, 'GamesTable', {
      partitionKey: { name: 'gameId', type: AttributeType.STRING },
      billingMode: BillingMode.PAY_PER_REQUEST,
      encryption: TableEncryption.AWS_MANAGED,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      removalPolicy: RemovalPolicy.DESTROY,
    });

    const contentTable = new Table(this, 'ContentTable', {
      partitionKey: { name: 'gameId', type: AttributeType.STRING },
      sortKey: { name: 'contentId', type: AttributeType.STRING },
      billingMode: BillingMode.PAY_PER_REQUEST,
      encryption: TableEncryption.AWS_MANAGED,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      removalPolicy: RemovalPolicy.DESTROY,
    });

    const sessionsTable = new Table(this, 'SessionsTable', {
      partitionKey: { name: 'sessionId', type: AttributeType.STRING },
      billingMode: BillingMode.PAY_PER_REQUEST,
      encryption: TableEncryption.AWS_MANAGED,
      timeToLiveAttribute: 'ttl',
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      removalPolicy: RemovalPolicy.DESTROY,
    });

    const messagesTable = new Table(this, 'MessagesTable', {
      partitionKey: { name: 'sessionId', type: AttributeType.STRING },
      sortKey: { name: 'index', type: AttributeType.NUMBER },
      billingMode: BillingMode.PAY_PER_REQUEST,
      encryption: TableEncryption.AWS_MANAGED,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      removalPolicy: RemovalPolicy.DESTROY,
    });

    const documentsTable = new Table(this, 'DocumentsTable', {
      partitionKey: { name: 'documentId', type: AttributeType.STRING },
      billingMode: BillingMode.PAY_PER_REQUEST,
      encryption: TableEncryption.AWS_MANAGED,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      removalPolicy: RemovalPolicy.DESTROY,
    });

    const chunksTable = new Table(this, 'ChunksTable', {
      partitionKey: { name: 'documentId', type: AttributeType.STRING },
      sortKey: { name: 'chunkId', type: AttributeType.STRING },
      billingMode: BillingMode.PAY_PER_REQUEST,
      encryption: TableEncryption.AWS_MANAGED,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      removalPolicy: RemovalPolicy.DESTROY,
    });

    const ingestionJobsTable = new Table(this, 'IngestionJobsTable', {
      partitionKey: { name: 'jobId', type: AttributeType.STRING },
      billingMode: BillingMode.PAY_PER_REQUEST,
      encryption: TableEncryption.AWS_MANAGED,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      removalPolicy: RemovalPolicy.DESTROY,
    });

    // Per-day spend rows (`pk` = Singapore day); they expire via `ttl`.
    const usageTable = new Table(this, 'UsageTable', {
      partitionKey: { name: 'pk', type: AttributeType.STRING },
      billingMode: BillingMode.PAY_PER_REQUEST,
      encryption: TableEncryption.AWS_MANAGED,
      timeToLiveAttribute: 'ttl',
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      removalPolicy: RemovalPolicy.DESTROY,
    });

    // ------ Ingestion S3 bucket (raw/ + normalized/ + stage-state/ + temporary/)
    // CORS is left unset here and applied after the CloudFront distribution
    // is constructed (bottom of the constructor) so `allowedOrigins` can pin
    // to the distribution's domain instead of `*`.
    const ingestionBucket = new Bucket(this, 'IngestionBucket', {
      blockPublicAccess: BlockPublicAccess.BLOCK_ALL,
      encryption: BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      versioned: false,
      removalPolicy: RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
      lifecycleRules: buildIngestionLifecycle(),
    });

    // ------ API Lambda + HTTP API ---------------------------------------
    const apiLogGroup = new LogGroup(this, 'ApiFnLogs', {
      retention: RetentionDays.ONE_WEEK,
      removalPolicy: RemovalPolicy.DESTROY,
    });

    const apiFn = new NodejsFunction(this, 'ApiFn', {
      runtime: Runtime.NODEJS_22_X,
      entry: path.resolve(__dirname, '../../../apps/api/src/handlers/api.ts'),
      handler: 'handler',
      memorySize: 1024,
      // API Gateway's HTTP integration limit is 30 s.
      timeout: Duration.seconds(29),
      logGroup: apiLogGroup,
      environment: baseApiEnvironment({
        gamesTable,
        contentTable,
        sessionsTable,
        messagesTable,
        documentsTable,
        chunksTable,
        ingestionJobsTable,
        ingestionBucket,
        sessionTtlSeconds,
        uploadMaxBytes,
        presignExpirySeconds,
      }),
      bundling: LAMBDA_BUNDLING,
    });

    // ------ Rule-chunk vectors (S3 Vectors — ADR-0002) ------------------
    const vectorBucket = new CfnVectorBucket(this, 'RuleVectorBucket');
    // A different model or dimension needs a new index, so both are in its name.
    const vectorIndexName = `rule-chunks-titan-v2-${embedding.dimensions}`;
    const vectorIndex = new CfnIndex(this, 'RuleChunkIndex', {
      vectorBucketArn: vectorBucket.attrVectorBucketArn,
      indexName: vectorIndexName,
      dataType: 'float32',
      dimension: embedding.dimensions,
      distanceMetric: 'cosine',
      metadataConfiguration: { nonFilterableMetadataKeys: [...NON_FILTERABLE_METADATA_KEYS] },
    });

    // ------ Ingestion stage-runner Lambda -------------------------------
    const stageRunnerLogGroup = new LogGroup(this, 'IngestionStageRunnerLogs', {
      retention: RetentionDays.ONE_WEEK,
      removalPolicy: RemovalPolicy.DESTROY,
    });

    const stageRunnerFn = new NodejsFunction(this, 'IngestionStageRunnerFn', {
      runtime: Runtime.NODEJS_22_X,
      entry: path.resolve(__dirname, '../../../apps/api/src/ingestion/stage-runner.ts'),
      handler: 'handler',
      memorySize: 1024,
      // EMBED makes one Bedrock call per chunk (bounded concurrency).
      timeout: Duration.seconds(120),
      logGroup: stageRunnerLogGroup,
      environment: {
        NODE_OPTIONS: '--enable-source-maps',
        GIT_COMMIT: process.env['GIT_COMMIT'] ?? 'unknown',
        GAMES_TABLE: gamesTable.tableName,
        CONTENT_TABLE: contentTable.tableName,
        DOCUMENTS_TABLE: documentsTable.tableName,
        CHUNKS_TABLE: chunksTable.tableName,
        INGESTION_JOBS_TABLE: ingestionJobsTable.tableName,
        INGESTION_BUCKET: ingestionBucket.bucketName,
        EMBEDDING_REGION: embedding.region,
        EMBEDDING_MODEL_ID: embedding.modelId,
        EMBEDDING_DIMENSIONS: String(embedding.dimensions),
        EMBEDDING_CONCURRENCY: '8',
        VECTOR_REGION: this.region,
        VECTOR_INDEX_ARN: vectorIndex.attrIndexArn,
      },
      bundling: LAMBDA_BUNDLING,
    });
    stageRunnerFn.node.addDependency(vectorIndex);

    // The API answers questions: Titan embeddings, vector reads, catalog models.
    apiFn.node.addDependency(vectorIndex);
    apiFn.addEnvironment('USAGE_TABLE', usageTable.tableName);
    apiFn.addEnvironment('DAILY_AI_CAP_USD', String(answering.dailyAiCapUsd));
    apiFn.addEnvironment('MODEL_REQUEST_TIMEOUT_MS', String(answering.modelRequestTimeoutMs));
    apiFn.addEnvironment('EVIDENCE_LIMIT_SIMPLE', String(answering.evidenceLimits.simple));
    apiFn.addEnvironment('EVIDENCE_LIMIT_COMPLEX', String(answering.evidenceLimits.complex));
    apiFn.addEnvironment('RERANK_CANDIDATES', String(answering.rerankCandidates));
    apiFn.addEnvironment('RERANK_TOP_N', String(answering.rerankTopN));
    apiFn.addEnvironment('EMBEDDING_REGION', embedding.region);
    apiFn.addEnvironment('EMBEDDING_MODEL_ID', embedding.modelId);
    apiFn.addEnvironment('EMBEDDING_DIMENSIONS', String(embedding.dimensions));
    apiFn.addEnvironment('VECTOR_REGION', this.region);
    apiFn.addEnvironment('VECTOR_INDEX_ARN', vectorIndex.attrIndexArn);

    // The spend ledger only reads (GetItem) and increments (UpdateItem) a day's row.
    usageTable.grant(apiFn, 'dynamodb:GetItem', 'dynamodb:UpdateItem');
    apiFn.addToRolePolicy(
      new PolicyStatement({
        actions: ['bedrock:InvokeModel'],
        resources: [`arn:aws:bedrock:${embedding.region}::foundation-model/${embedding.modelId}`],
      }),
    );
    apiFn.addToRolePolicy(
      new PolicyStatement({
        actions: ['s3vectors:QueryVectors', 's3vectors:GetVectors'],
        resources: [vectorIndex.attrIndexArn],
      }),
    );
    apiFn.addToRolePolicy(
      new PolicyStatement({
        actions: ['bedrock:InvokeModel'],
        resources: catalogInvokeResources(loadModelCatalog(), this.account),
      }),
    );

    stageRunnerFn.addToRolePolicy(
      new PolicyStatement({
        actions: ['bedrock:InvokeModel'],
        resources: [`arn:aws:bedrock:${embedding.region}::foundation-model/${embedding.modelId}`],
      }),
    );
    stageRunnerFn.addToRolePolicy(
      new PolicyStatement({
        actions: ['s3vectors:PutVectors'],
        resources: [vectorIndex.attrIndexArn],
      }),
    );

    gamesTable.grantReadWriteData(stageRunnerFn);
    contentTable.grantReadData(stageRunnerFn);
    documentsTable.grantReadWriteData(stageRunnerFn);
    chunksTable.grantReadWriteData(stageRunnerFn);
    ingestionJobsTable.grantReadWriteData(stageRunnerFn);
    ingestionBucket.grantReadWrite(stageRunnerFn);

    // ------ MarkJobFailed Lambda (state-machine safety net) --------------
    // Even when the stage-runner Lambda itself fails (Lambda.ServiceException,
    // SdkClientException, timeout, ...) the state machine's Catch path
    // invokes this Lambda so the ingestion job row is observably FAILED.
    // Every terminal Fail state in the state machine transitions through
    // this Lambda first.
    const markJobFailedLogGroup = new LogGroup(this, 'MarkJobFailedLogs', {
      retention: RetentionDays.ONE_WEEK,
      removalPolicy: RemovalPolicy.DESTROY,
    });
    const markJobFailedFn = new NodejsFunction(this, 'MarkJobFailedFn', {
      runtime: Runtime.NODEJS_22_X,
      entry: path.resolve(__dirname, '../../../apps/api/src/ingestion/mark-job-failed.ts'),
      handler: 'handler',
      memorySize: 256,
      timeout: Duration.seconds(15),
      logGroup: markJobFailedLogGroup,
      environment: {
        NODE_OPTIONS: '--enable-source-maps',
        INGESTION_JOBS_TABLE: ingestionJobsTable.tableName,
      },
      bundling: LAMBDA_BUNDLING,
    });
    ingestionJobsTable.grantReadWriteData(markJobFailedFn);

    // ------ Step Functions state machine --------------------------------
    const sfnLogGroup = new LogGroup(this, 'IngestionStateMachineLogs', {
      retention: RetentionDays.ONE_WEEK,
      removalPolicy: RemovalPolicy.DESTROY,
    });

    // Single terminal Fail state at the bottom — every MarkJobFailed_<STAGE>
    // Task transitions here on success.
    const failState = new Fail(this, 'PipelineFailed', {
      comment:
        'Terminal failure state. MarkJobFailed_<STAGE> writes FAILED to the ingestion job before this state ends the execution.',
      cause: 'See the ingestion job row for `error.stage`, `error.message`, `error.code`.',
      error: 'IngestionStageFailed',
    });

    const succeed = new Succeed(this, 'PipelineSucceeded');

    // Build stage entry-points in reverse so each stage can wire its Choice
    // "continue" branch to the next stage's entry.
    const stageEntries = new Map<(typeof INGESTION_STAGES)[number], IChainable>();
    for (let i = INGESTION_STAGES.length - 1; i >= 0; i--) {
      const stage = INGESTION_STAGES[i]!;
      const nextEntry: IChainable =
        i === INGESTION_STAGES.length - 1 ? succeed : stageEntries.get(INGESTION_STAGES[i + 1]!)!;

      const markFailedTask = new LambdaInvoke(this, `MarkJobFailed_${stage}`, {
        lambdaFunction: markJobFailedFn,
        payloadResponseOnly: true,
        payload: TaskInput.fromObject({
          jobId: JsonPath.stringAt('$.jobId'),
          stage,
          cause: JsonPath.stringAt('$.error.Cause'),
          errorName: JsonPath.stringAt('$.error.Error'),
        }),
        resultPath: JsonPath.DISCARD,
      }).next(failState);

      const stageTask = new LambdaInvoke(this, `Stage_${stage}`, {
        lambdaFunction: stageRunnerFn,
        payloadResponseOnly: true,
        payload: TaskInput.fromObject({
          jobId: JsonPath.stringAt('$.jobId'),
          stage,
        }),
        // Overwrite the input with the runner's response object. The
        // response carries `jobId`, so subsequent Choice/Task states keep
        // access to it via `$.jobId`.
        resultPath: '$',
      });
      stageTask.addRetry({
        errors: [
          'Lambda.ServiceException',
          'Lambda.AWSLambdaException',
          'Lambda.SdkClientException',
          'Lambda.TooManyRequestsException',
        ],
        maxAttempts: 2,
        interval: Duration.seconds(5),
        backoffRate: 2,
      });
      if (stage === 'FINALIZE') {
        // Optimistic-concurrency conflicts on the atomic publish (GAME_STALE /
        // PREV_NOT_CURRENT / JOB_STALE) are thrown as RetryableStageError and
        // NOT persisted as FAILED by the runner. Retry re-reads fresh state;
        // once exhausted, the Catch below records FAILED via MarkJobFailed.
        stageTask.addRetry({
          errors: ['RetryableStageError'],
          maxAttempts: 3,
          interval: Duration.seconds(1),
          backoffRate: 2,
        });
      }
      stageTask.addCatch(markFailedTask, {
        errors: ['States.ALL'],
        resultPath: '$.error',
      });

      // A terminal result whose job is not SUCCEEDED (e.g. redelivery of a
      // stage against an already-FAILED job) must not reach Succeed. Synthesise
      // the `$.error` shape the Catch path produces and reuse the same
      // MarkJobFailed_<STAGE> task (idempotent on FAILED, never downgrades
      // SUCCEEDED).
      const terminalNotSucceeded = new Pass(this, `TerminalNotSucceeded_${stage}`, {
        comment: 'Stage runner reported a terminal job that is not SUCCEEDED.',
        parameters: {
          Error: 'TerminalJobNotSucceeded',
          'Cause.$': "States.Format('stage runner returned terminal job with status {}', $.status)",
        },
        resultPath: '$.error',
      }).next(markFailedTask);

      // Choice after each stage — a terminal SUCCEEDED result (FINALIZE
      // completion, or a redelivery against a finished job) ends the
      // execution successfully. Any other terminal result fails it.
      const choice = new Choice(this, `Check_After_${stage}`)
        .when(
          Condition.and(
            Condition.booleanEquals('$.terminal', true),
            Condition.stringEquals('$.status', 'SUCCEEDED'),
          ),
          succeed,
        )
        .when(Condition.booleanEquals('$.terminal', true), terminalNotSucceeded)
        .otherwise(nextEntry);

      const entry = stageTask.next(choice);
      stageEntries.set(stage, entry);
    }

    const chain = Chain.start(stageEntries.get('VALIDATE')!);

    const stateMachine = new StateMachine(this, 'IngestionStateMachine', {
      definitionBody: DefinitionBody.fromChainable(chain),
      timeout: Duration.minutes(15),
      logs: { destination: sfnLogGroup, level: LogLevel.ALL, includeExecutionData: true },
      tracingEnabled: false,
    });

    stateMachine.grantStartExecution(apiFn);
    apiFn.addEnvironment('INGESTION_STATE_MACHINE_ARN', stateMachine.stateMachineArn);

    // Grant the API Lambda access to the new stores.
    gamesTable.grantReadWriteData(apiFn);
    contentTable.grantReadWriteData(apiFn);
    sessionsTable.grantReadWriteData(apiFn);
    messagesTable.grantReadWriteData(apiFn);
    documentsTable.grantReadData(apiFn);
    chunksTable.grantReadData(apiFn);
    ingestionJobsTable.grantReadWriteData(apiFn);
    ingestionBucket.grantReadWrite(apiFn);

    // HTTP API without CORS: the browser reaches the API via CloudFront (see
    // ADR-0007), so every request is same-origin and no preflight is issued.
    const api = new HttpApi(this, 'HttpApi', {
      description: 'BGR dev HTTP API',
    });

    const integration = new HttpLambdaIntegration('ApiIntegration', apiFn);

    for (const routeDef of [
      { path: '/health', method: HttpMethod.GET },
      { path: '/games', method: HttpMethod.GET },
      { path: '/games', method: HttpMethod.POST },
      { path: '/games/{gameId}', method: HttpMethod.GET },
      { path: '/games/{gameId}/content', method: HttpMethod.GET },
      { path: '/sessions', method: HttpMethod.POST },
      { path: '/sessions/{sessionId}', method: HttpMethod.GET },
      { path: '/sessions/{sessionId}', method: HttpMethod.DELETE },
      { path: '/sessions/{sessionId}/messages', method: HttpMethod.POST },
      { path: '/uploads/presign', method: HttpMethod.POST },
      { path: '/ingestion', method: HttpMethod.POST },
      { path: '/ingestion/{jobId}', method: HttpMethod.GET },
      { path: '/sources/{sourceId}', method: HttpMethod.GET },
      { path: '/sources/{sourceId}/chunks', method: HttpMethod.GET },
    ]) {
      api.addRoutes({
        path: routeDef.path,
        methods: [routeDef.method],
        integration,
      });
    }

    // The default stage is auto-created by HttpApi; throttle it via the L1 stage.
    const defaultStage = api.defaultStage!.node.defaultChild as CfnStage;
    defaultStage.defaultRouteSettings = {
      throttlingRateLimit: answering.throttle.rateLimit,
      throttlingBurstLimit: answering.throttle.burstLimit,
    };

    // ------ Frontend: S3 origin + CloudFront ----------------------------
    const siteBucket = new Bucket(this, 'WebBucket', {
      blockPublicAccess: BlockPublicAccess.BLOCK_ALL,
      encryption: BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      removalPolicy: RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
      versioned: false,
    });

    const stripApiPrefixFn = new CfFunction(this, 'StripApiPrefixFn', {
      code: FunctionCode.fromInline(`
        function handler(event) {
          var req = event.request;
          if (req.uri === '/api') {
            req.uri = '/';
          } else if (req.uri.indexOf('/api/') === 0) {
            req.uri = req.uri.substring(4);
          }
          return req;
        }
      `),
      comment: 'Strip /api prefix before forwarding to API Gateway',
    });

    const apiOriginDomain = `${api.apiId}.execute-api.${this.region}.${this.urlSuffix}`;

    const distribution = new Distribution(this, 'WebDistribution', {
      defaultRootObject: 'index.html',
      defaultBehavior: {
        origin: S3BucketOrigin.withOriginAccessControl(siteBucket),
        viewerProtocolPolicy: ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
      },
      additionalBehaviors: {
        '/api/*': {
          origin: new HttpOrigin(apiOriginDomain),
          viewerProtocolPolicy: ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
          allowedMethods: AllowedMethods.ALLOW_ALL,
          cachePolicy: CachePolicy.CACHING_DISABLED,
          originRequestPolicy: OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
          functionAssociations: [
            {
              function: stripApiPrefixFn,
              eventType: FunctionEventType.VIEWER_REQUEST,
            },
          ],
        },
      },
      errorResponses: [
        { httpStatus: 403, responseHttpStatus: 200, responsePagePath: '/index.html' },
        { httpStatus: 404, responseHttpStatus: 200, responsePagePath: '/index.html' },
      ],
    });

    // Tighten the ingestion bucket CORS to only the CloudFront web origin
    // (ADR-0008 §R10). Applied via the L1 CfnBucket escape hatch because the
    // distribution domain is only known after `Distribution` is constructed.
    const cfnIngestionBucket = ingestionBucket.node.defaultChild as CfnBucket;
    cfnIngestionBucket.corsConfiguration = {
      corsRules: [
        {
          allowedMethods: ['PUT'],
          allowedOrigins: [`https://${distribution.distributionDomainName}`],
          allowedHeaders: ['*'],
          exposedHeaders: ['ETag'],
          maxAge: 3000,
        },
      ],
    };

    new CfnOutput(this, 'ApiUrl', { value: api.apiEndpoint });
    new CfnOutput(this, 'DistributionDomain', {
      value: distribution.distributionDomainName,
    });
    new CfnOutput(this, 'DistributionId', { value: distribution.distributionId });
    new CfnOutput(this, 'CloudFrontApiUrl', {
      value: `https://${distribution.distributionDomainName}/api`,
    });
    new CfnOutput(this, 'WebBucketName', { value: siteBucket.bucketName });
    new CfnOutput(this, 'GamesTableName', { value: gamesTable.tableName });
    new CfnOutput(this, 'ContentTableName', { value: contentTable.tableName });
    new CfnOutput(this, 'SessionsTableName', { value: sessionsTable.tableName });
    new CfnOutput(this, 'MessagesTableName', { value: messagesTable.tableName });
    new CfnOutput(this, 'DocumentsTableName', { value: documentsTable.tableName });
    new CfnOutput(this, 'ChunksTableName', { value: chunksTable.tableName });
    new CfnOutput(this, 'IngestionJobsTableName', { value: ingestionJobsTable.tableName });
    new CfnOutput(this, 'UsageTableName', { value: usageTable.tableName });
    new CfnOutput(this, 'IngestionBucketName', { value: ingestionBucket.bucketName });
    new CfnOutput(this, 'IngestionStateMachineArn', { value: stateMachine.stateMachineArn });
  }
}

interface ApiEnvArgs {
  gamesTable: Table;
  contentTable: Table;
  sessionsTable: Table;
  messagesTable: Table;
  documentsTable: Table;
  chunksTable: Table;
  ingestionJobsTable: Table;
  ingestionBucket: Bucket;
  sessionTtlSeconds: number;
  uploadMaxBytes: number;
  presignExpirySeconds: number;
}

function baseApiEnvironment(args: ApiEnvArgs): Record<string, string> {
  return {
    NODE_OPTIONS: '--enable-source-maps',
    GIT_COMMIT: process.env['GIT_COMMIT'] ?? 'unknown',
    GAMES_TABLE: args.gamesTable.tableName,
    CONTENT_TABLE: args.contentTable.tableName,
    SESSIONS_TABLE: args.sessionsTable.tableName,
    MESSAGES_TABLE: args.messagesTable.tableName,
    DOCUMENTS_TABLE: args.documentsTable.tableName,
    CHUNKS_TABLE: args.chunksTable.tableName,
    INGESTION_JOBS_TABLE: args.ingestionJobsTable.tableName,
    INGESTION_BUCKET: args.ingestionBucket.bucketName,
    SESSION_TTL_SECONDS: String(args.sessionTtlSeconds),
    UPLOAD_MAX_BYTES: String(args.uploadMaxBytes),
    PRESIGN_EXPIRY_SECONDS: String(args.presignExpirySeconds),
    // See ADR-0007 — same-origin routing via CloudFront, no API-side CORS.
    ALLOWED_ORIGIN: 'same-origin',
  };
}

/** Geography prefixes of Bedrock cross-region inference profile ids (`<prefix>.<foundationId>`). */
const INFERENCE_PROFILE_PREFIXES: ReadonlySet<string> = new Set([
  'global',
  'us',
  'us-gov',
  'eu',
  'apac',
  'jp',
  'au',
  'ca',
]);

/**
 * Bedrock InvokeModel resources for every approved catalog model. An
 * inference profile `<prefix>.<foundationId>` routes to the foundation model in
 * its destination regions, so IAM needs both ARNs; a `global.` profile also
 * routes to the region-less ARN. Model ids are never wildcarded.
 */
export function catalogInvokeResources(catalog: ModelCatalog, account: string): string[] {
  const keys = new Set(MODEL_ROLES.flatMap((role) => catalog.approved[role]));
  const resources = new Set<string>();
  for (const key of keys) {
    const { modelId, region } = catalog.models[key]!;
    const dot = modelId.indexOf('.');
    const prefix = modelId.slice(0, dot);
    if (!INFERENCE_PROFILE_PREFIXES.has(prefix)) {
      // A plain foundation-model id (e.g. `amazon.nova-micro-v1:0`): no profile.
      resources.add(`arn:aws:bedrock:${region}::foundation-model/${modelId}`);
      continue;
    }
    const foundationId = modelId.slice(dot + 1);
    resources.add(`arn:aws:bedrock:${region}:${account}:inference-profile/${modelId}`);
    resources.add(`arn:aws:bedrock:*::foundation-model/${foundationId}`);
    if (prefix === 'global') resources.add(`arn:aws:bedrock:::foundation-model/${foundationId}`);
  }
  return [...resources].sort();
}

function buildIngestionLifecycle(): LifecycleRule[] {
  // ADR-0008 §R9 storage lifecycle:
  //   raw/                       — retained; finalized SourceDocument rows
  //                                 reference these objects. Reprocessing an
  //                                 uploaded rulebook must remain possible.
  //   normalized/                — retained; canonical chunk bodies.
  //   stage-state/ingestion/     — 7 day expiry; per-job intermediate stage
  //                                 state (parsed.json, normalized.json, …).
  //   temporary/                 — 1 day expiry catch-all for scratch space.
  // S3 applies EVERY rule whose prefix matches and the shortest expiration
  // wins, so no rule's prefix may nest inside another's — stage state has its
  // own top-level prefix rather than living under temporary/.
  // Multipart uploads under any prefix are aborted after 3 days to avoid
  // orphaned parts.
  return [
    {
      id: 'expire-stage-state-ingestion-7d',
      prefix: 'stage-state/ingestion/',
      enabled: true,
      expiration: Duration.days(7),
      abortIncompleteMultipartUploadAfter: Duration.days(3),
    },
    {
      id: 'expire-temporary-1d',
      prefix: 'temporary/',
      enabled: true,
      expiration: Duration.days(1),
      abortIncompleteMultipartUploadAfter: Duration.days(3),
    },
    {
      id: 'abort-orphan-multipart-raw',
      prefix: 'raw/',
      enabled: true,
      abortIncompleteMultipartUploadAfter: Duration.days(3),
    },
    {
      id: 'abort-orphan-multipart-normalized',
      prefix: 'normalized/',
      enabled: true,
      abortIncompleteMultipartUploadAfter: Duration.days(3),
    },
  ];
}
