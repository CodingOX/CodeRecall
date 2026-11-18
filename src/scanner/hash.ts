import crypto from 'node:crypto';

/**
 * 计算 SHA-256 hash
 *
 * 优先对原始 Buffer 计算：避免 chardet 编码探测波动导致文件 hash 漂移并触发全量重索引。
 *
 * @param data 输入内容（原始字节或字符串）
 * @returns 十六进制格式的 hash
 */
export function sha256(data: string | Buffer): string {
  return crypto.createHash('sha256').update(data).digest('hex');
}
