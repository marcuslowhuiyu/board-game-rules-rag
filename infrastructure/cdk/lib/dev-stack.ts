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
import { BlockPublicAccess, Bucket, BucketEncryption } from 'aws-cdk-lib/aws-s3';
import type { Construct } from 'constructs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export interface DevStackProps extends StackProps {
  /** Session TTL in seconds. Defaults to 24h. */
  sessionTtlSeconds?: number;
}

export class DevStack extends Stack {
  constructor(scope: Construct, id: string, props: DevStackProps = {}) {
    super(scope, id, props);

    const sessionTtlSeconds = props.sessionTtlSeconds ?? 60 * 60 * 24;

    // ------ Application data (DynamoDB — see ADR-0006) ------------------
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
      timeout: Duration.seconds(10),
      logGroup: apiLogGroup,
      environment: {
        NODE_OPTIONS: '--enable-source-maps',
        GIT_COMMIT: process.env['GIT_COMMIT'] ?? 'unknown',
        GAMES_TABLE: gamesTable.tableName,
        CONTENT_TABLE: contentTable.tableName,
        SESSIONS_TABLE: sessionsTable.tableName,
        MESSAGES_TABLE: messagesTable.tableName,
        SESSION_TTL_SECONDS: String(sessionTtlSeconds),
        // ALLOWED_ORIGIN is used by the API only for defensive logging /
        // future affordances. Since the browser reaches the API through the
        // same CloudFront origin as the SPA (ADR-0007), CORS is not on the
        // browser path; API Gateway therefore does not configure CORS.
        ALLOWED_ORIGIN: 'same-origin',
      },
      bundling: {
        format: OutputFormat.ESM,
        target: 'node22',
        sourceMap: true,
        minify: false,
      },
    });

    gamesTable.grantReadWriteData(apiFn);
    contentTable.grantReadWriteData(apiFn);
    sessionsTable.grantReadWriteData(apiFn);
    messagesTable.grantReadWriteData(apiFn);

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

    // Viewer-request function that strips the `/api` prefix before sending
    // the request to the API Gateway origin. Everything after `/api` maps
    // 1:1 to the routes registered on the API above.
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
          // Forwards every viewer header/cookie/query-string except Host so
          // API Gateway sees its own hostname (needed for it to match the
          // request to its API id).
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
  }
}
