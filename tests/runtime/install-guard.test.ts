import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import test from 'node:test';

test('主包应声明 preinstall 守卫并随发布包携带脚本', async () => {
  const pkg = JSON.parse(await fs.readFile('package.json', 'utf8')) as {
    engines?: { node?: string };
    files?: string[];
    scripts?: Record<string, string>;
  };

  assert.equal(pkg.engines?.node, '>=20 <25');
  assert.equal(pkg.scripts?.preinstall, 'node scripts/check-node-version.js');
  assert.ok(pkg.files?.includes('scripts/check-node-version.js'));
});

test('Node 24 应通过安装守卫', () => {
  const result = spawnSync('node', ['scripts/check-node-version.js'], {
    encoding: 'utf8',
    env: {
      ...process.env,
      CODERECALL_NODE_VERSION_OVERRIDE: 'v24.15.0',
    },
  });

  assert.equal(result.status, 0, `Node 24 不应被拦截: ${result.stderr}`);
});

test('Node 25 应在安装守卫阶段被拦截', () => {
  const result = spawnSync('node', ['scripts/check-node-version.js'], {
    encoding: 'utf8',
    env: {
      ...process.env,
      CODERECALL_NODE_VERSION_OVERRIDE: 'v25.0.0',
    },
  });

  assert.notEqual(result.status, 0, 'Node 25 预期应被拦截');
  assert.match(result.stderr, /20 到 24/);
});

test('Node 22 应通过安装守卫', () => {
  const result = spawnSync('node', ['scripts/check-node-version.js'], {
    encoding: 'utf8',
    env: {
      ...process.env,
      CODERECALL_NODE_VERSION_OVERRIDE: 'v22.17.0',
    },
  });

  assert.equal(result.status, 0, `Node 22 不应被拦截: ${result.stderr}`);
});
