# 上游 ContextWeaver 同步与消融评测追溯报告（2026-11-18）

## 1. 同步概览

| 项目 | 详情 |
| --- | --- |
| 上游仓库 | `hsingjui/ContextWeaver` (`main`) |
| 本仓仓库 | `CodingOX/CodeRecall` (`main`) |
| 共同分叉基线 | `77071b8`（2026-01-12，`feat: add C, C++, and C# language support`） |
| 扫描上游范围 | `77071b8..42375d3`（2026-02-08 ~ 2026-09-08，共 21 个领先提交） |
| 本仓同步前基线 | `d590ab4`（`v0.1.11`） |
| 本仓合入落点 | P0 `822d8b8`（`5549af4` / `954636a` / `eeee38d`）+ P1 `0ed9541`（`344389a`）→ 发布 `v0.2.0` |

本次对上游分叉后的全部 **21 个提交** 逐一比对，剔除本仓已自主落地或与当前架构冲突的提交后：
1. **P0 稳定性与正确性修复** 已全部合入并补充 15 项单测；
2. **P1 检索优化** 在冻结 40-case 语料上完成多组消融实验，**只合入实测正收益模块**（FTS5 `trigram` 短词修复、`RetrievalPlan` + `PathRecall` + `minSeedFiles`），**淘汰实测负收益模块**（`CoverageSelector`、`QueryDecomposer`）；
3. **P2 CLI 体验类增强** 与**重表型静态索引** 暂缓或留作后续按需评估。

---

## 2. 上游 21 个提交逐条追溯总表

| # | 上游 SHA | 日期 | 上游提交摘要 | 处置状态 | 本仓对应提交 / 模块 | 决策与原因说明 |
| :-: | --- | --- | --- | --- | --- | --- |
| 1 | `e6fbf2d` | 2026-02-08 | `refactor: remove Zen Config abstraction and merge defaults into global config` | 未合并（路线差异） | `src/config.ts` / `04ac8e1` | 本仓主动保留配置档位机制与 `--zen` 选项，不做逆向移除。 |
| 2 | `bb08898` | 2026-02-10 | `fix: harden lock mechanism and prevent infinite healing loop (fixes #7)` | 此前已具备 | `src/utils/lock.ts`、`src/db/index.ts`、`src/indexer/index.ts` | 本仓已具备 `wx` 原子锁、`EPERM`、写宽限期、`busy_timeout = 5000` 及 `noChunkSettled` 收敛标记。 |
| 3 | `e1cbfa9` | 2026-09-06 | `feat(scanner): process files via global concurrency queue, drop batch barrier` | **已合并（P0）** | `5549af4` (`src/scanner/index.ts`) | 移除 `100` 文件串行批次栅栏，直接复用 `processFiles` 内置 `pLimit` 队列。 |
| 4 | `9db96a1` | 2026-09-06 | `fix(scanner): harden file read path after crawling` | **已合并并适配（P0）** | `954636a` (`src/scanner/*`、`src/utils/encoding.ts`) | 落地 `crawler` 目录剪枝（兼容 `.gitignore` `!` 取反并保留 `.withFullPaths()` 契约）、`shouldSkipJson` 前置、非 UTF-16/32 BOM 原始 `Buffer` NUL 检测与原始字节 `sha256`、`\uFEFF` 剥离、`ENOENT` 映射为 `skipped`；同时保留本仓 `isUtf8()` 原生快路径与 `100KB~500KB` 大文件降级分片。 |
| 5 | `700ca05` | 2026-09-06 | `feat(api): auto-split long embedding inputs and harden SiliconFlow response handling` | 此前已具备 | `3eebf13`、`a6ecbd1`、`8e02a37` | 本仓已实现 413/超长文本二分拆分、SiliconFlow 错误响应兼容与多 Key AIMD 限流。 |
| 6 | `32706a1` | 2026-09-06 | `chore(deps): upgrade toolchain to TS7/biome2.5/knip6, node>=22` | 未合并（兼容性风险） | `package.json` / `71eaff2` | 本仓维持 TS 5.9 + Biome 2.3.10 与 Node `>=20 <25` 安装兼容，避免 TS7 预览版破坏插件分包构建与外部安装。 |
| 7 | `184af4f` | 2026-09-06 | `feat: harden indexing and retrieval pipeline` | **核心项已合并（P0 + P1），重表子项未照搬** | `eeee38d`、`5549af4`、`344389a` | 见下方「2.1 `184af4f` 拆分明细」。 |
| 8 | `455e91b` | 2026-09-07 | `feat(search): add coverage-aware chunk selection before context packing` | **实测淘汰，未合并** | P1 消融测试未通过 | `CoverageSelector` 的 `maxContextFiles: 8` 强行截断本仓 `importFilesPerSeed: 5` 扩展出的 Rank 9+ 关联文件，40-case 多文件全命中率在 `rrf-topn` 从 `65.2%` 跌至 `52.2%`，在 Live Reranker 从 `52.2%` 跌至 `43.5%`。 |
| 9 | `8ba6b0f` | 2026-09-07 | `chore: drop removed mcp entry from build scripts` | 不适用 | `package.json` | 本仓构建脚本无该历史冗余入口。 |
| 10 | `65d6df4` | 2026-09-07 | `feat(bench): add file-level retrieval benchmark harness` | 借用评测集验证，未入仓 | `src/search/eval/` | 借用其 40-case 用例在冻结语料上做消融评测；上游自身后续已在 `d576b71` 移除该目录，本仓保留自研 `eval/` 与 `coderecall tune`。 |
| 11 | `eed71c6` | 2026-09-07 | `chore: bootstrap trellis workflow` | 未合并 | — | 上游作者个人 `.trellis/` 工作流模板，与本仓无关。 |
| 12 | `a48e967` | 2026-09-07 | `docs(spec): bootstrap trellis coding guidelines` | 未合并 | — | 同上（`.trellis/` 规范模板）。 |
| 13 | `e321f7c` | 2026-09-07 | `feat(cli): interactive init wizard, doctor check, progress bars, local embedding models` | 本地模型已具备；探针/向导暂缓（P2） | `fe9db65`、`src/index.ts` | 本仓已实现本地 CPU 模型；本仓 `doctor` 定位向量/FTS 一致性修复，上游 API 连通性与维度探针（`probe.ts`）及交互式 `init` 留作 P2 按需增强。 |
| 14 | `b40fadc` | 2026-09-07 | `feat(cli): fix local model caching, unify model command, migrate index dirs` | 大部分已具备；`/v1` 拼接暂缓（P2） | `src/api/localEmbedding.ts`、`src/cli/model.ts` | 本仓已支持固定 revision 离线加载、`model_max_length`、`HF_ENDPOINT` 镜像与统一 `model` 子命令；`endpointUrl.ts` 兼容 `/v1` 根路径留作 P2 小优化。 |
| 15 | `f9477fe` | 2026-09-07 | `feat(search): improve retrieval planning and benchmark rigor` | **择优部分合并（P1）** | `344389a` (`RetrievalPlan.ts`、`PathRecall.ts`、`SearchService.ts`) | 见下方「2.2 `f9477fe` 拆分明细」。 |
| 16 | `475bd1e` | 2026-09-07 | `chore: update CI and benchmark snapshots` | 不适用 | — | 上游基准快照更新。 |
| 17 | `bc140a1` | 2026-09-07 | `feat(bench): schema-v3 multi-model baselines, sort embedding batches, drop stale snapshots` | 不适用 / 已具备 | `src/api/embedding.ts` | 本仓 `EmbeddingClient` 已按输入索引排序返回；其余为上游快照文件。 |
| 18 | `d576b71` | 2026-09-08 | `chore: remove retrieval benchmark suite` | 不适用 | — | 上游删除基准套件，本仓保留 `src/search/eval/` 与 `coderecall tune`。 |
| 19 | `33e0e69` | 2026-09-08 | `fix(db): canonicalize project path variants for stable project id` | **已合并（P0）** | `5549af4` (`src/db/index.ts`) | 在 `generateProjectId()` 加入 `fs.realpathSync` + `canonicalCase`（`stat.dev`/`stat.ino` 校验），防止 macOS/Windows 大小写、尾斜杠或 symlink 变体产生多份 `projectId` 与重复索引。 |
| 20 | `f392187` | 2026-09-08 | `feat(search): keep min seed files on low-confidence plans` | **已合并（P1）** | `344389a` (`RetrievalPlan.ts`、`SearchService.ts`) | 合入 `minSeedFiles` 与 `ensureMinSeedFiles()` 多文件多样性保底，避免宽查询低置信度下退化成单文件 top1。 |
| 21 | `42375d3` | 2026-09-08 | `feat(cli): structured search output via --json/--jsonl` | 暂缓（P2 待按需跟进） | `src/index.ts` | 属于 CLI 批处理机器输出契约，不影响 MCP 主链路，后续有脚本/评测批跑需求时再独立接入。 |

### 2.1 `184af4f` 拆分明细

- **已合入部分**：
  - **分片域与边界修复**（`eeee38d`）：`SourceAdapter.byteToChar()` 开放为 `public`；`SemanticSplitter` 将 `ChunkMetadata` 的偏移与 span 经 `byteToChar()` 转为字符偏移；修复 `forwardAbsorbComments()` 漏扣前置 gap NWS 与全注释窗口未清零问题；补充 C/C++ 多层 `declarator` 及 `arrow_function` 命名提取；`enforceChunkSizeLimits` / `forceSplitOversizedChunk` 增加 UTF-16 代理对边界保护、预算校验与超长 `breadcrumb` 前缀截断；UTF-8 索引域提示降级为 `logger.debug`。
  - **向量幂等与删除崩溃恢复**（`5549af4`）：`VectorStore.upsertFile()` / `batchUpsertFiles()` 插入前对同 `(file_path, file_hash)` 残留标记 `retry:` 前缀并清理 0-chunk 历史向量；SQLite 新增 `pending_deletions` 持久化待删队列，向量与 `chunks_fts` 清理完成后再移除标记；`scan()` 释放 `r.content` 内存并清理新增跳过的历史文件记录。
  - **FTS5 `trigram` 短词修复**（`344389a`）：修复 `<3` 字符英文/数字与二字中文词在 `trigram` 下 `MATCH` 返回空且破坏 `AND` 严格查询的问题。
- **未照搬部分**：
  - 未引入上游的 `fts_short_tokens` / `fts_short_records` / `fts_short_tokens_meta` 3 张倒排表（会带来额外建表、写放大与 SQLite 体积膨胀），改用「`segmentQuery()` 提取 3~8 字连续汉字串 + `partitionFtsTokens()` 剥离短词出 `MATCH` + 纯短词走参数化四列加权 `instr()` 兜底」，在零 schema 膨胀下解决了零召回问题。
  - 保留本仓既有的 `embedding_space_id` 校验与 `ftsMode: 'rebuild'` 批量重建优化。

### 2.2 `f9477fe` 拆分明细

- **已合入部分**（`344389a`）：
  - `src/search/RetrievalPlan.ts`：7 种检索意图分类（`symbol` / `path` / `reference` / `call-chain` / `overview` / `compound` / `feature`），扩展 `.kt/.kts/.rb/.php/.swift/.dart/.vue` 路径线索；**结合本仓无静态依赖图扩展的架构特征，将 `maxSeeds` 统一保持为 `8`**（避免像上游 `3/4/6` 那样截断多文件种子）。
  - `src/search/PathRecall.ts`：基于 `files` 表做零新表路径词法召回，补充 `languageFilter` 支持。
  - `src/search/SearchService.ts`：接入三路 RRF（vector + lexical + path），保持 `both`/`path` 来源与既有测试 harness 签名兼容。
- **未合入部分**：
  - **`QueryDecomposer.ts`（消融淘汰）**：见第 3 节实测数据，拆句检索使 RRF P95 延迟翻倍且拉低精准度。
  - **`SymbolExtractor.ts` + `DependencyIndexer.ts`（暂不引入）**：需新增 `symbol_occurrences` / `dependency_edges` 派生表与额外索引期 AST 遍历。本仓 `chunks_fts` 已将 `symbol_tokens` 权重设为 `6.0` 且已内置 12 语言 `ImportResolver`（E3），当前 40-case 在 `symbol` 与 `reference` 类上已达到高水准（`rrf-topn` 下 `symbol` R@3/R@5=1.0000、`reference` MRR=0.9000），按 KISS/YAGNI 原则暂不引入额外存储复杂度。

---

## 3. P1 40-Case 消融实验归档

- **评测条件**：冻结 Post-P0 `src/` 语料库；本地 CPU Embedding 模型 `qwen3-embedding-0.6b`；基于上游 `bc140a1` 的 40 条 7 意图查询（仅将 3 条上游专属符号/路径对齐到本仓真实存在的对应符号/文件：`getSharedDb` → `initDb`、`CoverageSelector` → `ContextPacker`、`overview-retrieval-pipeline` 移除 `CoverageSelector.ts`）。

### 3.1 Deterministic RRF 消融（`rrf-topn`）

> 将 RRF 排名归一化至 `[0.35, 0.90]` 以屏蔽远端 Reranker 波动，真实测量排序、Plan、PathRecall 与 Truncation 对召回结构的影响。

| 配置方案 | MRR | Recall@1 | Recall@3 | Recall@5 | nDCG@5 | 多文件全命中 (23) | P50 / P95 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Baseline (Post-P0) | 0.9083 | 0.4633 | 0.7621 | 0.8225 | 0.7844 | 15/23 (65.2%) | 57.5 / 71.0 ms |
| + P1.1（`fts.ts` trigram/短词） | 0.9083 | 0.4633 | 0.7746 | 0.8225 | 0.7857 | 15/23 (65.2%) | 57.5 / 70.0 ms |
| + P1.1 + P1.2（`CoverageSelector`） | 0.9083 | 0.4633 | 0.7746 | 0.8225 | 0.7857 | 12/23 (52.2%) | 57.6 / 66.8 ms |
| + P1.1 + P1.2 + P1.3（含 Decomp，`maxSeeds=3..8`） | 0.9208 | 0.4883 | 0.7683 | 0.8058 | 0.7889 | 9/23 (39.1%) | 58.1 / 126.0 ms |
| + P1.1 + P1.3（无 Cov、含 Decomp，`maxSeeds=3..8`） | 0.9208 | 0.4883 | 0.7683 | 0.8058 | 0.7889 | 12/23 (52.2%) | 64.3 / 135.6 ms |
| + P1.1 + P1.3（无 Cov/Decomp，`maxSeeds=3..8`） | 0.9208 | 0.4883 | 0.7621 | 0.8233 | 0.7995 | 13/23 (56.5%) | 60.6 / 79.1 ms |
| **胜出 P1 (`p1_win`: P1.1 + Plan(`maxSeeds=8`) + PathRecall + minSeedFiles)** | **0.9208** | **0.4883** | **0.7746** | **0.8525** | **0.8166** | **16/23 (69.6%)** | **58.0 / 70.7 ms** |

### 3.2 RRF 降级与 Live Reranker 对比

- **RRF Fallback**（模拟 Reranker 不可用，直接降级使用原生 RRF 得分）：
  - Baseline：MRR `0.8508`，R@1 `0.4633`，R@3 `0.5446`，R@5 `0.6121`，nDCG@5 `0.6247`，P50/P95 `55.0 / 67.7 ms`
  - 胜出 P1 (`p1_win`)：MRR `0.8758`（`+0.0250`），R@1 `0.4883`（`+0.0250`），R@3 `0.5633`（`+0.0187`），R@5 `0.6196`（`+0.0075`），nDCG@5 `0.6377`（`+0.0130`），P50/P95 `49.1 / 57.7 ms`
- **Live Reranker**（SiliconFlow `BAAI/bge-reranker-v2-m3`）：
  - Baseline：MRR `0.9042`，R@1 `0.5196`，R@3 `0.7046`，R@5 `0.7858`，nDCG@5 `0.7711`，Multi-Hit `12/23 (52.2%)`
  - + `CoverageSelector`：Multi-Hit 跌至 `10/23 (43.5%)`、nDCG@5 跌至 `0.7673`（淘汰）
  - + `QueryDecomposer`：MRR 跌至 `0.8958`、R@1 跌至 `0.4946`（淘汰）
  - 胜出 P1 (`p1_win`)：MRR `0.9042`，R@1 `0.5196`，R@3 `0.7046`，Multi-Hit `12/23 (52.2%)`（R@5 `0.7796` 系单条 `reference-embedding-config` rank-5 在 API 端于 `src/scanner/index.ts` 与 `src/mcp/tools/codebaseRetrieval.ts` 间抖动，同配置前次实测为 `0.7858`）。

### 3.3 各类别明细（`rrf-topn`：Baseline → Winning P1）

| 意图类别 | 用例数 | MRR | Recall@1 | Recall@3 | Recall@5 | nDCG@5 | Multi-Hit |
| --- | :-: | --- | --- | --- | --- | --- | --- |
| `symbol` | 8 | 0.7292 → 0.7292 | 0.5000 → 0.5000 | 1.0000 → 1.0000 | 1.0000 → 1.0000 | 0.7991 → 0.7991 | — |
| `feature` | 7 | 1.0000 → 1.0000 | 0.6190 → 0.6190 | 0.8095 → 0.8095 | 0.9286 → 0.9286 | 0.9072 → 0.9072 | 5/5 → 5/5 |
| `path` | 5 | 0.8000 → **0.9000** | 0.6000 → **0.8000** | 1.0000 → 1.0000 | 1.0000 → 1.0000 | 0.8524 → **0.9262** | — |
| `reference` | 5 | 0.9000 → 0.9000 | 0.6000 → 0.6000 | 0.8500 → 0.8500 | 0.8500 → 0.8500 | 0.8332 → 0.8332 | 2/3 → 2/3 |
| `call-chain` | 5 | 1.0000 → 1.0000 | 0.3333 → 0.3333 | 0.7167 → 0.7167 | 0.7833 → 0.7833 | 0.8403 → 0.8403 | 4/5 → 4/5 |
| `overview` | 5 | 1.0000 → 1.0000 | 0.2667 → 0.2667 | 0.2667 → **0.3667** | 0.4667 → 0.4667 | 0.5372 → **0.5481** | 2/5 → 2/5 |
| `compound` | 5 | 1.0000 → 1.0000 | 0.2400 → 0.2400 | 0.5300 → 0.5300 | 0.5800 → **0.8200** | 0.6633 → **0.8363** | 2/5 → **3/5** |

---

## 4. 后续可按需跟进的候选项（Backlog）

1. **`search --json` / `--jsonl` 机器输出契约**（上游 `42375d3`）：如需让外部评测脚本或自动化 Agent 直接消费稳定脱敏 JSON 结构（日志自动切到 `stderr`），可独立引入 `CliSearchResultV1`。
2. **`doctor` 连通性与维度探针 + `/v1` Base URL 自动拼接**（上游 `e321f7c`、`b40fadc`）：本仓现有 `coderecall doctor` 专司索引一致性修复；若需要降低新手配置错误率，可增加 `doctor --probe` 实测远端返回维度与配置的匹配度，并兼容仅填写 `/v1` 根地址的配置。
3. **逆向调用链 / 静态依赖图**（上游 `f9477fe`）：当前基于 `chunks_fts` + 12 语言 `ImportResolver` 已能满足基准需求；若后续大型跨模块仓库中 `reference` 类召回出现瓶颈，再考虑按需评估 `SymbolExtractor` + `DependencyIndexer`。
