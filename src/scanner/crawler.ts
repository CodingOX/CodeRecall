import path from 'node:path';
import { fdir } from 'fdir';
import { isAllowedFile, isFiltered, shouldPruneDirectory } from './filter.js';

/**
 * 转义正则表达式特殊字符
 */
function escapeRegExp(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 使用 fdir 扫描文件系统
 */
export async function crawl(rootPath: string): Promise<string[]> {
  // 根路径前缀仅编译一次：避免在 fdir 逐文件/逐目录回调中重复构造正则
  // 使用 path.resolve 对齐 fdir withFullPaths() 的返回路径格式
  const normalizedRoot = path.resolve(rootPath).replace(/\\/g, '/').replace(/\/+$/, '');
  const rootPrefix = new RegExp(`^${escapeRegExp(normalizedRoot)}(?:/|$)`);

  /** 统一分隔符为 / 并剥离根路径前缀，得到相对路径 */
  const toRelative = (p: string): string => p.replace(/\\/g, '/').replace(rootPrefix, '');

  const api = new fdir()
    .withFullPaths()
    .withErrors()
    // 目录剪枝：阻止进入被忽略目录，提升大仓扫描速度，同时保留反选目录的穿透能力
    .exclude((_dirName, dirPath) => {
      const relDir = toRelative(dirPath);
      return relDir !== '' && shouldPruneDirectory(relDir);
    })
    .filter((filePath: string) => {
      const rel = toRelative(filePath);
      return rel !== '' && !isFiltered(rel) && isAllowedFile(filePath, rel);
    });

  const paths = await api.crawl(rootPath).withPromise();
  return paths;
}
