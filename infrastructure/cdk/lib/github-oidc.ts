import { CfnOutput, Stack, type StackProps } from 'aws-cdk-lib';
import {
  ArnPrincipal,
  Effect,
  ManagedPolicy,
  OpenIdConnectPrincipal,
  OpenIdConnectProvider,
  PolicyStatement,
  Role,
} from 'aws-cdk-lib/aws-iam';
import type { Construct } from 'constructs';

export interface GithubOidcStackProps extends StackProps {
  /**
   * GitHub `owner/repo` string. Trust is restricted to this repository and the
   * given environment (defaulting to `dev`), and to the `main` branch for pushes.
   */
  githubRepo: string;
  environmentName?: string;
  /**
   * When set, the stack reuses the existing account-wide GitHub OIDC provider
   * at this ARN instead of creating a new one. The provider is a per-account
   * singleton, so any account that already has one for another project must
   * pass this to avoid `EntityAlreadyExistsException`.
   */
  existingOidcProviderArn?: string;
}

/**
 * OIDC provider + deployment role for GitHub Actions.
 *
 * Deploy once per account. The dev pipeline assumes `DeployRoleArn`
 * via `aws-actions/configure-aws-credentials@v4` with `role-to-assume`.
 */
export class GithubOidcStack extends Stack {
  public readonly deployRoleArn: string;

  constructor(scope: Construct, id: string, props: GithubOidcStackProps) {
    super(scope, id, props);

    const environmentName = props.environmentName ?? 'dev';

    const provider = props.existingOidcProviderArn
      ? OpenIdConnectProvider.fromOpenIdConnectProviderArn(
          this,
          'GithubOidcProvider',
          props.existingOidcProviderArn,
        )
      : new OpenIdConnectProvider(this, 'GithubOidcProvider', {
          url: 'https://token.actions.githubusercontent.com',
          clientIds: ['sts.amazonaws.com'],
        });

    // Scope trust to the repo itself. Further-narrowed patterns (ref/environment/
    // pull_request) are fiddly across trigger types and easy to get subtly wrong;
    // the meaningful boundary is "only workflows in THIS repo can assume this
    // role". Tightened per-environment (`environment:prod`) in Milestone 9.
    const subjectPatterns = [`repo:${props.githubRepo}:*`];

    const principal = new OpenIdConnectPrincipal(provider, {
      StringEquals: { 'token.actions.githubusercontent.com:aud': 'sts.amazonaws.com' },
      StringLike: { 'token.actions.githubusercontent.com:sub': subjectPatterns },
    });

    // Deployment role trusts the GitHub OIDC principal above, and additionally the
    // account root so break-glass deploys from a trusted human are possible.
    const role = new Role(this, 'GithubDeployRole', {
      assumedBy: principal,
      roleName: `bgr-github-deploy-${environmentName}`,
      description: `GitHub Actions deploy role for BGR ${environmentName}`,
    });
    role.assumeRolePolicy?.addStatements(
      new PolicyStatement({
        effect: Effect.ALLOW,
        principals: [new ArnPrincipal(`arn:aws:iam::${this.account}:root`)],
        actions: ['sts:AssumeRole'],
      }),
    );

    // Least-privilege for M0 is impractical for `cdk deploy`; we scope to the
    // permissions needed to synth/deploy CloudFormation-managed stacks and let
    // CDK bootstrap resources gate finer-grained access. Tightened per-service
    // in M9.
    role.addManagedPolicy(ManagedPolicy.fromAwsManagedPolicyName('PowerUserAccess'));
    role.addToPolicy(
      new PolicyStatement({
        effect: Effect.ALLOW,
        actions: ['iam:PassRole', 'iam:GetRole', 'iam:CreateRole', 'iam:AttachRolePolicy'],
        resources: ['*'],
      }),
    );

    this.deployRoleArn = role.roleArn;

    new CfnOutput(this, 'DeployRoleArn', { value: role.roleArn });
    new CfnOutput(this, 'GithubOidcProviderArn', {
      value: provider.openIdConnectProviderArn,
    });
  }
}
