import { fileURLToPath } from 'node:url';
import * as path from 'node:path';
import { CfnOutput, Duration, RemovalPolicy, Stack, type StackProps } from 'aws-cdk-lib';
import { HttpApi, HttpMethod } from 'aws-cdk-lib/aws-apigatewayv2';
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
import { LogGroup, RetentionDays } from 'aws-cdk-lib/aws-logs';
import {
  BlockPublicAccess,
  Bucket,
  BucketEncryption,
  HttpMethods,
  type LifecycleRule,
} from 'aws-cdk-lib/aws-s3';
import {
  DefinitionBody,
  IntegrationPattern,
  JsonPath,
  LogLevel,
  Pass,
  StateMachine,
  Succeed,
  Fail,
  TaskInput,
  Chain,
} from 'aws-cdk-lib/aws-stepfunctions';
import { LambdaInvoke } from 'aws-cdk-lib/aws-stepfunctions-tasks';
import type { Construct } from 'constructs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const M2_STAGES = [
  'VALIDATE',
  'FETCH',
  'PARSE',
  'CLASSIFY',
  'DISCOVER_ERRATA',
  'NORMALIZE',
  'CHUNK',
  'FINALIZE',
] as const;

export interface DevStackProps extends StackProps {
  /** Session TTL in seconds. Defaults to 24h. */
  sessionTtlSeconds?: number;
  /** Upload size cap (bytes). Defaults to 50 MiB. */
  uploadMaxBytes?: number;
  /** Presigned URL expiry (seconds). Defaults to 10 minutes. */
  presignExpirySeconds?: number;
}

export class DevStack extends Stack {
  constructor(scope: Construct, id: string, props: DevStackProps = {}) {
    super(scope, id, props);

    const sessionTtlSeconds = props.sessionTtlSeconds ?? 60 * 60 * 24;
    const uploadMaxBytes = props.uploadMaxBytes ?? 50 * 1024 * 1024;
    const presignExpirySeconds = props.presignExpirySeconds ?? 600;

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

    // ------ Ingestion S3 bucket (raw/ + normalized/) --------------------
    const ingestionBucket = new Bucket(this, 'IngestionBucket', {
      blockPublicAccess: BlockPublicAccess.BLOCK_ALL,
      encryption: BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      versioned: false,
      removalPolicy: RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
      lifecycleRules: buildIngestionLifecycle(),
      // Presigned PUTs go directly from the browser to S3 — needs CORS.
      cors: [
        {
          allowedMethods: [HttpMethods.PUT],
          allowedOrigins: ['*'],
          allowedHeaders: ['*'],
          exposedHeaders: ['ETag'],
          maxAge: 3000,
        },
      ],
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
      memorySize: 512,
      timeout: Duration.seconds(15),
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
      bundling: {
        format: OutputFormat.ESM,
        target: 'node22',
        sourceMap: true,
        minify: false,
      },
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
      // PDF parsing (unpdf → pdfjs-dist) can be moderately CPU-heavy on
      // large rulebooks; a 60s wall-clock keeps us safe under Lambda limits
      // while Step Functions handles orchestration-level retries.
      timeout: Duration.seconds(60),
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
      },
      bundling: {
        format: OutputFormat.ESM,
        target: 'node22',
        sourceMap: true,
        minify: false,
      },
    });

    gamesTable.grantReadWriteData(stageRunnerFn);
    contentTable.grantReadData(stageRunnerFn);
    documentsTable.grantReadWriteData(stageRunnerFn);
    chunksTable.grantReadWriteData(stageRunnerFn);
    ingestionJobsTable.grantReadWriteData(stageRunnerFn);
    ingestionBucket.grantReadWrite(stageRunnerFn);

    // ------ Step Functions state machine --------------------------------
    const sfnLogGroup = new LogGroup(this, 'IngestionStateMachineLogs', {
      retention: RetentionDays.ONE_WEEK,
      removalPolicy: RemovalPolicy.DESTROY,
    });

    const failState = new Fail(this, 'PipelineFailed', {
      comment: 'One of the stage Lambdas threw; the job row has the error details.',
      cause: "Stage runner threw. See the ingestion jobs table for the job's error field.",
      error: 'IngestionStageFailed',
    });

    const stageTasks = M2_STAGES.map((stage) =>
      new LambdaInvoke(this, `Stage_${stage}`, {
        lambdaFunction: stageRunnerFn,
        integrationPattern: IntegrationPattern.REQUEST_RESPONSE,
        payload: TaskInput.fromObject({
          jobId: JsonPath.stringAt('$.jobId'),
          stage,
        }),
        resultPath: JsonPath.DISCARD,
        // The stage runner is idempotent — a stalled Lambda / throttled DDB
        // write is safe to retry. Two attempts, 5–20s backoff.
      })
        .addRetry({
          errors: [
            'Lambda.ServiceException',
            'Lambda.AWSLambdaException',
            'Lambda.SdkClientException',
          ],
          maxAttempts: 2,
          interval: Duration.seconds(5),
          backoffRate: 2,
        })
        .addCatch(failState, { errors: ['States.ALL'], resultPath: '$.error' }),
    );

    const succeed = new Succeed(this, 'PipelineSucceeded');
    // A trailing Pass keeps future EMBED / INDEX insertions non-breaking.
    const skippedEmbedIndex = new Pass(this, 'SkipEmbedIndexInM2', {
      comment: 'EMBED / INDEX stages are declared but skipped in M2; they light up in M3.',
    });

    let chain: Chain | undefined;
    for (const task of stageTasks) {
      chain = chain ? chain.next(task) : Chain.start(task);
    }
    chain = chain!.next(skippedEmbedIndex).next(succeed);

    const stateMachine = new StateMachine(this, 'IngestionStateMachine', {
      definitionBody: DefinitionBody.fromChainable(chain),
      timeout: Duration.minutes(15),
      logs: { destination: sfnLogGroup, level: LogLevel.ALL, includeExecutionData: true },
      tracingEnabled: false,
    });

    // The API Lambda kicks off executions; the state machine invokes the
    // stage runner (grant already added when we grantInvoke on the SFN).
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

function buildIngestionLifecycle(): LifecycleRule[] {
  // See MASTER_PLAN §51 cost controls and §49 upload controls. Raw uploads
  // are retained for 90 days for reprocessing; normalized/state artifacts
  // are cleaned up more aggressively since the DDB rows are the source of
  // truth after finalize.
  return [
    {
      id: 'expire-raw-90d',
      prefix: 'raw/',
      enabled: true,
      expiration: Duration.days(90),
    },
    {
      id: 'expire-state-cleanup',
      prefix: 'normalized/',
      enabled: true,
      // Chunk-body files live under normalized/{documentId}/*.txt — the DDB
      // row references them; multi-part uploads that never complete are
      // cleaned up eagerly to avoid orphaned parts.
      abortIncompleteMultipartUploadAfter: Duration.days(3),
    },
    {
      id: 'expire-temp-1d',
      prefix: 'temporary/',
      enabled: true,
      expiration: Duration.days(1),
    },
  ];
}
