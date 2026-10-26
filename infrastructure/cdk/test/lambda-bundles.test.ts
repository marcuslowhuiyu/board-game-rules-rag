import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { App } from 'aws-cdk-lib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DevStack } from '../lib/dev-stack.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Unit tests import the TypeScript sources, so they cannot see packaging
// faults in the esbuild output that actually ships (e.g. a CommonJS
// dependency calling `require` inside an ESM bundle). This test loads each
// real Lambda bundle in a plain Node process, the way the Lambda runtime does.
//
// `@aws-sdk/*` is left external by NodejsFunction (the runtime provides it),
// so bundles are copied under apps/api, whose node_modules resolve it.
const SMOKE_ROOT = path.resolve(__dirname, '../../../apps/api/.bundle-smoke');

describe('Lambda bundles', () => {
  let outdir: string;
  let bundles: string[];

  beforeAll(() => {
    outdir = mkdtempSync(path.join(tmpdir(), 'bgr-cdk-'));
    const app = new App({ outdir });
    new DevStack(app, 'BundleSmokeStack', { env: { region: 'ap-southeast-1' } });
    app.synth();
    bundles = readdirSync(outdir)
      .filter((d) => d.startsWith('asset.') && existsSync(path.join(outdir, d, 'index.mjs')))
      .map((d) => {
        const dest = path.join(SMOKE_ROOT, d);
        cpSync(path.join(outdir, d), dest, { recursive: true });
        return path.join(dest, 'index.mjs');
      });
  }, 120_000);

  afterAll(() => {
    rmSync(SMOKE_ROOT, { recursive: true, force: true });
    rmSync(outdir, { recursive: true, force: true });
  });

  it('produces the api, stage-runner and mark-job-failed bundles', () => {
    expect(bundles).toHaveLength(3);
  });

  it('every bundle loads in Node and exports a handler function', () => {
    for (const bundle of bundles) {
      const out = execFileSync(
        process.execPath,
        [
          '--input-type=module',
          '-e',
          `const m = await import(${JSON.stringify(bundle)}); console.log(typeof m.handler);`,
        ],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
      );
      expect(out.trim(), bundle).toBe('function');
    }
  });
});
