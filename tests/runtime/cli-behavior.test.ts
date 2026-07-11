import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { formatIndexSummary } from '../../src/cli/indexSummary.js';

test('无文件或向量变更时，索引命令只输出已是最新摘要', () => {
  const summary = formatIndexSummary(
    {
      totalFiles: 1047,
      added: 0,
      modified: 0,
      unchanged: 1047,
      deleted: 0,
      skipped: 0,
      errors: 0,
    },
    '0.15',
  );

  assert.equal(summary, '索引已是最新（1047 个文件，0.15s）');
});

test('存在文件变更时，索引命令保留完整统计摘要', () => {
  const summary = formatIndexSummary(
    {
      totalFiles: 1047,
      added: 1,
      modified: 2,
      unchanged: 1044,
      deleted: 0,
      skipped: 0,
      errors: 0,
    },
    '1.82',
  );

  assert.equal(summary, '索引完成 (1.82s)\n总数:1047 新增:1 修改:2 未变:1044 删除:0 跳过:0 错误:0');
});

test('向量索引未收敛时，不应误报索引已是最新', () => {
  const summary = formatIndexSummary(
    {
      totalFiles: 1047,
      added: 0,
      modified: 0,
      unchanged: 1047,
      deleted: 0,
      skipped: 0,
      errors: 0,
      vectorIndex: {
        indexed: 1,
        deleted: 0,
        errors: 1,
      },
    },
    '1.82',
  );

  assert.match(summary, /^索引完成 \(1\.82s\)/);
});

test(
  'search source_code_only + include_languages 组合不再互斥，取交集后正常进入搜索',
  { concurrency: false },
  () => {
    const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'coderecall-cli-language-flags-'));

    try {
      const result = spawnSync(
        process.execPath,
        [
          '--import',
          'tsx',
          'src/index.ts',
          'search',
          '--repo-path',
          process.cwd(),
          '--information-request',
          '定位测试入口',
          '--technical-terms',
          'AuthService, SearchService',
          '--source-code-only',
          '--include-languages',
          'typescript,python',
          '--exclude-languages',
          'markdown,json',
        ],
        {
          cwd: process.cwd(),
          encoding: 'utf8',
          env: {
            HOME: fakeHome,
            PATH: process.env.PATH ?? '',
            NODE_ENV: 'production',
          },
        },
      );

      // 不再报互斥错误，正常进入搜索流程（因缺少 API key 而失败）
      assert.doesNotMatch(result.stderr, /互斥/);
      assert.match(result.stdout, /配置缺失/);
    } finally {
      fs.rmSync(fakeHome, { recursive: true, force: true });
    }
  },
);

test('search 配置缺失时返回非零退出码', { concurrency: false }, () => {
  const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'coderecall-cli-missing-env-'));

  try {
    const result = spawnSync(
      process.execPath,
      [
        '--import',
        'tsx',
        'src/index.ts',
        'search',
        '--repo-path',
        process.cwd(),
        '--information-request',
        '定位测试入口',
      ],
      {
        cwd: process.cwd(),
        encoding: 'utf8',
        env: {
          HOME: fakeHome,
          PATH: process.env.PATH ?? '',
          NODE_ENV: 'production',
        },
      },
    );

    assert.notEqual(result.status, 0);
    assert.match(result.stdout, /配置缺失/);
    assert.match(result.stdout, /EMBEDDINGS_API_KEY 或 EMBEDDINGS_API_KEYS/);
  } finally {
    fs.rmSync(fakeHome, { recursive: true, force: true });
  }
});

test('search 在日志目录不可写时不应因 logger 崩溃', { concurrency: false }, () => {
  const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'coderecall-cli-readonly-logs-'));
  const logDir = path.join(fakeHome, '.coderecall', 'logs');

  try {
    fs.mkdirSync(logDir, { recursive: true });
    fs.chmodSync(logDir, 0o555);

    const result = spawnSync(
      process.execPath,
      [
        '--import',
        'tsx',
        'src/index.ts',
        'search',
        '--repo-path',
        process.cwd(),
        '--information-request',
        '定位测试入口',
      ],
      {
        cwd: process.cwd(),
        encoding: 'utf8',
        env: {
          HOME: fakeHome,
          PATH: process.env.PATH ?? '',
          NODE_ENV: 'production',
        },
      },
    );

    assert.notEqual(result.status, 0);
    assert.doesNotMatch(result.stderr, /ERR_STREAM_DESTROYED/);
    assert.match(result.stdout, /配置缺失/);
  } finally {
    fs.chmodSync(logDir, 0o755);
    fs.rmSync(fakeHome, { recursive: true, force: true });
  }
});
