import { isUtf8 } from 'node:buffer';
import fs from 'node:fs/promises';
import chardet from 'chardet';
import iconv from 'iconv-lite';

export interface DecodedBufferResult {
  content: string;
  encoding: string;
  originalEncoding: string;
}

/**
 * 规范化编码名称，使其与 iconv-lite 兼容
 */
function normalizeEncoding(encoding: string): string {
  const map: Record<string, string> = {
    'UTF-8': 'utf8',
    'UTF-16 LE': 'utf16le',
    'UTF-16 BE': 'utf16be',
    'UTF-32 LE': 'utf32le',
    'UTF-32 BE': 'utf32be',
    GB18030: 'gb18030',
    GBK: 'gbk',
    GB2312: 'gb2312',
    Big5: 'big5',
    Shift_JIS: 'shiftjis',
    'EUC-JP': 'eucjp',
    'EUC-KR': 'euckr',
    'ISO-8859-1': 'iso88591',
    'windows-1252': 'win1252',
    ASCII: 'utf8', // ASCII 是 UTF-8 的子集
  };
  return map[encoding] || encoding.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * 检测 BOM（Byte Order Mark）
 *
 * 必须按 4 字节 UTF-32 -> 3 字节 UTF-8 -> 2 字节 UTF-16 顺序判断，
 * 避免 UTF-32 LE（FF FE 00 00）被误判为 UTF-16 LE（FF FE）。
 */
export function detectBOM(buffer: Buffer): string | null {
  if (buffer.length >= 4) {
    // UTF-32 LE
    if (buffer[0] === 0xff && buffer[1] === 0xfe && buffer[2] === 0x00 && buffer[3] === 0x00) {
      return 'UTF-32 LE';
    }
    // UTF-32 BE
    if (buffer[0] === 0x00 && buffer[1] === 0x00 && buffer[2] === 0xfe && buffer[3] === 0xff) {
      return 'UTF-32 BE';
    }
  }
  if (buffer.length >= 3) {
    // UTF-8 BOM
    if (buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) {
      return 'UTF-8';
    }
  }
  if (buffer.length >= 2) {
    // UTF-16 LE
    if (buffer[0] === 0xff && buffer[1] === 0xfe) {
      return 'UTF-16 LE';
    }
    // UTF-16 BE
    if (buffer[0] === 0xfe && buffer[1] === 0xff) {
      return 'UTF-16 BE';
    }
  }
  return null;
}

/**
 * 解码缓冲区为 UTF-8 字符串（自动检测编码并剥离前导 BOM）
 *
 * 调用方对非 UTF-16/UTF-32 BOM 文件应在解码前基于原始字节检测 NUL，
 * 防止误判为 UTF-16 时吞掉 NUL 字节导致二进制文件漏检。
 */
export function decodeBuffer(buffer: Buffer): DecodedBufferResult {
  const bom = detectBOM(buffer);
  if (!bom && isUtf8(buffer)) {
    // 绝大多数源码都是 UTF-8/ASCII；先走 Node 原生校验快路径，避免每个文件都跑 chardet。
    let content = buffer.toString('utf-8');
    if (content.charCodeAt(0) === 0xfeff) {
      content = content.slice(1);
    }
    return {
      content,
      encoding: 'utf-8',
      originalEncoding: 'UTF-8',
    };
  }

  let encoding = bom;

  if (!encoding) {
    const detected = chardet.detect(buffer);
    encoding = detected || 'UTF-8';
  }

  const normalizedEncoding = normalizeEncoding(encoding);

  // 尝试使用检测到的编码解码
  let content: string;
  try {
    if (iconv.encodingExists(normalizedEncoding)) {
      content = iconv.decode(buffer, normalizedEncoding);
    } else {
      // 回退到 UTF-8
      content = buffer.toString('utf-8');
    }
  } catch {
    // 解码失败，回退到 UTF-8
    content = buffer.toString('utf-8');
  }

  // 所有路径统一剥离前导 U+FEFF（覆盖 UTF-8 BOM 与兜底分支），避免污染 hash/AST/chunk
  if (content.charCodeAt(0) === 0xfeff) {
    content = content.slice(1);
  }

  return {
    content,
    encoding: 'utf-8', // 输出始终是 UTF-8
    originalEncoding: encoding,
  };
}

/**
 * 读取文件并自动转换编码为 UTF-8
 * @param filePath 文件路径
 * @returns 解码后的文件内容和检测到的编码
 */
export async function readFileWithEncoding(filePath: string): Promise<DecodedBufferResult> {
  const buffer = await fs.readFile(filePath);
  return decodeBuffer(buffer);
}
