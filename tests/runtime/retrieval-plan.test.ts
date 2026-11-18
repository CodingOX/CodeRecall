import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';
import { closeDb, initDb } from '../../src/db/index.js';
import { searchPaths } from '../../src/search/PathRecall.js';
import { buildRetrievalPlan, classifyRetrievalIntent } from '../../src/search/RetrievalPlan.js';
import { SearchService } from '../../src/search/SearchService.js';
import type { ScoredChunk } from '../../src/search/types.js';
import { getProjectDataDir } from '../../src/utils/paths.js';

function createTempProjectId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
}

function makeChunk(
  filePath: string,
  chunkIndex: number,
  score: number,
  source: ScoredChunk['source'] = 'vector',
): ScoredChunk {
  return {
    filePath,
    chunkIndex,
    score,
    source,
    record: {
      chunk_id: `${filePath}#h#${chunkIndex}`,
      file_path: filePath,
      file_hash: 'h',
      chunk_index: chunkIndex,
      vector: [0],
      display_code: `code-${chunkIndex}`,
      vector_text: `code-${chunkIndex}`,
      language: 'typescript',
      breadcrumb: `${filePath} > fn`,
      start_index: 0,
      end_index: 10,
      raw_start: 0,
      raw_end: 10,
      vec_start: 0,
      vec_end: 10,
      _distance: 0,
    },
  };
}

test('RetrievalPlan 应准确分类 7 类意图并覆盖多语言路径线索', () => {
  assert.equal(classifyRetrievalIntent('SearchService 在哪里定义？'), 'symbol');
  assert.equal(classifyRetrievalIntent('MCP server 的实现文件在哪里？'), 'path');
  assert.equal(classifyRetrievalIntent('UserController.kt 在哪个目录？'), 'path');
  assert.equal(classifyRetrievalIntent('AppView.vue 的路径在哪里？'), 'path');
  assert.equal(classifyRetrievalIntent('Router.swift 和 Service.dart 在哪？'), 'path');
  assert.equal(classifyRetrievalIntent('getGraphExpander 是在哪里被调用的？'), 'reference');
  assert.equal(
    classifyRetrievalIntent('执行 search 命令后如何经过 handler 再进入 SearchService？'),
    'call-chain',
  );
  assert.equal(classifyRetrievalIntent('完整检索系统架构如何分工与组织？'), 'overview');
  assert.equal(
    classifyRetrievalIntent(
      '代码库中的文件怎样被发现和过滤，然后解析成语义 chunk，最后持久化到索引？',
    ),
    'compound',
  );
  assert.equal(classifyRetrievalIntent('向量召回和词法召回是如何融合的？'), 'feature');

  assert.equal(buildRetrievalPlan('完整系统架构如何分工？').minSeedFiles, 4);
  assert.equal(
    buildRetrievalPlan('文件怎样被发现和过滤，然后解析成语义 chunk，最后持久化到索引？')
      .minSeedFiles,
    4,
  );
  assert.equal(buildRetrievalPlan('调用流程从 CLI 进入 Service').minSeedFiles, 3);
  assert.equal(buildRetrievalPlan('who calls initDb?').minSeedFiles, 2);
  assert.equal(buildRetrievalPlan('initDb 在哪里定义？').minSeedFiles, 1);

  assert.equal(buildRetrievalPlan('config.ts 文件在哪里？').usePath, true);
  assert.equal(
    buildRetrievalPlan('文件怎样被发现和过滤，然后解析成语义 chunk，最后持久化到索引？').usePath,
    true,
  );
  assert.equal(buildRetrievalPlan('initDb 在哪里定义？').usePath, false);
});

test('PathRecall 应优先命中文件名并支持语言白名单过滤', async () => {
  const projectId = createTempProjectId('path-recall');
  const db = initDb(projectId);

  try {
    const stmt = db.prepare(
      'INSERT OR REPLACE INTO files (path, hash, mtime, size, content, language) VALUES (?, ?, ?, ?, ?, ?)',
    );
    stmt.run('src/search/config.ts', 'h1', 1, 10, '', 'typescript');
    stmt.run('src/search/SearchService.ts', 'h2', 1, 10, '', 'typescript');
    stmt.run('scripts/config.py', 'h3', 1, 10, '', 'python');

    const allMatches = searchPaths(db, 'search config 文件在哪里？', 10);
    assert.ok(allMatches.length >= 2);
    assert.equal(allMatches[0].filePath, 'src/search/config.ts');

    const pyOnly = searchPaths(db, 'config 文件在哪里？', 10, ['python']);
    assert.equal(pyOnly.length, 1);
    assert.equal(pyOnly[0].filePath, 'scripts/config.py');
  } finally {
    closeDb(db);
    await fs.rm(getProjectDataDir(projectId), { recursive: true, force: true });
  }
});

test('SearchService.fuse 应融合 path 通道并保留 both/path 来源标识', () => {
  const service = new SearchService('fuse-path-test', '/tmp/project') as unknown as {
    fuse: (
      v: Array<ScoredChunk & { _rank?: number }>,
      l: Array<ScoredChunk & { _rank?: number }>,
      p?: Array<ScoredChunk & { _rank?: number }>,
    ) => ScoredChunk[];
  };

  const fused = service.fuse(
    [{ ...makeChunk('src/a.ts', 0, 0.9, 'vector'), _rank: 0 }],
    [{ ...makeChunk('src/a.ts', 0, 0.8, 'lexical'), _rank: 0 }],
    [{ ...makeChunk('src/b.ts', 0, 24, 'path'), _rank: 0 }],
  );

  assert.equal(fused.length, 2);
  const hitA = fused.find((c) => c.filePath === 'src/a.ts');
  const hitB = fused.find((c) => c.filePath === 'src/b.ts');
  assert.equal(hitA?.source, 'both');
  assert.equal(hitB?.source, 'path');
});

test('applySmartCutoff 应通过 ensureMinSeedFiles 保障多文件多样性与低置信次级阈值', () => {
  const service = new SearchService('cutoff-diversity-test', '/tmp/project', {
    smartMinScore: 0.25,
    smartTopScoreRatio: 0.5,
    smartTopScoreDeltaAbs: 0.25,
    smartMinK: 2,
    smartMaxK: 4,
  }) as unknown as {
    applySmartCutoff: (
      candidates: ScoredChunk[],
      plan?: ReturnType<typeof buildRetrievalPlan>,
    ) => ScoredChunk[];
  };

  // 场景一：topScore >= floor，前 4 个均来自同一文件，应替换冗余同文件 chunk 以满足 minSeedFiles=3
  const callChainPlan = buildRetrievalPlan('从 CLI 进入 SearchService 的调用链');
  const highCandidates = [
    makeChunk('src/a.ts', 0, 0.95),
    makeChunk('src/a.ts', 1, 0.9),
    makeChunk('src/a.ts', 2, 0.85),
    makeChunk('src/a.ts', 3, 0.8),
    makeChunk('src/b.ts', 0, 0.6),
    makeChunk('src/c.ts', 0, 0.5),
  ];
  const highSeeds = service.applySmartCutoff(highCandidates, callChainPlan);
  const highFiles = new Set(highSeeds.map((s) => s.filePath));
  assert.equal(highSeeds.length, 4);
  assert.equal(highFiles.size, 3, '应至少覆盖 3 个不同文件');
  assert.ok(highFiles.has('src/a.ts') && highFiles.has('src/b.ts') && highFiles.has('src/c.ts'));

  // 场景二：topScore < floor，使用 secondaryFloor = floor * ratio (0.125) 回填多样性，低于 0.125 不补
  const lowCandidates = [
    makeChunk('src/a.ts', 0, 0.22),
    makeChunk('src/b.ts', 0, 0.18),
    makeChunk('src/c.ts', 0, 0.1), // 低于 0.125
  ];
  const lowSeeds = service.applySmartCutoff(lowCandidates, callChainPlan);
  assert.deepEqual(
    lowSeeds.map((s) => s.filePath),
    ['src/a.ts', 'src/b.ts'],
  );
});
