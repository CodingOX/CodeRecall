# Audit Remediation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修复已确认的 HTTP 无限等待、FTS 错误确认、MCP 输入无界和 Import 串行查询问题，并保持现有对外行为兼容。

**Architecture:** 使用 Node 22 原生 AbortSignal 为单次外部请求建立硬超时；把索引确认移动到向量与 FTS 均成功之后；在 MCP Zod Schema 入口拒绝超限输入；将 Import 扩展改为先解析目标再批量读取。所有行为先由回归测试固定，再做最小实现。

**Tech Stack:** TypeScript ESM、Node.js 22、Zod、better-sqlite3、LanceDB、node:test、pnpm

## Global Constraints

- 不新增第三方依赖，不修改已拒绝实施的目录授权和文件权限问题。
- 核心超时、索引确认和批量扩展流程保留简体中文注释。
- 所有生产代码修改必须先有能观察到正确失败原因的回归测试。
- 最终必须通过 `pnpm tsc --noEmit`、`pnpm build` 和 `pnpm test`。

---

### Task 1: 外部 API 请求超时

**Files:**
- Modify: `src/api/embedding.ts`
- Modify: `src/api/reranker.ts`
- Test: `tests/runtime/embedding-client.test.ts`
- Test: `tests/runtime/reranker-client.test.ts`

**Interfaces:**
- Consumes: Node.js `AbortSignal.timeout()` 与 `AbortSignal.any()`。
- Produces: Embedding 与 Reranker 每次 fetch 都携带默认 30 秒硬超时信号。

- [ ] 编写测试，捕获 fetch 的 `signal`，验证存在且会在超时后中止；Embedding 同时验证保留调用方取消能力。
- [ ] 运行两个客户端测试，确认因缺少超时信号而失败。
- [ ] 增加模块级 `REQUEST_TIMEOUT_MS = 30_000`，Reranker 直接使用超时信号，Embedding 合并批次取消信号与超时信号。
- [ ] 重新运行两个客户端测试并确认通过。

### Task 2: FTS 失败不得确认索引收敛

**Files:**
- Modify: `src/indexer/index.ts`
- Test: `tests/runtime/batch-index-resilience.test.ts`

**Interfaces:**
- Consumes: 现有 `batchDeleteFileChunksFts()`、`batchUpsertChunkFts()`、`batchUpdateVectorIndexHash()`。
- Produces: 仅在向量和启用的 chunk FTS 均写入成功时更新 `vector_index_hash`；FTS 失败文件进入错误统计并留待 healing。

- [ ] 编写测试注入 FTS 写入失败，断言文件未确认且错误数增加。
- [ ] 运行测试，确认当前实现错误地更新 hash。
- [ ] 调整确认顺序；FTS 失败时记录文件错误并跳过 hash 更新和 success 计数。
- [ ] 运行索引韧性及 healing 测试并确认通过。

### Task 3: MCP 输入资源上限

**Files:**
- Modify: `src/mcp/tools/codebaseRetrieval.ts`
- Test: `tests/runtime/language-filter.test.ts`

**Interfaces:**
- Produces: `information_request` 为 1..8192 字符；术语与 glob 数组最多 100 项，每项 1..512 字符。

- [ ] 编写 Schema 测试覆盖空查询、超长查询、超量数组和超长数组元素。
- [ ] 运行测试，确认当前 Schema 接受这些输入。
- [ ] 给 Zod 字符串和数组加入明确上下界常量。
- [ ] 重新运行 Schema 相关测试并确认通过。

### Task 4: Import 扩展批量读取

**Files:**
- Modify: `src/search/GraphExpander.ts`
- Test: `tests/runtime/graph-expander.test.ts`

**Interfaces:**
- Consumes: `VectorStore.getFilesChunks(filePaths)`。
- Produces: 每次扩展轮次批量读取去重后的 import 目标，不再逐目标调用 `getFileChunks()`。

- [ ] 编写测试，断言多个 import 目标只调用批量接口且不调用单文件接口。
- [ ] 运行测试，确认当前串行实现失败。
- [ ] 将路径解析和 chunk 选择拆成两个阶段，保持 `importFilesPerSeed`、barrel 深度和衰减语义不变。
- [ ] 重新运行 GraphExpander 测试并确认通过。

### Task 5: 全量验证

**Files:**
- Verify only

- [ ] 运行 `pnpm fmt`。
- [ ] 运行 `pnpm exec -- biome check ./src ./tests`。
- [ ] 运行 `pnpm tsc --noEmit`。
- [ ] 运行 `pnpm build`。
- [ ] 运行 `pnpm test`。
- [ ] 检查 `git diff --check`、`git diff --stat` 和 `git status --short`，确认无意外文件。
