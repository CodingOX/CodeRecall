import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

const result = spawnSync('node', ['scripts/check-node-version.js'], {
  encoding: 'utf8',
  env: {
    ...process.env,
    CODERECALL_NODE_VERSION_OVERRIDE: 'v24.15.0',
  },
});

assert.equal(
  result.status,
  0,
  `Node 24 安装守卫未放行\nstdout: ${result.stdout}\nstderr: ${result.stderr}`,
);
