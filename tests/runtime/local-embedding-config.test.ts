import assert from 'node:assert/strict';
import test from 'node:test';
import {
  checkEmbeddingEnv,
  getEmbeddingDimensions,
  getEmbeddingProvider,
  getEmbeddingSpace,
  getLocalEmbeddingConfig,
} from '../../src/config.js';
import { DEFAULT_LOCAL_MODEL_ID, isLocalModelId } from '../../src/models/catalog.js';
import { updateEnvContent } from '../../src/models/index.js';

const MANAGED_ENV_KEYS = [
  'EMBEDDINGS_PROVIDER',
  'EMBEDDINGS_API_KEY',
  'EMBEDDINGS_API_KEYS',
  'EMBEDDINGS_BASE_URL',
  'EMBEDDINGS_MODEL',
  'EMBEDDINGS_DIMENSIONS',
] as const;

function runWithEnv(overrides: Record<string, string | undefined>, fn: () => void): void {
  const snapshot = new Map<string, string | undefined>();
  for (const key of MANAGED_ENV_KEYS) {
    snapshot.set(key, process.env[key]);
    delete process.env[key];
  }
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    fn();
  } finally {
    for (const key of MANAGED_ENV_KEYS) {
      const prev = snapshot.get(key);
      if (prev === undefined) delete process.env[key];
      else process.env[key] = prev;
    }
  }
}

test('未声明 provider 时保持远程', { concurrency: false }, () => {
  runWithEnv({}, () => {
    assert.equal(getEmbeddingProvider(), 'remote');
  });
});

test('local 不要求 API Key，并使用目录里的固定维度', { concurrency: false }, () => {
  runWithEnv({ EMBEDDINGS_PROVIDER: 'local' }, () => {
    assert.equal(checkEmbeddingEnv().isValid, true);
    assert.equal(getEmbeddingDimensions(), 1024);
    const space = getEmbeddingSpace();
    assert.equal(space.provider, 'local');
    assert.equal(space.model, DEFAULT_LOCAL_MODEL_ID);
    assert.match(space.spaceId, /^local:qwen3-embedding-0\.6b:/);
    assert.equal(getLocalEmbeddingConfig().maxContextTokens, 32768);
  });
});

test('local 拒绝未知模型，远程模型名不能直接当本地模型', { concurrency: false }, () => {
  runWithEnv({ EMBEDDINGS_PROVIDER: 'local', EMBEDDINGS_MODEL: 'BAAI/bge-m3' }, () => {
    assert.equal(checkEmbeddingEnv().isValid, false);
    assert.equal(isLocalModelId('BAAI/bge-m3'), false);
    assert.throws(() => getEmbeddingSpace(), /未知的本地 Embedding 模型/);
  });
});

test('同一本地模型空间稳定，换模型后空间标识变化', { concurrency: false }, () => {
  runWithEnv({ EMBEDDINGS_PROVIDER: 'local', EMBEDDINGS_MODEL: 'qwen3-embedding-0.6b' }, () => {
    const qwen = getEmbeddingSpace().spaceId;
    process.env.EMBEDDINGS_MODEL = 'jina-embeddings-v2-base-code';
    const jina = getEmbeddingSpace();
    assert.notEqual(jina.spaceId, qwen);
    assert.equal(jina.dimensions, 768);
  });
});

test('未知 provider 直接报错', { concurrency: false }, () => {
  runWithEnv({ EMBEDDINGS_PROVIDER: 'ollama' }, () => {
    assert.throws(() => getEmbeddingProvider(), /未知的 EMBEDDINGS_PROVIDER/);
  });
});

test('启用本地模型时只改 provider、模型和维度', () => {
  const next = updateEnvContent(
    'EMBEDDINGS_API_KEYS=secret\nEMBEDDINGS_MODEL=BAAI/bge-m3\n# keep\n',
    {
      EMBEDDINGS_PROVIDER: 'local',
      EMBEDDINGS_MODEL: 'qwen3-embedding-0.6b',
      EMBEDDINGS_DIMENSIONS: '1024',
    },
  );
  assert.match(next, /EMBEDDINGS_API_KEYS=secret/);
  assert.match(next, /EMBEDDINGS_PROVIDER=local/);
  assert.match(next, /EMBEDDINGS_MODEL=qwen3-embedding-0\.6b/);
  assert.match(next, /EMBEDDINGS_DIMENSIONS=1024/);
  assert.match(next, /# keep/);
});
