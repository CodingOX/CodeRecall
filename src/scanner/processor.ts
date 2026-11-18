import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import pLimit from 'p-limit';
import { getParser, type ProcessedChunk, SemanticSplitter } from '../chunking/index.js';
import { getChunkingConfig, getCodeRecallProfile } from '../config.js';
import { decodeBuffer, detectBOM } from '../utils/encoding.js';
import { sha256 } from './hash.js';
import { getAllowedLanguages, getLanguage, isAllowedExtension } from './language.js';

/**
 * 已知扩展名启用降级行分片的阈值（字节）
 */
const LARGE_FILE_DEGRADE_THRESHOLD = 100 * 1024;

/**
 * 已知扩展名最大可处理文件大小（字节）
 */
const KNOWN_EXTENSION_MAX_FILE_SIZE = 500 * 1024;

/**
 * 未知扩展名最大可处理文件大小（字节）
 *
 * 未知扩展名只有显式 include 时才会进入扫描，为避免噪声和性能风险，限制更严格。
 */
const UNKNOWN_EXTENSION_MAX_FILE_SIZE = 100 * 1024;

/**
 * 需要兜底分片支持的目标语言集合
 * 与扩展名白名单保持一致，避免出现“可扫描但不可分片”的语言缺口。
 */
const FALLBACK_LANGS = new Set([...getAllowedLanguages(), 'unknown']);

/**
 * 检查 JSON 文件是否应该跳过索引
 *
 * 跳过条件：
 * 1. lock 文件（*-lock.json, package-lock.json）
 * 2. node_modules 目录下的文件
 *
 * @param relPath 相对路径
 * @returns 是否应该跳过
 */
function shouldSkipJson(relPath: string): boolean {
  // Skip lock files
  if (relPath.endsWith('-lock.json') || relPath.endsWith('package-lock.json')) {
    return true;
  }
  // Skip node_modules (handle both Unix and Windows path separators)
  if (relPath.includes('node_modules/') || relPath.includes('node_modules\\')) {
    return true;
  }
  return false;
}

/**
 * 自适应并发度
 *
 * 基于 CPU 核心数动态调整并发度：
 * - 保留 1 个核心给系统和其他进程
 * - 最小并发度为 4（保证 I/O 密集型任务效率）
 * - 最大并发度为 32（避免过多上下文切换开销）
 */
function getAdaptiveConcurrency(): number {
  const cpuCount = os.cpus().length;
  const concurrency = Math.max(4, Math.min(cpuCount - 1, 32));
  return concurrency;
}

let splitter: SemanticSplitter | null = null;
let splitterProfile: string | null = null;

function getSplitter(): SemanticSplitter {
  const profile = getCodeRecallProfile();
  if (!splitter || splitterProfile !== profile) {
    splitter = new SemanticSplitter(getChunkingConfig());
    splitterProfile = profile;
  }
  return splitter;
}

/**
 * 文件处理结果
 */
export interface ProcessResult {
  absPath: string;
  relPath: string;
  hash: string;
  content: string | null;
  chunks: ProcessedChunk[];
  language: string;
  mtime: number;
  size: number;
  status: 'added' | 'modified' | 'unchanged' | 'deleted' | 'skipped' | 'error';
  error?: string;
}

/**
 * 已知文件元数据
 */
export interface KnownFileMeta {
  mtime: number;
  hash: string;
  size: number;
}

export interface ProcessTiming {
  files: number;
  changedFiles: number;
  unchangedFiles: number;
  skippedFiles: number;
  statMs: number;
  readMs: number;
  hashMs: number;
  parserLoadMs: number;
  astParseMs: number;
  astSplitMs: number;
  fallbackSplitMs: number;
  largeFallbackSplitMs: number;
}

export function createProcessTiming(): ProcessTiming {
  return {
    files: 0,
    changedFiles: 0,
    unchangedFiles: 0,
    skippedFiles: 0,
    statMs: 0,
    readMs: 0,
    hashMs: 0,
    parserLoadMs: 0,
    astParseMs: 0,
    astSplitMs: 0,
    fallbackSplitMs: 0,
    largeFallbackSplitMs: 0,
  };
}

function addTiming(timing: ProcessTiming | undefined, key: keyof ProcessTiming, ms: number): void {
  if (!timing) return;
  timing[key] += ms;
}

/**
 * 处理单个文件
 */
async function processFile(
  absPath: string,
  relPath: string,
  known?: KnownFileMeta,
  timing?: ProcessTiming,
): Promise<ProcessResult> {
  const language = getLanguage(relPath);
  if (timing) timing.files++;

  // lock 文件与 node_modules JSON 判断仅依赖路径，放到 stat/读文件之前避免无效 I/O
  if (language === 'json' && shouldSkipJson(relPath)) {
    if (timing) timing.skippedFiles++;
    return {
      absPath,
      relPath,
      hash: '',
      content: null,
      chunks: [],
      language,
      mtime: 0,
      size: 0,
      status: 'skipped',
      error: 'Lock file or node_modules JSON',
    };
  }

  try {
    const statStartedAt = Date.now();
    const stat = await fs.stat(absPath);
    addTiming(timing, 'statMs', Date.now() - statStartedAt);
    const mtime = stat.mtimeMs;
    const size = stat.size;
    const isKnownExtension = isAllowedExtension(relPath);
    const maxFileSize = isKnownExtension
      ? KNOWN_EXTENSION_MAX_FILE_SIZE
      : UNKNOWN_EXTENSION_MAX_FILE_SIZE;
    const shouldUseLargeFileFallback =
      isKnownExtension &&
      size > LARGE_FILE_DEGRADE_THRESHOLD &&
      size <= KNOWN_EXTENSION_MAX_FILE_SIZE;

    if (size > maxFileSize) {
      if (timing) timing.skippedFiles++;
      return {
        absPath,
        relPath,
        hash: '',
        content: null,
        chunks: [],
        language,
        mtime,
        size,
        status: 'skipped',
        error: `File too large (${size} bytes > ${maxFileSize} bytes)`,
      };
    }

    // 快速跳过：如果 mtime 和 size 都没变，则认为文件未修改
    if (known && known.mtime === mtime && known.size === size) {
      if (timing) timing.unchangedFiles++;
      return {
        absPath,
        relPath,
        hash: known.hash,
        content: null,
        chunks: [],
        language,
        mtime,
        size,
        status: 'unchanged',
      };
    }

    // 读取原始字节一次，后续二进制判定、原始哈希和编码解码共用该 Buffer
    const readStartedAt = Date.now();
    const buffer = await fs.readFile(absPath);
    addTiming(timing, 'readMs', Date.now() - readStartedAt);

    // 显式 UTF-16/UTF-32 BOM 文本会合法包含 0x00 字节；其余文件先按原始字节查 NUL，
    // 防止误判为 UTF-16 解码时把 NUL 吞掉造成二进制漏判
    const bom = detectBOM(buffer);
    const isUtf16Or32Bom = bom?.startsWith('UTF-16') || bom?.startsWith('UTF-32');

    if (!isUtf16Or32Bom && buffer.includes(0)) {
      if (timing) timing.skippedFiles++;
      return {
        absPath,
        relPath,
        hash: '',
        content: null,
        chunks: [],
        language,
        mtime,
        size,
        status: 'skipped',
        error: 'Binary file detected (NUL byte)',
      };
    }

    // 基于原始字节计算哈希，不受编码探测波动影响
    const hashStartedAt = Date.now();
    const hash = sha256(buffer);
    addTiming(timing, 'hashMs', Date.now() - hashStartedAt);

    // 非 UTF-16/UTF-32 BOM 文件若哈希未变，直接跳过解码与分片
    if (!isUtf16Or32Bom && known && known.hash === hash) {
      if (timing) timing.unchangedFiles++;
      return {
        absPath,
        relPath,
        hash,
        content: null,
        chunks: [],
        language,
        mtime,
        size,
        status: 'unchanged',
      };
    }

    // 解码缓冲区（自动检测编码并转换为 UTF-8，统一剥离前导 BOM）
    const { content, originalEncoding } = decodeBuffer(buffer);

    // 二进制兜底检测：检查解码后的 NULL 字符（如带 BOM 却混入 U+0000 的文件）
    if (content.includes('\0')) {
      if (timing) timing.skippedFiles++;
      return {
        absPath,
        relPath,
        hash: '',
        content: null,
        chunks: [],
        language,
        mtime,
        size,
        status: 'skipped',
        error: `Binary file detected (original encoding: ${originalEncoding})`,
      };
    }

    // 带 UTF-16/UTF-32 BOM 文件需在解码与 NUL 校验完成后再判哈希未变
    if (isUtf16Or32Bom && known && known.hash === hash) {
      if (timing) timing.unchangedFiles++;
      return {
        absPath,
        relPath,
        hash,
        content: null,
        chunks: [],
        language,
        mtime,
        size,
        status: 'unchanged',
      };
    }

    // 语义分片
    let chunks: ProcessedChunk[] = [];

    if (shouldUseLargeFileFallback) {
      const splitStartedAt = Date.now();
      chunks = getSplitter().splitPlainText(content, relPath, language);
      addTiming(timing, 'largeFallbackSplitMs', Date.now() - splitStartedAt);
    } else {
      // 1. 尝试 AST 分片
      try {
        const parserLoadStartedAt = Date.now();
        const parser = await getParser(language);
        addTiming(timing, 'parserLoadMs', Date.now() - parserLoadStartedAt);
        if (parser) {
          const astParseStartedAt = Date.now();
          const tree = parser.parse(content);
          addTiming(timing, 'astParseMs', Date.now() - astParseStartedAt);
          const astSplitStartedAt = Date.now();
          chunks = getSplitter().split(tree, content, relPath, language);
          addTiming(timing, 'astSplitMs', Date.now() - astSplitStartedAt);
        }
      } catch (err) {
        const error = err as { message?: string };
        // AST 分片失败，记录警告
        console.warn(`[Chunking] AST failed for ${relPath}: ${error.message}`);
      }
    }

    // 兜底分片：对 FALLBACK_LANGS 语言，如果 AST 分片失败或返回空，使用行分片
    if (chunks.length === 0 && FALLBACK_LANGS.has(language)) {
      const splitStartedAt = Date.now();
      chunks = getSplitter().splitPlainText(content, relPath, language);
      addTiming(timing, 'fallbackSplitMs', Date.now() - splitStartedAt);
    }

    if (timing) timing.changedFiles++;
    return {
      absPath,
      relPath,
      hash,
      content,
      chunks,
      language,
      mtime,
      size,
      status: known ? 'modified' : 'added',
    };
  } catch (err) {
    if (timing) timing.skippedFiles++;
    const error = err as NodeJS.ErrnoException;
    // 扫描窗口内文件被删除（git checkout、构建清理等）是正常竞态，
    // 归类为 skipped 而非 error，避免错误统计虚增；下次扫描会自然清理 DB 记录
    if (error.code === 'ENOENT') {
      return {
        absPath,
        relPath,
        hash: '',
        content: null,
        chunks: [],
        language,
        mtime: 0,
        size: 0,
        status: 'skipped',
        error: 'File deleted during scan',
      };
    }
    return {
      absPath,
      relPath,
      hash: '',
      content: null,
      chunks: [],
      language,
      mtime: 0,
      size: 0,
      status: 'error',
      error: error.message,
    };
  }
}

/**
 * 批量处理文件
 */
export async function processFiles(
  rootPath: string,
  filePaths: string[],
  knownFiles: Map<string, KnownFileMeta>,
  options: { timing?: ProcessTiming } = {},
): Promise<ProcessResult[]> {
  const concurrency = getAdaptiveConcurrency();
  const limit = pLimit(concurrency);

  const tasks = filePaths.map((filePath) => {
    // 标准化路径分隔符为 /，确保跨平台一致性
    const relPath = path.relative(rootPath, filePath).replace(/\\/g, '/');
    const known = knownFiles.get(relPath);
    return limit(() => processFile(filePath, relPath, known, options.timing));
  });

  return Promise.all(tasks);
}
