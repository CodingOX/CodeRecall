import assert from 'node:assert/strict';
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { resetEmbeddingClient, resetRateLimitController } from '../../src/api/embedding.js';
import {
  batchDelete,
  clear,
  closeDb,
  completeDeletions,
  generateProjectId,
  getAllPaths,
  getPendingDeletions,
  initDb,
} from '../../src/db/index.js';
import { closeAllIndexers, getIndexer } from '../../src/indexer/index.js';
import { scan } from '../../src/scanner/index.js';
import type { ProcessResult } from '../../src/scanner/processor.js';
import { getProjectDataDir } from '../../src/utils/paths.js';
import {
  type ChunkRecord,
  closeAllVectorStores,
  VectorStore,
} from '../../src/vectorStore/index.js';

function makeChunkRecord(
  filePath: string,
  fileHash: string,
  chunkIndex: number,
  vector = [0.1, 0.2, 0.3],
): ChunkRecord {
  return {
    chunk_id: `${filePath}#${fileHash}#${chunkIndex}`,
    file_path: filePath,
    file_hash: fileHash,
    chunk_index: chunkIndex,
    vector,
    display_code: `export const v_${chunkIndex} = ${chunkIndex};`,
    vector_text: `${filePath}\nexport const v_${chunkIndex} = ${chunkIndex};`,
    language: 'typescript',
    breadcrumb: filePath,
    start_index: chunkIndex * 20,
    end_index: chunkIndex * 20 + 15,
    raw_start: chunkIndex * 20,
    raw_end: chunkIndex * 20 + 15,
    vec_start: chunkIndex * 20,
    vec_end: chunkIndex * 20 + 15,
  };
}

async function withMockEmbeddingEnv<T>(fn: () => Promise<T>): Promise<T> {
  const prevProvider = process.env.EMBEDDINGS_PROVIDER;
  const prevApiKey = process.env.EMBEDDINGS_API_KEY;
  const prevApiKeys = process.env.EMBEDDINGS_API_KEYS;
  const prevBaseUrl = process.env.EMBEDDINGS_BASE_URL;
  const prevModel = process.env.EMBEDDINGS_MODEL;
  const prevDimensions = process.env.EMBEDDINGS_DIMENSIONS;
  const prevMaxConcurrency = process.env.EMBEDDINGS_MAX_CONCURRENCY;
  const prevMaxRpm = process.env.EMBEDDINGS_MAX_RPM;
  const prevMaxTpm = process.env.EMBEDDINGS_MAX_TPM;
  const prevKeyMaxConcurrencies = process.env.EMBEDDINGS_KEY_MAX_CONCURRENCIES;
  const prevKeyMaxRpms = process.env.EMBEDDINGS_KEY_MAX_RPMS;
  const prevKeyMaxTpms = process.env.EMBEDDINGS_KEY_MAX_TPMS;
  const originalFetch = globalThis.fetch;

  process.env.EMBEDDINGS_PROVIDER = 'remote';
  process.env.EMBEDDINGS_API_KEY = 'test-storage-key';
  process.env.EMBEDDINGS_API_KEYS = 'test-storage-key';
  process.env.EMBEDDINGS_BASE_URL = 'https://example.com/embeddings';
  process.env.EMBEDDINGS_MODEL = 'test-embedding-model';
  process.env.EMBEDDINGS_DIMENSIONS = '3';
  process.env.EMBEDDINGS_MAX_CONCURRENCY = '2';
  process.env.EMBEDDINGS_MAX_RPM = '2000';
  process.env.EMBEDDINGS_MAX_TPM = '500000';
  delete process.env.EMBEDDINGS_KEY_MAX_CONCURRENCIES;
  delete process.env.EMBEDDINGS_KEY_MAX_RPMS;
  delete process.env.EMBEDDINGS_KEY_MAX_TPMS;

  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    const parsed = JSON.parse(String(init?.body ?? '{}')) as { input?: string[] };
    const texts = Array.isArray(parsed.input) ? parsed.input : [];
    return new Response(
      JSON.stringify({
        object: 'list',
        data: texts.map((_, index) => ({
          object: 'embedding',
          index,
          embedding: [0.1, 0.2, 0.3],
        })),
        model: 'test-embedding-model',
        usage: { prompt_tokens: texts.length, total_tokens: texts.length },
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  }) as typeof globalThis.fetch;

  try {
    resetEmbeddingClient();
    resetRateLimitController();
    return await fn();
  } finally {
    globalThis.fetch = originalFetch;
    if (prevProvider === undefined) delete process.env.EMBEDDINGS_PROVIDER;
    else process.env.EMBEDDINGS_PROVIDER = prevProvider;
    if (prevApiKey === undefined) delete process.env.EMBEDDINGS_API_KEY;
    else process.env.EMBEDDINGS_API_KEY = prevApiKey;
    if (prevApiKeys === undefined) delete process.env.EMBEDDINGS_API_KEYS;
    else process.env.EMBEDDINGS_API_KEYS = prevApiKeys;
    if (prevBaseUrl === undefined) delete process.env.EMBEDDINGS_BASE_URL;
    else process.env.EMBEDDINGS_BASE_URL = prevBaseUrl;
    if (prevModel === undefined) delete process.env.EMBEDDINGS_MODEL;
    else process.env.EMBEDDINGS_MODEL = prevModel;
    if (prevDimensions === undefined) delete process.env.EMBEDDINGS_DIMENSIONS;
    else process.env.EMBEDDINGS_DIMENSIONS = prevDimensions;
    if (prevMaxConcurrency === undefined) delete process.env.EMBEDDINGS_MAX_CONCURRENCY;
    else process.env.EMBEDDINGS_MAX_CONCURRENCY = prevMaxConcurrency;
    if (prevMaxRpm === undefined) delete process.env.EMBEDDINGS_MAX_RPM;
    else process.env.EMBEDDINGS_MAX_RPM = prevMaxRpm;
    if (prevMaxTpm === undefined) delete process.env.EMBEDDINGS_MAX_TPM;
    else process.env.EMBEDDINGS_MAX_TPM = prevMaxTpm;
    if (prevKeyMaxConcurrencies === undefined) delete process.env.EMBEDDINGS_KEY_MAX_CONCURRENCIES;
    else process.env.EMBEDDINGS_KEY_MAX_CONCURRENCIES = prevKeyMaxConcurrencies;
    if (prevKeyMaxRpms === undefined) delete process.env.EMBEDDINGS_KEY_MAX_RPMS;
    else process.env.EMBEDDINGS_KEY_MAX_RPMS = prevKeyMaxRpms;
    if (prevKeyMaxTpms === undefined) delete process.env.EMBEDDINGS_KEY_MAX_TPMS;
    else process.env.EMBEDDINGS_KEY_MAX_TPMS = prevKeyMaxTpms;
    resetEmbeddingClient();
    resetRateLimitController();
  }
}

test('generateProjectId 在尾随斜杠、符号链接与大小写变体下保持一致，且不同目录区分开', async () => {
  const tempBase = await fs.mkdtemp(path.join(os.tmpdir(), 'coderecall-project-id-'));

  try {
    const dirA = path.join(tempBase, 'ProjectAlpha');
    const dirB = path.join(tempBase, 'ProjectBeta');
    const linkA = path.join(tempBase, 'ProjectAlphaLink');

    await fs.mkdir(dirA);
    await fs.mkdir(dirB);
    await fs.symlink(dirA, linkA, 'dir');

    const idA = generateProjectId(dirA);
    const idB = generateProjectId(dirB);

    assert.equal(idA.length, 10);
    assert.notEqual(idA, idB, '不同目录应生成不同 projectId');
    assert.equal(generateProjectId(`${dirA}/`), idA, '单尾随斜杠不应改变 projectId');
    assert.equal(generateProjectId(`${dirA}//`), idA, '多尾随斜杠不应改变 projectId');
    assert.equal(
      generateProjectId(path.join(dirA, '.', '..', 'ProjectAlpha')),
      idA,
      '相对段路径应规范化为同一 projectId',
    );
    assert.equal(generateProjectId(linkA), idA, '符号链接应解析到真实目录的同一 projectId');

    // 仅当底层文件系统为大小写不敏感（同一 dev + ino）时验证大小写变体
    const lowerDirA = path.join(tempBase, 'projectalpha');
    let isCaseInsensitive = false;
    try {
      const realStat = fsSync.statSync(dirA);
      const lowerStat = fsSync.statSync(lowerDirA);
      isCaseInsensitive = realStat.dev === lowerStat.dev && realStat.ino === lowerStat.ino;
    } catch {
      isCaseInsensitive = false;
    }

    if (isCaseInsensitive) {
      assert.equal(generateProjectId(lowerDirA), idA, '大小写不敏感文件系统应折叠小写变体');
      assert.equal(
        generateProjectId(path.join(tempBase, 'PROJECTALPHA')),
        idA,
        '大小写不敏感文件系统应折叠大写变体',
      );
    }

    // 不存在的目录应平稳回退到 resolved 路径
    const missingDir = path.join(tempBase, 'DoesNotExistYet');
    assert.equal(
      generateProjectId(missingDir),
      generateProjectId(`${missingDir}/`),
      '不存在目录也应稳定处理尾随斜杠',
    );
    assert.notEqual(generateProjectId(missingDir), idA);
  } finally {
    await fs.rm(tempBase, { recursive: true, force: true });
  }
});

test('VectorStore.upsertFile 与 batchUpsertFiles 重复写入同 hash 幂等且 0 chunk 会清理旧向量', async () => {
  const projectId = `vector-idempotency-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
  const store = new VectorStore(projectId, 3);

  try {
    await store.init();

    const aHash1 = 'hash-a-1';
    const aRecords1 = [
      makeChunkRecord('src/a.ts', aHash1, 0),
      makeChunkRecord('src/a.ts', aHash1, 1),
    ];

    // 重复调用 upsertFile 多次
    await store.upsertFile('src/a.ts', aHash1, aRecords1);
    await store.upsertFile('src/a.ts', aHash1, aRecords1);
    await store.upsertFile('src/a.ts', aHash1, aRecords1);

    assert.equal(await store.count(), 2, '同 hash 重复 upsertFile 不得产生重复行');
    assert.equal((await store.getFileChunks('src/a.ts')).length, 2);

    // 升级到新 hash 并再次重复写入
    const aHash2 = 'hash-a-2';
    const aRecords2 = [makeChunkRecord('src/a.ts', aHash2, 0)];
    await store.upsertFile('src/a.ts', aHash2, aRecords2);
    await store.upsertFile('src/a.ts', aHash2, aRecords2);

    assert.equal(await store.count(), 1);
    const updatedChunks = await store.getFileChunks('src/a.ts');
    assert.equal(updatedChunks.length, 1);
    assert.equal(updatedChunks[0].file_hash, aHash2);

    // batchUpsertFiles 幂等性验证
    const bHash1 = 'hash-b-1';
    const bRecords1 = [makeChunkRecord('src/b.ts', bHash1, 0)];
    await store.batchUpsertFiles([
      { path: 'src/a.ts', hash: aHash2, records: aRecords2 },
      { path: 'src/b.ts', hash: bHash1, records: bRecords1 },
    ]);
    await store.batchUpsertFiles([
      { path: 'src/a.ts', hash: aHash2, records: aRecords2 },
      { path: 'src/b.ts', hash: bHash1, records: bRecords1 },
    ]);

    assert.equal(await store.count(), 2, '同 hash 重复 batchUpsertFiles 不得产生重复行');

    // 同批次中 src/b.ts 缩减为 0 chunk，src/a.ts 保持不变
    await store.batchUpsertFiles([
      { path: 'src/a.ts', hash: aHash2, records: aRecords2 },
      { path: 'src/b.ts', hash: 'hash-b-empty', records: [] },
    ]);

    assert.equal(await store.count(), 1, '0 chunk 文件应从 LanceDB 清除旧向量');
    assert.equal((await store.getFileChunks('src/a.ts')).length, 1);
    assert.equal((await store.getFileChunks('src/b.ts')).length, 0);
  } finally {
    await store.close();
    await fs.rm(getProjectDataDir(projectId), { recursive: true, force: true });
  }
});

test('pending_deletions 支持 vectorIndex: false 延迟删除并在后续 scan 中完成 LanceDB 与 chunks_fts 清理', async () => {
  const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'coderecall-pending-del-'));
  const projectId = generateProjectId(repoRoot);

  try {
    await fs.writeFile(
      path.join(repoRoot, 'a.ts'),
      'export function alphaFn(): number { return 101; }\n',
      'utf8',
    );
    await fs.writeFile(
      path.join(repoRoot, 'b.ts'),
      'export function betaFn(): number { return 202; }\n',
      'utf8',
    );

    await withMockEmbeddingEnv(async () => {
      // 1. 首次全量扫描（启用向量索引）
      const firstStats = await scan(repoRoot, { vectorIndex: true });
      assert.equal(firstStats.added, 2);
      assert.equal(firstStats.vectorIndex?.indexed, 2);

      // 2. 删除 a.ts 并执行仅元数据扫描（vectorIndex: false）
      await fs.rm(path.join(repoRoot, 'a.ts'));
      const metaOnlyStats = await scan(repoRoot, { vectorIndex: false });
      assert.equal(metaOnlyStats.deleted, 1);
      assert.equal(metaOnlyStats.vectorIndex, undefined);

      // 验证 pending_deletions 已持久化，但 LanceDB 与 chunks_fts 尚未清理
      const dbMid = initDb(projectId);
      const storeMid = new VectorStore(projectId, 3);
      try {
        await storeMid.init();
        assert.deepEqual(getPendingDeletions(dbMid), ['a.ts']);
        assert.deepEqual(getAllPaths(dbMid), ['b.ts']);
        assert.ok(
          (await storeMid.getFileChunks('a.ts')).length > 0,
          'vectorIndex: false 时旧向量应暂时保留等待恢复',
        );
        const ftsMid = dbMid
          .prepare('SELECT COUNT(*) as c FROM chunks_fts WHERE file_path = ?')
          .get('a.ts') as { c: number };
        assert.ok(ftsMid.c > 0, 'vectorIndex: false 时 chunks_fts 尚未清理');
      } finally {
        await storeMid.close();
        closeDb(dbMid);
      }

      // 3. 再次执行启用向量的 scan，自动合并 pending_deletions 并完成彻底清理
      const recoveryStats = await scan(repoRoot, { vectorIndex: true });
      assert.equal(recoveryStats.deleted, 0, 'files 表已提前删除，本轮扫描新删除数为 0');
      assert.equal(
        recoveryStats.vectorIndex?.deleted,
        1,
        '应从 pending_deletions 恢复清理 1 个文件',
      );

      const dbAfter = initDb(projectId);
      const storeAfter = new VectorStore(projectId, 3);
      try {
        await storeAfter.init();
        assert.deepEqual(getPendingDeletions(dbAfter), [], '恢复清理后 pending_deletions 应清空');
        assert.equal((await storeAfter.getFileChunks('a.ts')).length, 0, 'a.ts 向量应已删除');
        assert.ok((await storeAfter.getFileChunks('b.ts')).length > 0, 'b.ts 向量应保留');

        const ftsAfterA = dbAfter
          .prepare('SELECT COUNT(*) as c FROM chunks_fts WHERE file_path = ?')
          .get('a.ts') as { c: number };
        const ftsAfterB = dbAfter
          .prepare('SELECT COUNT(*) as c FROM chunks_fts WHERE file_path = ?')
          .get('b.ts') as { c: number };
        assert.equal(ftsAfterA.c, 0, 'a.ts chunks_fts 应已删除');
        assert.ok(ftsAfterB.c > 0, 'b.ts chunks_fts 应保留');
      } finally {
        await storeAfter.close();
        closeDb(dbAfter);
      }

      // 4. 验证已索引文件变成二进制（status=skipped）后也会被彻底清理
      await fs.writeFile(path.join(repoRoot, 'b.ts'), Buffer.from([0x62, 0x00, 0x69, 0x6e]));
      const skippedStats = await scan(repoRoot, { vectorIndex: true });
      assert.equal(skippedStats.skipped, 1);
      assert.equal(skippedStats.deleted, 1);
      assert.equal(skippedStats.vectorIndex?.deleted, 1);

      const dbFinal = initDb(projectId);
      const storeFinal = new VectorStore(projectId, 3);
      try {
        await storeFinal.init();
        assert.deepEqual(getAllPaths(dbFinal), []);
        assert.deepEqual(getPendingDeletions(dbFinal), []);
        assert.equal(await storeFinal.count(), 0);
        const ftsFinal = dbFinal.prepare('SELECT COUNT(*) as c FROM chunks_fts').get() as {
          c: number;
        };
        assert.equal(ftsFinal.c, 0);
      } finally {
        await storeFinal.close();
        closeDb(dbFinal);
      }
    });
  } finally {
    closeAllIndexers();
    await closeAllVectorStores();
    await fs.rm(repoRoot, { recursive: true, force: true });
    await fs.rm(getProjectDataDir(projectId), { recursive: true, force: true });
  }
});

test('indexer.indexFiles 与 clear/empty-array 边界下 pending_deletions 行为正确', async () => {
  const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'coderecall-pending-idx-'));
  const projectId = generateProjectId(repoRoot);

  try {
    await fs.writeFile(path.join(repoRoot, 'solo.ts'), 'export const soloValue = 42;\n', 'utf8');

    await withMockEmbeddingEnv(async () => {
      await scan(repoRoot, { vectorIndex: true });
      await fs.rm(path.join(repoRoot, 'solo.ts'));
      await scan(repoRoot, { vectorIndex: false });

      const db = initDb(projectId);
      try {
        // 空数组边界应安全跳过
        batchDelete(db, []);
        completeDeletions(db, []);
        assert.deepEqual(getPendingDeletions(db), ['solo.ts']);

        const indexer = await getIndexer(projectId, 3);
        const pendingResults: ProcessResult[] = getPendingDeletions(db).map((relPath) => ({
          absPath: '',
          relPath,
          hash: '',
          content: null,
          chunks: [],
          language: '',
          mtime: 0,
          size: 0,
          status: 'deleted',
        }));

        const idxStats = await indexer.indexFiles(db, pendingResults);
        assert.equal(idxStats.deleted, 1);
        assert.deepEqual(getPendingDeletions(db), []);

        // 写入 pending_deletions 后调用 clear(db) 也应清空 pending_deletions
        batchDelete(db, ['ghost.ts']);
        assert.deepEqual(getPendingDeletions(db), ['ghost.ts']);
        clear(db);
        assert.deepEqual(getPendingDeletions(db), []);
      } finally {
        closeDb(db);
      }
    });
  } finally {
    closeAllIndexers();
    await closeAllVectorStores();
    await fs.rm(repoRoot, { recursive: true, force: true });
    await fs.rm(getProjectDataDir(projectId), { recursive: true, force: true });
  }
});
