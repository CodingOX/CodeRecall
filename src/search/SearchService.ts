/**
 * SearchService - 搜索服务
 *
 * Phase 0: 向量召回 + Rerank
 * Phase 1: 添加词法召回 + RRF 融合
 * Phase 2: 上下文扩展（邻居/breadcrumb/import）
 *
 * - buildContextPack(): 用于问答/生成的上下文包
 */

import type Database from 'better-sqlite3';
import { getRerankerClient } from '../api/reranker.js';
import { getEmbeddingDimensions } from '../config.js';
import { initDb } from '../db/index.js';
import { closeIndexer, getIndexer, type Indexer } from '../indexer/index.js';
import { getLanguage } from '../scanner/language.js';
import { isDebugEnabled, logger } from '../utils/logger.js';
import type { SearchResult as VectorSearchResult } from '../vectorStore/index.js';
import { closeVectorStore, getVectorStore, type VectorStore } from '../vectorStore/index.js';
import { ContextPacker } from './ContextPacker.js';
import { DEFAULT_CONFIG } from './config.js';
import {
  isChunksFtsInitialized,
  isFtsInitialized,
  searchChunksFts,
  searchFilesFts,
  segmentQuery,
} from './fts.js';
import { getGraphExpander } from './GraphExpander.js';
import { searchPaths } from './PathRecall.js';
import { buildRetrievalPlan, type RetrievalPlan } from './RetrievalPlan.js';
import type {
  BuildContextPackOptions,
  ContextPack,
  QueryChannels,
  ScoredChunk,
  SearchConfig,
} from './types.js';

/**
 * 将 languageFilter 转换为 LanceDB WHERE 子句
 *
 * @param languages 语言白名单数组
 * @returns SQL WHERE 子句字符串，空数组或 undefined 返回 undefined
 */
export function buildLanguageWhereClause(languages?: string[]): string | undefined {
  if (!languages || languages.length === 0) {
    return undefined;
  }

  const escapeSqlString = (value: string): string => value.replace(/'/g, "''");

  if (languages.length === 1) {
    // 单语言: language = 'typescript'
    return `language = '${escapeSqlString(languages[0])}'`;
  }

  // 多语言: language IN ('typescript', 'javascript', 'python')
  const escapedLangs = languages.map((lang) => `'${escapeSqlString(lang)}'`).join(', ');
  return `language IN (${escapedLangs})`;
}

/**
 * 在融合后、Rerank 前按文件施加候选上限
 *
 * 输入应保持降序；函数会按原顺序稳定筛选，确保高分 chunk 优先保留。
 */
export function applyPreRerankPerFileCap(
  candidates: ScoredChunk[],
  perFileCap: number,
): ScoredChunk[] {
  if (perFileCap <= 0 || !Number.isFinite(perFileCap)) {
    return candidates;
  }

  const fileCounts = new Map<string, number>();
  const capped: ScoredChunk[] = [];

  for (const candidate of candidates) {
    const current = fileCounts.get(candidate.filePath) ?? 0;
    if (current >= perFileCap) {
      continue;
    }
    fileCounts.set(candidate.filePath, current + 1);
    capped.push(candidate);
  }

  return capped;
}

// ===========================================
// 性能优化：Token 边界 RegExp 缓存
// ===========================================

/** 缓存预编译的 token 边界正则表达式 */
const tokenBoundaryRegexCache = new Map<string, RegExp>();
const TOKEN_BOUNDARY_REGEX_CACHE_MAX = 1000;

/**
 * 获取或创建 token 边界正则表达式（带缓存）
 *
 * 避免每次 scoreChunkTokenOverlap 调用都创建 N 个 RegExp 对象
 */
function getTokenBoundaryRegex(token: string): RegExp {
  let regex = tokenBoundaryRegexCache.get(token);
  if (!regex) {
    // MCP 长驻进程会积累大量查询词，这里用简单 FIFO 上限避免缓存无限增长。
    if (tokenBoundaryRegexCache.size >= TOKEN_BOUNDARY_REGEX_CACHE_MAX) {
      const oldestKey = tokenBoundaryRegexCache.keys().next().value;
      if (oldestKey !== undefined) {
        tokenBoundaryRegexCache.delete(oldestKey);
      }
    }
    const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    regex = new RegExp(`\\b${escaped}\\b`);
    tokenBoundaryRegexCache.set(token, regex);
  }
  return regex;
}

export function getTokenBoundaryRegexForTest(token: string): RegExp {
  return getTokenBoundaryRegex(token);
}

export function __getTokenBoundaryRegexCacheSizeForTest(): number {
  return tokenBoundaryRegexCache.size;
}

export function __resetTokenBoundaryRegexCacheForTest(): void {
  tokenBoundaryRegexCache.clear();
}

export class SearchService {
  private projectId: string;
  private indexer: Indexer | null = null;
  private vectorStore: VectorStore | null = null;
  private db: Database.Database | null = null;
  private config: SearchConfig;

  constructor(projectId: string, _projectPath: string, config?: Partial<SearchConfig>) {
    this.projectId = projectId;
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  async init(): Promise<void> {
    const dimensions = getEmbeddingDimensions();
    this.indexer = await getIndexer(this.projectId, dimensions);
    this.vectorStore = await getVectorStore(this.projectId, dimensions);
    this.db = initDb(this.projectId);
  }

  /**
   * 释放搜索请求持有的本地资源。
   *
   * SearchService 会为 CLI/MCP 查询打开 SQLite 与向量库连接；长时间运行的 MCP
   * 进程必须在一次查询结束后显式释放，避免按项目累积连接与工厂缓存。
   */
  async close(): Promise<void> {
    if (this.db) {
      this.db.close();
      this.db = null;
    }

    if (this.vectorStore) {
      await this.vectorStore.close();
      this.vectorStore = null;
    }

    this.indexer = null;
    closeIndexer(this.projectId);
    await closeVectorStore(this.projectId);
    const { closeGraphExpander } = await import('./GraphExpander.js');
    closeGraphExpander(this.projectId);
  }

  // 公开接口

  /**
   * 构建上下文包（用于问答/生成）
   */
  async buildContextPack(
    query: string,
    channels?: Partial<QueryChannels>,
    options?: BuildContextPackOptions,
  ): Promise<ContextPack> {
    const timingMs: Record<string, number> = {};
    let t0 = Date.now();
    const filePathFilter = options?.filePathFilter;
    const languageWhereClause = buildLanguageWhereClause(options?.languageFilter);

    const vectorQuery = channels?.vectorQuery ?? query;
    const lexicalQuery = channels?.lexicalQuery ?? query;
    const rerankQuery = channels?.rerankQuery ?? query;

    const plan = buildRetrievalPlan(vectorQuery);

    // 1. 混合召回（按检索计划启用向量/词法/路径通道）
    const candidates = await this.hybridRetrieve(
      vectorQuery,
      lexicalQuery,
      languageWhereClause,
      options?.languageFilter,
      plan,
    );
    const filteredCandidates = filePathFilter
      ? candidates.filter((chunk) => filePathFilter(chunk.filePath))
      : candidates;
    timingMs.retrieve = Date.now() - t0;

    // 2. 取 topM
    t0 = Date.now();
    const topM = filteredCandidates
      .sort((a, b) => b.score - a.score)
      .slice(0, this.config.fusedTopM);
    const cappedTopM = applyPreRerankPerFileCap(topM, this.config.preRerankPerFileCap);

    // 3. Rerank → seeds（失败时降级到融合结果）
    let reranked: ScoredChunk[];
    try {
      reranked = await this.rerank(rerankQuery, cappedTopM);
    } catch (error) {
      logger.warn(
        {
          error: error instanceof Error ? error.message : String(error),
        },
        'Rerank 不可用，降级到 RRF 融合结果',
      );
      reranked = cappedTopM;
    }
    timingMs.rerank = Date.now() - t0;

    // 4. Smart TopK Cutoff（含计划驱动的种子数上限与文件多样性保底）
    t0 = Date.now();
    const seeds = this.applySmartCutoff(reranked, plan);
    timingMs.smartCutoff = Date.now() - t0;

    // 5. 扩展（Phase 2 实现）
    t0 = Date.now();
    const queryTokens = this.extractQueryTokens(query);
    const expanded = await this.expand(seeds, queryTokens, plan);
    let filteredExpanded = filePathFilter
      ? expanded.filter((chunk) => filePathFilter(chunk.filePath))
      : expanded;

    const languageFilter = options?.languageFilter;
    if (languageFilter && languageFilter.length > 0) {
      const langSet = new Set(languageFilter);
      filteredExpanded = filteredExpanded.filter((chunk) =>
        langSet.has(getLanguage(chunk.filePath)),
      );
    }
    timingMs.expand = Date.now() - t0;

    // 6. 打包
    t0 = Date.now();
    const packer = new ContextPacker(this.projectId, this.config);
    const files = await packer.pack([...seeds, ...filteredExpanded]);
    timingMs.pack = Date.now() - t0;

    return {
      query,
      seeds,
      expanded: filteredExpanded,
      files,
      debug: {
        wVec: this.config.wVec,
        wLex: this.config.wLex,
        wPath: this.config.wPath,
        timingMs,
        plan,
      },
    };
  }

  // 召回方法

  /**
   * 混合召回：向量 + 词法 +（可选）路径
   */
  private async hybridRetrieve(
    vectorQuery: string,
    lexicalQuery: string,
    languageWhereClause?: string,
    languageFilter?: string[],
    plan?: RetrievalPlan,
  ): Promise<ScoredChunk[]> {
    const activePlan = plan ?? buildRetrievalPlan(vectorQuery);

    // 并行执行向量、词法和路径召回
    const [vectorResults, lexicalResults, pathResults] = await Promise.all([
      activePlan.useVector
        ? this.vectorRetrieve(vectorQuery, languageWhereClause)
        : Promise.resolve([]),
      activePlan.useLexical
        ? this.lexicalRetrieve(lexicalQuery, languageFilter)
        : Promise.resolve([]),
      activePlan.usePath && this.config.wPath > 0 && this.config.pathTopK > 0
        ? this.pathRetrieve(lexicalQuery, languageFilter)
        : Promise.resolve([]),
    ]);

    logger.debug(
      {
        intent: activePlan.intent,
        vectorCount: vectorResults.length,
        lexicalCount: lexicalResults.length,
        pathCount: pathResults.length,
      },
      '混合召回完成',
    );

    // 若词法与路径召回均无结果，直接返回向量结果
    if (lexicalResults.length === 0 && pathResults.length === 0) {
      return vectorResults;
    }

    // RRF 融合
    return this.fuse(vectorResults, lexicalResults, pathResults);
  }

  /**
   * 基于 SQLite 文件清单的路径召回，仅在路径/复合意图时启用
   */
  private async pathRetrieve(query: string, languageFilter?: string[]): Promise<ScoredChunk[]> {
    if (!this.db || !this.vectorStore) return [];
    const matches = searchPaths(this.db, query, this.config.pathTopK, languageFilter);
    if (matches.length === 0) return [];

    const chunksByFile = await this.vectorStore.getFilesChunks(
      matches.map((item) => item.filePath),
    );
    if (!chunksByFile) return [];

    const queryTokens = this.extractQueryTokens(query);
    const out: Array<ScoredChunk & { _rank: number }> = [];
    for (const match of matches) {
      const chunks = chunksByFile.get(match.filePath) ?? [];
      if (chunks.length === 0) continue;

      // 每个命中文件挑选与 query token 重合度最高的代表 chunk 进入融合
      const representative = [...chunks].sort(
        (a, b) =>
          this.scoreChunkTokenOverlap(b, queryTokens) -
            this.scoreChunkTokenOverlap(a, queryTokens) || a.chunk_index - b.chunk_index,
      )[0];

      out.push({
        filePath: representative.file_path,
        chunkIndex: representative.chunk_index,
        score: match.score,
        source: 'path',
        record: { ...representative, _distance: 0 },
        _rank: out.length,
      });
    }

    return out;
  }

  /**
   * 向量召回
   */
  private async vectorRetrieve(query: string, filter?: string): Promise<ScoredChunk[]> {
    if (!this.indexer) throw new Error('SearchService not initialized');

    const results = await this.indexer.textSearch(query, this.config.vectorTopK, filter);
    if (!results) return [];

    // 按距离排序并转换
    return results
      .sort((a, b) => a._distance - b._distance)
      .slice(0, this.config.vectorTopM)
      .map((r: VectorSearchResult, rank: number) => ({
        filePath: r.file_path,
        chunkIndex: r.chunk_index,
        score: 1 / (1 + r._distance), // 转为相似度（用于调试）
        source: 'vector' as const,
        record: r,
        _rank: rank, // 用于 RRF
      }));
  }

  /**
   * 词法召回（FTS）
   *
   * 优先使用 chunk 级 FTS（更精准）
   * 如果 chunks_fts 不可用，降级到文件级 FTS + overlap 下钻
   */
  private async lexicalRetrieve(query: string, languageFilter?: string[]): Promise<ScoredChunk[]> {
    if (!this.db || !this.vectorStore) return [];

    // 优先尝试 chunk 级 FTS（更精准）
    if (isChunksFtsInitialized(this.db)) {
      return this.lexicalRetrieveFromChunksFts(query, languageFilter);
    }

    // 降级到文件级 FTS + overlap 下钻
    if (isFtsInitialized(this.db)) {
      return this.lexicalRetrieveFromFilesFts(query, languageFilter);
    }

    logger.debug('FTS 未初始化，跳过词法召回');
    return [];
  }

  /**
   * 从 chunks_fts 直接搜索（最优方案）
   */
  private async lexicalRetrieveFromChunksFts(
    query: string,
    languageFilter?: string[],
  ): Promise<ScoredChunk[]> {
    const chunkResults = searchChunksFts(
      this.db as Database.Database,
      query,
      this.config.lexTotalChunks,
      languageFilter,
    );

    if (chunkResults.length === 0) {
      logger.debug('Chunk FTS 无命中');
      return [];
    }

    // 将 FTS 结果转换为 ScoredChunk，需要从 VectorStore 获取完整的 ChunkRecord
    const allChunks: ScoredChunk[] = [];

    // 按文件分组获取 chunks
    const fileChunksMap = new Map<string, Map<number, number>>(); // filePath -> (chunkIndex -> score)
    for (const result of chunkResults) {
      if (!fileChunksMap.has(result.filePath)) {
        fileChunksMap.set(result.filePath, new Map());
      }
      fileChunksMap.get(result.filePath)?.set(result.chunkIndex, result.score);
    }

    // 从 VectorStore 批量获取完整的 chunk 信息（性能优化：N 次查询 → 1 次）
    const allFilePaths = Array.from(fileChunksMap.keys());
    const chunksMap = await this.vectorStore?.getFilesChunks(allFilePaths);
    if (!chunksMap) return allChunks;

    for (const [filePath, chunkScores] of fileChunksMap) {
      const chunks = chunksMap.get(filePath) ?? [];

      for (const chunk of chunks) {
        const score = chunkScores.get(chunk.chunk_index);
        if (score !== undefined) {
          allChunks.push({
            filePath: chunk.file_path,
            chunkIndex: chunk.chunk_index,
            score,
            source: 'lexical' as const,
            record: { ...chunk, _distance: 0 },
          });
        }
      }
    }

    logger.debug(
      {
        totalChunks: allChunks.length,
        filesWithChunks: fileChunksMap.size,
      },
      'Chunk FTS 召回完成',
    );

    // 按 score 排序并分配 rank
    return allChunks
      .sort((a, b) => b.score - a.score)
      .map((chunk, rank) => ({ ...chunk, _rank: rank }));
  }

  /**
   * 从 files_fts 搜索 + overlap 下钻（降级方案）
   */
  private async lexicalRetrieveFromFilesFts(
    query: string,
    languageFilter?: string[],
  ): Promise<ScoredChunk[]> {
    // 1. FTS 搜索文件
    const fileResults = searchFilesFts(
      this.db as Database.Database,
      query,
      this.config.ftsTopKFiles,
      languageFilter,
    );
    if (fileResults.length === 0) {
      logger.debug('FTS 无命中文件');
      return [];
    }

    // 2. 提取查询 tokens（用于 chunk 级别打分）
    const queryTokens = this.extractQueryTokens(query);
    logger.debug(
      {
        fileCount: fileResults.length,
        queryTokens: Array.from(queryTokens).slice(0, 10),
      },
      'FTS 召回开始 chunk 选择',
    );

    // 3. 从 VectorStore 获取每个文件的 chunks，使用 token overlap 打分
    const allChunks: ScoredChunk[] = [];
    let totalChunks = 0;
    let skippedFiles = 0;
    const filePaths = fileResults.map((item) => item.path);
    const allFileChunksMap = await this.vectorStore?.getFilesChunks(filePaths);
    if (!allFileChunksMap) {
      return [];
    }

    for (const { path: filePath, score: fileScore } of fileResults) {
      if (totalChunks >= this.config.lexTotalChunks) break;
      const chunks = allFileChunksMap.get(filePath);
      if (!chunks || chunks.length === 0) continue;

      // 对每个 chunk 计算 token overlap 得分
      const scoredChunks = chunks.map((chunk) => ({
        chunk,
        overlapScore: this.scoreChunkTokenOverlap(chunk, queryTokens),
      }));

      // 阈值过滤：如果文件内所有 chunk 的 maxOverlap == 0，跳过该文件
      // 避免引入无关 chunk 噪声
      const maxOverlap = Math.max(...scoredChunks.map((c) => c.overlapScore));
      if (maxOverlap === 0) {
        skippedFiles++;
        continue;
      }

      // 按 overlap 得分降序排序，取 topK（只取 overlapScore > 0 的）
      const topChunks = scoredChunks
        .filter((c) => c.overlapScore > 0)
        .sort((a, b) => b.overlapScore - a.overlapScore)
        .slice(0, this.config.lexChunksPerFile);

      for (const { chunk, overlapScore } of topChunks) {
        if (totalChunks >= this.config.lexTotalChunks) break;

        // 综合得分 = 文件级 BM25 分数 * (1 + chunk 级 overlap 加成)
        const combinedScore = fileScore * (1 + overlapScore * 0.5);

        allChunks.push({
          filePath: chunk.file_path,
          chunkIndex: chunk.chunk_index,
          score: combinedScore,
          source: 'lexical' as const,
          record: { ...chunk, _distance: 0 },
        });
        totalChunks++;
      }
    }

    if (skippedFiles > 0) {
      logger.debug({ skippedFiles }, 'FTS 跳过 overlap=0 的文件');
    }

    logger.debug(
      {
        totalChunks: allChunks.length,
        filesWithChunks: new Set(allChunks.map((c) => c.filePath)).size,
      },
      'FTS chunk 选择完成',
    );

    // 按 score 排序并分配 rank
    return allChunks
      .sort((a, b) => b.score - a.score)
      .map((chunk, rank) => ({ ...chunk, _rank: rank }));
  }

  /**
   * 提取查询中的 tokens
   *
   * 直接复用 fts.ts 中的 segmentQuery，确保召回和评分逻辑一致
   */
  private extractQueryTokens(query: string): Set<string> {
    const tokens = segmentQuery(query);
    return new Set(tokens);
  }

  /**
   * 计算 chunk 与查询的 token overlap 得分
   *
   * 匹配策略：
   * - breadcrumb 和 display_code 都参与匹配
   * - 精确匹配得 1 分，子串匹配得 0.5 分
   */
  private scoreChunkTokenOverlap(
    chunk: { breadcrumb: string; display_code: string },
    queryTokens: Set<string>,
  ): number {
    const text = `${chunk.breadcrumb} ${chunk.display_code}`.toLowerCase();
    let score = 0;

    for (const token of queryTokens) {
      // 性能优化：先用 includes 快速判断，再用预编译的 RegExp 判断边界
      if (text.includes(token)) {
        // 精确匹配（作为完整单词）得更高分
        const regex = getTokenBoundaryRegex(token);
        if (regex.test(text)) {
          score += 1;
        } else {
          score += 0.5; // 子串匹配
        }
      }
    }

    return score;
  }

  // =========================================
  // 融合方法
  // =========================================

  /**
   * RRF (Reciprocal Rank Fusion) 融合
   *
   * 公式: score = Σ w_i / (k + rank_i)
   * 其中 k 是平滑常数，rank 从 0 开始
   */
  private fuse(
    vectorResults: (ScoredChunk & { _rank?: number })[],
    lexicalResults: (ScoredChunk & { _rank?: number })[],
    pathResults: (ScoredChunk & { _rank?: number })[] = [],
  ): ScoredChunk[] {
    const { rrfK0, wVec, wLex, wPath } = this.config;

    // 构建 chunk_id -> 融合分数 的映射
    const fusedScores = new Map<
      string,
      {
        score: number;
        chunk: ScoredChunk;
        sources: Set<string>;
      }
    >();

    // 辅助函数：生成唯一键
    const getKey = (chunk: ScoredChunk) => `${chunk.filePath}#${chunk.chunkIndex}`;

    const addChannel = (
      results: (ScoredChunk & { _rank?: number })[],
      weight: number,
      source: 'vector' | 'lexical' | 'path',
    ): void => {
      for (const result of results) {
        const key = getKey(result);
        const rank = result._rank ?? 0;
        const rrfScore = weight / (rrfK0 + rank);

        const existing = fusedScores.get(key);
        if (existing) {
          existing.score += rrfScore;
          existing.sources.add(source);
        } else {
          fusedScores.set(key, {
            score: rrfScore,
            chunk: result,
            sources: new Set([source]),
          });
        }
      }
    };

    addChannel(vectorResults, wVec, 'vector');
    addChannel(lexicalResults, wLex, 'lexical');
    addChannel(pathResults, wPath, 'path');

    // 转换为数组并按融合分数排序（保持多路命中标记为 both）
    const fused = Array.from(fusedScores.values())
      .map(({ score, chunk, sources }) => ({
        ...chunk,
        score,
        source: sources.size > 1 ? ('both' as const) : chunk.source,
      }))
      .sort((a, b) => b.score - a.score);

    // 惰性求值：避免生产环境下不必要的计算
    if (isDebugEnabled()) {
      logger.debug(
        {
          vectorCount: vectorResults.length,
          lexicalCount: lexicalResults.length,
          pathCount: pathResults.length,
          fusedCount: fused.length,
          bothSources: Array.from(fusedScores.values()).filter((v) => v.sources.size > 1).length,
        },
        'RRF 融合完成',
      );
    }

    return fused;
  }

  // Rerank 方法

  /**
   * Rerank
   */
  private async rerank(query: string, candidates: ScoredChunk[]): Promise<ScoredChunk[]> {
    if (candidates.length === 0) return [];

    const reranker = getRerankerClient();
    const queryTokens = this.extractQueryTokens(query);

    // 构造 rerank 文本：围绕命中行截取，而非头尾截断
    const textExtractor = (chunk: ScoredChunk): string => {
      const bc = this.truncateMiddle(chunk.record.breadcrumb, this.config.maxBreadcrumbChars);
      const budget = Math.max(0, this.config.maxRerankChars - bc.length - 1);
      const code = this.extractAroundHit(chunk.record.display_code, queryTokens, budget);
      return `${bc}\n${code}`;
    };

    const reranked = await reranker.rerankWithData(query, candidates, textExtractor, {
      topN: this.config.rerankTopN,
    });

    return reranked
      .filter((r) => r.data !== undefined)
      .map((r) => ({
        ...(r.data as ScoredChunk),
        score: r.score,
      }));
  }

  // Smart TopK Cutoff

  /**
   * 智能截断策略（Anchor & Floor + Safe Harbor + Delta Guard + 文件多样性保底）
   *
   * 核心逻辑：
   * 1. 低置信熔断：topScore < floor → 返回 top1 并按 secondaryFloor 补充文件多样性
   * 2. 动态阈值：max(floor, min(ratioThreshold, deltaThreshold))
   * 3. Safe Harbor：前 minK 个只检查 floor，不检查 ratio/delta
   * 4. 去重 + 补齐 + 多样性保底：确保达到 plan.minSeedFiles 个不同文件（若候选满足阈值）
   */
  private applySmartCutoff(candidates: ScoredChunk[], plan?: RetrievalPlan): ScoredChunk[] {
    // 未启用时直接返回原列表
    if (!this.config.enableSmartTopK) {
      return candidates;
    }

    if (candidates.length === 0) return [];

    // 防御：确保降序排列
    const sorted = candidates.slice().sort((a, b) => b.score - a.score);

    const {
      smartTopScoreRatio: ratio,
      smartTopScoreDeltaAbs: deltaAbs,
      smartMinScore: floor,
      smartMinK: minK,
      smartMaxK: configuredMaxK,
    } = this.config;

    const maxK = Math.max(1, Math.min(configuredMaxK, plan?.maxSeeds ?? configuredMaxK));
    const minFiles = Math.min(maxK, Math.max(1, plan?.minSeedFiles ?? 1));
    const topScore = sorted[0].score;

    // 低置信熔断/降级（CLI 友好：保留 top1，并按次级阈值补充不同文件种子）
    if (topScore < floor) {
      logger.debug({ topScore, floor }, 'SmartTopK: Top1 below floor, returning top1 only');
      return this.ensureMinSeedFiles([sorted[0]], sorted, minFiles, maxK, floor * ratio);
    }

    // 动态阈值计算（ratio + deltaAbs 护栏）
    const ratioThreshold = topScore * ratio;
    const deltaThreshold = topScore - deltaAbs;
    const dynamicThreshold = Math.max(floor, Math.min(ratioThreshold, deltaThreshold));

    const picked: ScoredChunk[] = [];

    for (let i = 0; i < sorted.length; i++) {
      if (picked.length >= maxK) break;

      const chunk = sorted[i];

      // Safe Harbor：前 minK 只看 floor
      if (i < minK) {
        if (chunk.score >= floor) {
          picked.push(chunk);
          continue;
        }
        // 保护区都过不了 floor，后面更差，直接结束
        logger.debug(
          { rank: i, score: chunk.score, floor },
          'SmartTopK: Safe harbor chunk below floor, breaking',
        );
        break;
      }

      // 保护区外：必须过动态阈值
      if (chunk.score < dynamicThreshold) {
        logger.debug(
          {
            rank: i,
            score: chunk.score,
            dynamicThreshold,
            topScore,
            ratioThreshold,
            deltaThreshold,
          },
          'SmartTopK: cutoff at dynamic threshold',
        );
        break;
      }

      picked.push(chunk);
    }

    // 去重（按 file_path + chunk_index）
    const deduped = this.dedupChunks(picked);

    // 去重后不足 minK，从后续 candidates 补齐（仅补 floor 以上）
    if (deduped.length < Math.min(minK, maxK)) {
      const seen = new Set(deduped.map((c) => this.chunkKey(c)));
      for (const c of sorted) {
        if (deduped.length >= Math.min(minK, maxK)) break;
        if (c.score < floor) break;
        const key = this.chunkKey(c);
        if (!seen.has(key)) {
          seen.add(key);
          deduped.push(c);
        }
      }
    }

    // 多文件意图保底：确保种子覆盖至少 minFiles 个不重复文件
    const diversified = this.ensureMinSeedFiles(deduped, sorted, minFiles, maxK, floor);

    logger.debug(
      {
        originalCount: candidates.length,
        pickedCount: picked.length,
        finalCount: diversified.length,
        topScore,
        floor,
        ratio,
        deltaAbs,
        minFiles,
        ratioThreshold: ratioThreshold.toFixed(3),
        deltaThreshold: deltaThreshold.toFixed(3),
        dynamicThreshold: dynamicThreshold.toFixed(3),
      },
      'SmartTopK: done',
    );

    return diversified;
  }

  /**
   * 种子文件多样性保底回填：
   * 若已选种子覆盖的独立文件数少于 minFiles，从候选列表中补充分数 >= minScore 的未覆盖文件；
   * 若已达 maxK 上限，优先替换同文件内得分最低的冗余 chunk，始终保留各文件最高分代表。
   */
  private ensureMinSeedFiles(
    selected: ScoredChunk[],
    sortedCandidates: ScoredChunk[],
    minFiles: number,
    maxK: number,
    minScore: number,
  ): ScoredChunk[] {
    if (minFiles <= 1) {
      return selected;
    }

    const result = [...selected];
    const seenKeys = new Set(result.map((c) => this.chunkKey(c)));
    const fileCounts = new Map<string, number>();
    for (const item of result) {
      fileCounts.set(item.filePath, (fileCounts.get(item.filePath) ?? 0) + 1);
    }

    if (fileCounts.size >= minFiles) {
      return result;
    }

    for (const candidate of sortedCandidates) {
      if (fileCounts.size >= minFiles) break;
      if (candidate.score < minScore) break;

      const key = this.chunkKey(candidate);
      if (seenKeys.has(key) || fileCounts.has(candidate.filePath)) {
        continue;
      }

      if (result.length < maxK) {
        result.push(candidate);
        seenKeys.add(key);
        fileCounts.set(candidate.filePath, 1);
        continue;
      }

      // 已达 maxK 上限：寻找出现次数 > 1 的文件中得分最低的 chunk 进行替换
      let replaceIdx = -1;
      for (let i = result.length - 1; i >= 0; i--) {
        if ((fileCounts.get(result[i].filePath) ?? 0) > 1) {
          if (replaceIdx === -1 || result[i].score < result[replaceIdx].score) {
            replaceIdx = i;
          }
        }
      }
      if (replaceIdx === -1) break;

      const removed = result[replaceIdx];
      seenKeys.delete(this.chunkKey(removed));
      fileCounts.set(removed.filePath, (fileCounts.get(removed.filePath) ?? 1) - 1);

      result[replaceIdx] = candidate;
      seenKeys.add(key);
      fileCounts.set(candidate.filePath, 1);
    }

    return result.sort((a, b) => b.score - a.score);
  }

  /**
   * 生成 chunk 唯一键（用于去重）
   */
  private chunkKey(chunk: ScoredChunk): string {
    return `${chunk.filePath}#${chunk.chunkIndex}`;
  }

  /**
   * 按 file_path + chunk_index 去重
   */
  private dedupChunks(list: ScoredChunk[]): ScoredChunk[] {
    const seen = new Set<string>();
    const out: ScoredChunk[] = [];
    for (const c of list) {
      const k = this.chunkKey(c);
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(c);
    }
    return out;
  }

  // 扩展方法

  /**
   * 扩展 seed chunks
   *
   * 使用 GraphExpander 执行三种扩展策略：
   * - E1: 同文件邻居
   * - E2: breadcrumb 补段
   * - E3: 相对路径 import 解析
   */
  private async expand(
    seeds: ScoredChunk[],
    queryTokens?: Set<string>,
    plan?: RetrievalPlan,
  ): Promise<ScoredChunk[]> {
    if (seeds.length === 0) return [];
    if (plan && !plan.expandNeighbors) return [];

    const expander = await getGraphExpander(this.projectId, this.config);
    const { chunks, stats } = await expander.expand(seeds, queryTokens);

    logger.debug(stats, '上下文扩展统计');

    return chunks;
  }

  // 工具方法

  /**
   * 中间省略截断（保留首尾）
   */
  private truncateMiddle(text: string, maxLen: number): string {
    if (text.length <= maxLen) return text;
    const half = Math.floor((maxLen - 3) / 2);
    return `${text.slice(0, half)}...${text.slice(-half)}`;
  }

  /**
   * 头尾截断（备用方法，当无命中行时使用）
   */
  private truncateHeadTail(text: string, maxLen: number, headRatio: number): string {
    if (text.length <= maxLen) return text;
    const headLen = Math.floor(maxLen * headRatio);
    const tailLen = maxLen - headLen - 3; // "..."
    if (tailLen <= 0) return text.slice(0, maxLen);
    return `${text.slice(0, headLen)}...${text.slice(-tailLen)}`;
  }

  /**
   * 围绕命中行截取
   *
   * 找到第一个包含 query token 的行，截取其上下文
   * 如果没有命中，降级为头尾截断
   */
  private extractAroundHit(text: string, queryTokens: Set<string>, maxLen: number): string {
    if (text.length <= maxLen) return text;

    const lines = text.split('\n');

    // 找命中行（包含任意 query token 的行）
    let hitLineIdx = -1;
    let bestScore = 0;

    for (let i = 0; i < lines.length; i++) {
      const lineLower = lines[i].toLowerCase();
      let lineScore = 0;
      for (const token of queryTokens) {
        if (lineLower.includes(token)) {
          lineScore++;
        }
      }
      // 选择命中 token 最多的行
      if (lineScore > bestScore) {
        bestScore = lineScore;
        hitLineIdx = i;
      }
    }

    // 无命中，降级为头尾截断
    if (hitLineIdx === -1) {
      return this.truncateHeadTail(text, maxLen, this.config.headRatio);
    }

    // 以命中行为中心，向上下扩展
    let start = hitLineIdx;
    let end = hitLineIdx;
    let currentLen = lines[hitLineIdx].length;

    // 交替向上、向下扩展
    while (currentLen < maxLen) {
      const canUp = start > 0;
      const canDown = end < lines.length - 1;

      if (!canUp && !canDown) break;

      // 先向上
      if (canUp) {
        const upLen = lines[start - 1].length + 1; // +1 for newline
        if (currentLen + upLen <= maxLen) {
          start--;
          currentLen += upLen;
        }
      }

      // 再向下
      if (canDown) {
        const downLen = lines[end + 1].length + 1;
        if (currentLen + downLen <= maxLen) {
          end++;
          currentLen += downLen;
        }
      }

      // 如果两边都无法扩展了，退出
      if (
        (start === 0 || lines[start - 1].length + 1 + currentLen > maxLen) &&
        (end === lines.length - 1 || lines[end + 1].length + 1 + currentLen > maxLen)
      ) {
        break;
      }
    }

    // 构造结果
    const result = lines.slice(start, end + 1).join('\n');
    const prefix = start > 0 ? '...' : '';
    const suffix = end < lines.length - 1 ? '...' : '';

    return prefix + result + suffix;
  }

  /**
   * 获取当前配置
   */
  getConfig(): SearchConfig {
    return { ...this.config };
  }
}
