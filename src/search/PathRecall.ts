/**
 * PathRecall - 基于 SQLite 文件清单的轻量级路径召回
 *
 * 针对路径定位类查询与复合查询，直接对 files 表中的文件路径进行词法打分，
 * 无需新增索引表或修改数据库 schema。
 */

import path from 'node:path';
import type Database from 'better-sqlite3';

export interface PathRecallResult {
  filePath: string;
  score: number;
}

const STOP_WORDS = new Set([
  'the',
  'a',
  'an',
  'is',
  'are',
  'where',
  'which',
  'what',
  'file',
  'path',
  'code',
  'implementation',
  'located',
  'in',
  'of',
  'for',
  'and',
  'or',
  'with',
  'client',
  '负责',
  '代码',
  '文件',
  '哪里',
  '在哪',
  '哪个',
  '实现',
  '入口',
  '默认',
  '参数',
  '阶段',
]);

function splitCamel(value: string): string[] {
  return value
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .split(/[^\p{L}\p{N}]+/u)
    .map((part) => part.toLowerCase())
    .filter(Boolean);
}

/**
 * 从查询文本提取路径匹配词项（保留紧凑词与驼峰拆分词，过滤通用停用词）
 */
export function extractPathQueryTerms(query: string): string[] {
  const raw = query.match(/[$_\p{L}\p{N}.-]+/gu) ?? [];
  const out: string[] = [];
  const seen = new Set<string>();

  for (const item of raw) {
    const compact = item.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
    const terms = [compact, ...splitCamel(item)];
    for (const term of terms) {
      if (term.length < 2 || STOP_WORDS.has(term) || seen.has(term)) continue;
      seen.add(term);
      out.push(term);
    }
  }

  return out.slice(0, 32);
}

function scorePath(filePath: string, terms: string[]): number {
  const normalized = filePath.replace(/\\/g, '/').toLowerCase();
  const basename = path.posix.basename(normalized);
  const extension = path.posix.extname(basename);
  const stem = extension ? basename.slice(0, -extension.length) : basename;
  const compactStem = stem.replace(/[^\p{L}\p{N}]+/gu, '');

  const pathTokens = new Set(
    normalized
      .split(/[/._-]+/u)
      .flatMap(splitCamel)
      .filter(Boolean),
  );
  const directoryTokens = new Set(
    normalized
      .split('/')
      .slice(0, -1)
      .flatMap((part) => splitCamel(part)),
  );

  let score = 0;
  let matched = 0;

  for (const term of terms) {
    let termScore = 0;
    if (compactStem === term) termScore = Math.max(termScore, 24);
    if (stem === term) termScore = Math.max(termScore, 24);
    if (basename === term) termScore = Math.max(termScore, 26);
    if (pathTokens.has(term)) termScore = Math.max(termScore, 8);
    if (directoryTokens.has(term)) termScore = Math.max(termScore, 5);
    if (term.length >= 3 && compactStem.includes(term)) termScore = Math.max(termScore, 5);
    if (term.length >= 4 && normalized.includes(term)) termScore = Math.max(termScore, 2);
    if (termScore > 0) matched++;
    score += termScore;
  }

  // 多词项命中同一路径时给予协同加分
  if (matched >= 2) score += Math.min(12, matched * 2);
  return score;
}

/**
 * 基于 SQLite files 表执行路径召回，支持可选语言白名单过滤
 */
export function searchPaths(
  db: Database.Database,
  query: string,
  limit = 20,
  languages?: string[],
): PathRecallResult[] {
  const terms = extractPathQueryTerms(query);
  if (terms.length === 0 || limit <= 0) return [];

  const rows =
    languages && languages.length > 0
      ? (db
          .prepare(
            `SELECT path FROM files WHERE language IN (${languages.map(() => '?').join(', ')})`,
          )
          .all(...languages) as Array<{ path: string }>)
      : (db.prepare('SELECT path FROM files').all() as Array<{ path: string }>);

  return rows
    .map((row) => ({ filePath: row.path, score: scorePath(row.path, terms) }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score || a.filePath.localeCompare(b.filePath))
    .slice(0, limit);
}
