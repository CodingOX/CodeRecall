#!/usr/bin/env node

/**
 * 安装前硬守卫：
 * - Node 20–24 可以安装。tree-sitter@0.25.1 起自带 N-API 预编译，Node 24 不再本地编译。
 * - Node 25 及以上尚未在本仓库验证，进入原生模块安装前直接拒绝。
 */

const rawVersion =
  process.env.CODERECALL_NODE_VERSION_OVERRIDE || process.version;

const match = /^v(\d+)\./.exec(rawVersion);
const major = match ? Number(match[1]) : Number.NaN;

if (!Number.isFinite(major)) {
  console.error(`[CodeRecall] 无法识别当前 Node 版本：${rawVersion}`);
  process.exit(1);
}

if (major < 20 || major >= 25) {
  console.error(
    [
      '[CodeRecall] 当前只支持 Node.js 20 到 24。',
      `检测到版本：${rawVersion}`,
      '建议：请切换到 Node 22 LTS 或 Node 24 后重新安装。',
    ].join('\n'),
  );
  process.exit(1);
}
