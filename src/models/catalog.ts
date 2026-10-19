/**
 * 内置本地 Embedding 模型目录。
 *
 * 模型 ID、仓库、revision 和推理规则全部固定在这里。
 * CLI 不接受任意模型路径，避免配置漂移后新旧向量混用。
 */

const MODEL_CATALOG = {
  'jina-embeddings-v2-base-code': {
    displayName: 'jina-embeddings-v2-base-code',
    parameterSize: '161M',
    repo: 'jinaai/jina-embeddings-v2-base-code',
    revision: '516f4baf13dec4ddddda8631e019b5737c8bc250',
    dtype: 'q8',
    dimensions: 768,
    maxContextTokens: 8192,
    runtime: 'feature-extraction',
    pooling: 'mean',
    queryPrefix: '',
    documentPrefix: '',
    documentInputSpaceVersion: 'jina-mean-v1',
    license: 'Apache-2.0',
  },
  'embeddinggemma-300m': {
    displayName: 'EmbeddingGemma-300M',
    parameterSize: '300M',
    repo: 'onnx-community/embeddinggemma-300m-ONNX',
    revision: '5090578d9565bb06545b4552f76e6bc2c93e4a66',
    dtype: 'q8',
    dimensions: 768,
    maxContextTokens: 2048,
    runtime: 'sentence-embedding',
    pooling: 'sentence_embedding',
    queryPrefix: 'task: code retrieval | query: ',
    documentPrefix: 'title: none | text: ',
    documentInputSpaceVersion: 'embeddinggemma-code-retrieval-v1',
    license: 'Gemma license',
  },
  'qwen3-embedding-0.6b': {
    displayName: 'Qwen3-Embedding-0.6B',
    parameterSize: '600M',
    repo: 'onnx-community/Qwen3-Embedding-0.6B-ONNX',
    revision: 'c25a394dd583836952667c12f008335071b3f43d',
    dtype: 'q8',
    dimensions: 1024,
    maxContextTokens: 32768,
    runtime: 'feature-extraction',
    pooling: 'last_token',
    queryPrefix:
      'Instruct: Given a code search query, retrieve relevant code snippets that answer the query\nQuery:',
    documentPrefix: '',
    documentInputSpaceVersion: 'qwen3-last-token-v1',
    license: 'Apache-2.0',
  },
} as const;

export type LocalModelId = keyof typeof MODEL_CATALOG;

export type LocalModelDefinition = {
  id: LocalModelId;
} & (typeof MODEL_CATALOG)[LocalModelId];

/** 默认本地模型：1024 维，和当前远程 bge-m3 的维度一致。 */
export const DEFAULT_LOCAL_MODEL_ID: LocalModelId = 'qwen3-embedding-0.6b';
export const LOCAL_MODEL_IDS = Object.keys(MODEL_CATALOG) as LocalModelId[];

export function listLocalModels(): LocalModelDefinition[] {
  return LOCAL_MODEL_IDS.map((id) => getLocalModelDefinition(id));
}

export function isLocalModelId(value: string | undefined | null): value is LocalModelId {
  return typeof value === 'string' && Object.hasOwn(MODEL_CATALOG, value);
}

export function getLocalModelDefinition(model: string): LocalModelDefinition {
  if (!isLocalModelId(model)) {
    throw new Error(`未知的本地 Embedding 模型: ${model}。可选值: ${LOCAL_MODEL_IDS.join(', ')}`);
  }
  return { id: model, ...MODEL_CATALOG[model] };
}
