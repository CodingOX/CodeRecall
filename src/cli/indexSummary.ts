import type { ScanStats } from '../scanner/index.js';

/**
 * 将索引结果收敛为终端摘要：无变更时避免重复输出完整统计，
 * 但向量层仍有写入或失败时必须保留详细结果，方便发现未收敛状态。
 */
export function formatIndexSummary(stats: ScanStats, duration: string): string {
  const hasFileChanges = stats.added > 0 || stats.modified > 0 || stats.deleted > 0;
  const hasVectorWork =
    stats.vectorIndex !== undefined &&
    (stats.vectorIndex.indexed > 0 ||
      stats.vectorIndex.deleted > 0 ||
      stats.vectorIndex.errors > 0);

  if (!hasFileChanges && stats.errors === 0 && !hasVectorWork) {
    return `索引已是最新（${stats.totalFiles} 个文件，${duration}s）`;
  }

  return [
    `索引完成 (${duration}s)`,
    `总数:${stats.totalFiles} 新增:${stats.added} 修改:${stats.modified} 未变:${stats.unchanged} 删除:${stats.deleted} 跳过:${stats.skipped} 错误:${stats.errors}`,
  ].join('\n');
}
