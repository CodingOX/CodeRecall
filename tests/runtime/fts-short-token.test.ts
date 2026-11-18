import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';
import { closeDb, initDb } from '../../src/db/index.js';
import {
  batchUpsertChunkFts,
  batchUpsertFileFts,
  initChunksFts,
  initFilesFts,
  searchChunksFts,
  searchFilesFts,
  segmentQuery,
} from '../../src/search/fts.js';
import { getProjectDataDir } from '../../src/utils/paths.js';

function createTempProjectId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
}

test('segmentQuery 应提取 3~8 字连续汉字短语以命中 trigram', () => {
  const statusTokens = segmentQuery('索引状态');
  assert.ok(
    statusTokens.includes('索引状态'),
    `应包含完整短语 "索引状态": ${statusTokens.join(', ')}`,
  );

  const lockTokens = segmentQuery('进程锁');
  assert.ok(lockTokens.includes('进程锁'), `应包含完整短语 "进程锁": ${lockTokens.join(', ')}`);
});

test('chunks_fts trigram 模式应命中中文连续短语并在混合短词时不被误杀', async () => {
  const projectId = createTempProjectId('fts-trigram-phrase');
  const db = initDb(projectId);

  try {
    initChunksFts(db);
    batchUpsertChunkFts(db, [
      {
        chunkId: 'src/lock.ts#h#0',
        filePath: 'src/lock.ts',
        chunkIndex: 0,
        symbolTokens: 'withLock',
        breadcrumb: 'src/lock.ts > withLock',
        body: 'export function withLock() { /* 进程锁保护 */ }',
        comments: '',
      },
      {
        chunkId: 'src/indexer.ts#h#0',
        filePath: 'src/indexer.ts',
        chunkIndex: 0,
        symbolTokens: 'SearchService',
        breadcrumb: 'src/indexer.ts > syncIndexState',
        body: 'const state = "索引状态"; // SearchService 锁状态',
        comments: '',
      },
    ]);

    const lockHits = searchChunksFts(db, '进程锁', 5);
    assert.equal(lockHits.length, 1);
    assert.equal(lockHits[0].filePath, 'src/lock.ts');

    const statusHits = searchChunksFts(db, '索引状态', 5);
    assert.equal(statusHits.length, 1);
    assert.equal(statusHits[0].filePath, 'src/indexer.ts');

    // 混合 >=3 字符与 <3 字符词元时，trigram MATCH 应仅使用 >=3 字符词元（避免 AND 零命中）
    const mixedHits = searchChunksFts(db, 'SearchService 锁', 5);
    assert.equal(mixedHits.length, 1);
    assert.equal(mixedHits[0].filePath, 'src/indexer.ts');
  } finally {
    closeDb(db);
    await fs.rm(getProjectDataDir(projectId), { recursive: true, force: true });
  }
});

test('chunks_fts 纯短词查询应按字段权重子串兜底并遵守语言过滤', async () => {
  const projectId = createTempProjectId('fts-short-chunks');
  const db = initDb(projectId);

  try {
    initChunksFts(db);
    db.prepare(
      'INSERT OR REPLACE INTO files (path, hash, mtime, size, content, language) VALUES (?, ?, ?, ?, ?, ?)',
    ).run('src/symbol.ts', 'h1', 1, 10, 'const db = 1;', 'typescript');
    db.prepare(
      'INSERT OR REPLACE INTO files (path, hash, mtime, size, content, language) VALUES (?, ?, ?, ?, ?, ?)',
    ).run('src/comment.ts', 'h2', 1, 10, '// db', 'typescript');
    db.prepare(
      'INSERT OR REPLACE INTO files (path, hash, mtime, size, content, language) VALUES (?, ?, ?, ?, ?, ?)',
    ).run('docs/db.md', 'h3', 1, 10, 'db notes', 'markdown');

    batchUpsertChunkFts(db, [
      {
        chunkId: 'src/comment.ts#h#0',
        filePath: 'src/comment.ts',
        chunkIndex: 0,
        symbolTokens: '',
        breadcrumb: 'src/comment.ts',
        body: 'const x = 1;',
        comments: '// db comment',
      },
      {
        chunkId: 'src/symbol.ts#h#0',
        filePath: 'src/symbol.ts',
        chunkIndex: 0,
        symbolTokens: 'db',
        breadcrumb: 'src/symbol.ts > db',
        body: 'export const db = {};',
        comments: '',
      },
      {
        chunkId: 'docs/db.md#h#0',
        filePath: 'docs/db.md',
        chunkIndex: 0,
        symbolTokens: 'db',
        breadcrumb: 'docs/db.md',
        body: 'db documentation',
        comments: '',
      },
    ]);

    const tsHits = searchChunksFts(db, 'db', 10, ['typescript']);
    assert.equal(tsHits.length, 2, '应仅保留 typescript 文件结果');
    assert.equal(tsHits[0].filePath, 'src/symbol.ts', 'symbol_tokens 权重应高于 comments');
    assert.ok(tsHits[0].score > tsHits[1].score);

    const injectedHits = searchChunksFts(db, 'db', 10, ["ts' OR 1=1 --"]);
    assert.deepEqual(injectedHits, [], '单引号语言名不得破坏 SQL 过滤');
  } finally {
    closeDb(db);
    await fs.rm(getProjectDataDir(projectId), { recursive: true, force: true });
  }
});

test('files_fts 纯短词查询应兜底命中并遵守语言过滤', async () => {
  const projectId = createTempProjectId('fts-short-files');
  const db = initDb(projectId);

  try {
    initFilesFts(db);
    db.prepare(
      'INSERT OR REPLACE INTO files (path, hash, mtime, size, content, language) VALUES (?, ?, ?, ?, ?, ?)',
    ).run('src/lock.ts', 'h1', 1, 20, 'export function acquire() { /* 锁 */ }', 'typescript');
    db.prepare(
      'INSERT OR REPLACE INTO files (path, hash, mtime, size, content, language) VALUES (?, ?, ?, ?, ?, ?)',
    ).run('README.md', 'h2', 1, 20, '关于锁的说明', 'markdown');

    batchUpsertFileFts(db, [
      { path: 'src/lock.ts', content: 'export function acquire() { /* 锁 */ }' },
      { path: 'README.md', content: '关于锁的说明' },
    ]);

    const allHits = searchFilesFts(db, '锁', 10);
    assert.equal(allHits.length, 2);

    const tsOnly = searchFilesFts(db, '锁', 10, ['typescript']);
    assert.equal(tsOnly.length, 1);
    assert.equal(tsOnly[0].path, 'src/lock.ts');
  } finally {
    closeDb(db);
    await fs.rm(getProjectDataDir(projectId), { recursive: true, force: true });
  }
});
