import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { crawl } from '../../src/scanner/crawler.js';
import { initFilter, shouldPruneDirectory } from '../../src/scanner/filter.js';
import { sha256 } from '../../src/scanner/hash.js';
import {
  createProcessTiming,
  type KnownFileMeta,
  processFiles,
} from '../../src/scanner/processor.js';
import { decodeBuffer, detectBOM } from '../../src/utils/encoding.js';

test('crawl 剪枝 node_modules/.git，同时保留 .gitignore !dist/keep.ts 反选与 .coderecallinclude', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'coderecall-crawl-hardening-'));

  try {
    await fs.mkdir(path.join(tempRoot, '.git'), { recursive: true });
    await fs.mkdir(path.join(tempRoot, 'node_modules', 'pkg'), { recursive: true });
    await fs.mkdir(path.join(tempRoot, 'packages', 'web', 'node_modules', 'dep'), {
      recursive: true,
    });
    await fs.mkdir(path.join(tempRoot, 'dist'), { recursive: true });
    await fs.mkdir(path.join(tempRoot, 'src'), { recursive: true });
    await fs.mkdir(path.join(tempRoot, 'prompts'), { recursive: true });

    await fs.writeFile(path.join(tempRoot, '.git', 'HEAD.ts'), 'export const gitInternal = 1;\n');
    await fs.writeFile(
      path.join(tempRoot, 'node_modules', 'pkg', 'index.ts'),
      'export const pkg = 1;\n',
    );
    await fs.writeFile(
      path.join(tempRoot, 'packages', 'web', 'node_modules', 'dep', 'a.ts'),
      'export const dep = 1;\n',
    );
    await fs.writeFile(path.join(tempRoot, 'dist', 'keep.ts'), 'export const keep = 1;\n');
    await fs.writeFile(path.join(tempRoot, 'dist', 'drop.ts'), 'export const drop = 1;\n');
    await fs.writeFile(path.join(tempRoot, 'src', 'main.ts'), 'export const main = 1;\n');
    await fs.writeFile(path.join(tempRoot, 'prompts', 'guide.prompt'), 'system prompt\n');

    await fs.writeFile(
      path.join(tempRoot, '.gitignore'),
      ['# 放开 dist 目录后仅保留目标文件', '!dist/', 'dist/*', '!dist/keep.ts'].join('\n'),
      'utf8',
    );
    await fs.writeFile(path.join(tempRoot, '.coderecallinclude'), '**/*.prompt\n', 'utf8');

    await initFilter(tempRoot);

    assert.equal(shouldPruneDirectory('.git'), true);
    assert.equal(shouldPruneDirectory('sub/.git'), true);
    assert.equal(shouldPruneDirectory('node_modules'), true);
    assert.equal(shouldPruneDirectory('packages/web/node_modules'), true);
    assert.equal(shouldPruneDirectory('dist'), false);
    assert.equal(shouldPruneDirectory(''), false);

    const files = await crawl(tempRoot);
    const relFiles = files
      .map((filePath) => path.relative(tempRoot, filePath).replace(/\\/g, '/'))
      .sort();

    assert.equal(
      files.every((filePath) => path.isAbsolute(filePath)),
      true,
      'crawl 必须维持 full paths 契约',
    );
    assert.deepEqual(relFiles, ['dist/keep.ts', 'prompts/guide.prompt', 'src/main.ts']);
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

test('shouldPruneDirectory 在无反选与 node_modules 反选场景下的剪枝行为正确', async () => {
  const noNegRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'coderecall-prune-noneg-'));
  const nmNegRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'coderecall-prune-nmneg-'));

  try {
    // 无反选规则（注释中的 ! 不应被误判为反选）：所有被 ignore 的目录均可直接剪枝
    await fs.writeFile(
      path.join(noNegRoot, '.gitignore'),
      ['# !dist/keep.ts', '', 'custom-ignored/'].join('\n'),
      'utf8',
    );
    await initFilter(noNegRoot);
    assert.equal(shouldPruneDirectory('dist'), true);
    assert.equal(shouldPruneDirectory('custom-ignored'), true);
    assert.equal(shouldPruneDirectory('node_modules'), true);
    assert.equal(shouldPruneDirectory('src'), false);

    // 显式存在 node_modules 反选规则：node_modules 不应提前剪枝，.git 仍始终剪枝
    await fs.writeFile(
      path.join(nmNegRoot, '.gitignore'),
      ['!node_modules/', 'node_modules/*', '!node_modules/local-pkg/'].join('\n'),
      'utf8',
    );
    await initFilter(nmNegRoot);
    assert.equal(shouldPruneDirectory('.git'), true);
    assert.equal(shouldPruneDirectory('node_modules'), false);
    assert.equal(shouldPruneDirectory('dist'), false);
  } finally {
    await fs.rm(noNegRoot, { recursive: true, force: true });
    await fs.rm(nmNegRoot, { recursive: true, force: true });
  }
});

test('processFiles 在 stat/readFile 之前跳过 package-lock.json，并将 ENOENT 记为 skipped', async (t) => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'coderecall-proc-early-skip-'));

  try {
    const existingLock = path.join(tempRoot, 'package-lock.json');
    await fs.writeFile(existingLock, '{"lockfileVersion":3}\n', 'utf8');
    const missingFile = path.join(tempRoot, 'deleted-mid-scan.ts');

    const statCalls: string[] = [];
    const readCalls: string[] = [];
    const origStat = fs.stat.bind(fs);
    const origReadFile = fs.readFile.bind(fs);

    t.mock.method(fs, 'stat', async (targetPath: Parameters<typeof fs.stat>[0]) => {
      statCalls.push(String(targetPath));
      return origStat(targetPath);
    });
    t.mock.method(fs, 'readFile', async (targetPath: Parameters<typeof fs.readFile>[0]) => {
      readCalls.push(String(targetPath));
      return origReadFile(targetPath);
    });

    const timing = createProcessTiming();
    const results = await processFiles(tempRoot, [existingLock, missingFile], new Map(), {
      timing,
    });

    const lockResult = results.find((r) => r.relPath === 'package-lock.json');
    assert.equal(lockResult?.status, 'skipped');
    assert.equal(lockResult?.error, 'Lock file or node_modules JSON');
    assert.equal(
      statCalls.some((p) => p.endsWith('package-lock.json')),
      false,
      'package-lock.json 不应触发 fs.stat',
    );
    assert.equal(
      readCalls.some((p) => p.endsWith('package-lock.json')),
      false,
      'package-lock.json 不应触发 fs.readFile',
    );

    const missingResult = results.find((r) => r.relPath === 'deleted-mid-scan.ts');
    assert.equal(missingResult?.status, 'skipped');
    assert.equal(missingResult?.error, 'File deleted during scan');
    assert.equal(
      statCalls.some((p) => p.endsWith('deleted-mid-scan.ts')),
      true,
      '普通缺失文件应实际走到 fs.stat 并触发 ENOENT',
    );
    assert.equal(timing.files, 2);
    assert.equal(timing.skippedFiles, 2);
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

test('processFiles 拒绝无 BOM 的含 NUL 字节二进制文件（即使填充类 UTF-16 字节序列）', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'coderecall-proc-binary-'));

  try {
    const fakeUtf16Path = path.join(tempRoot, 'fake-utf16-binary.ts');
    // 构造无 BOM 且能诱发 chardet 判为 UTF-16LE 的类文本 0x00 填充字节序列
    const payload = Buffer.from(
      'export const binaryProbe = "padded utf16-like bytes without BOM";\n'.repeat(4),
      'utf16le',
    );
    assert.equal(detectBOM(payload), null);
    assert.equal(payload.includes(0), true);
    await fs.writeFile(fakeUtf16Path, payload);

    const timing = createProcessTiming();
    const [result] = await processFiles(tempRoot, [fakeUtf16Path], new Map(), { timing });

    assert.equal(result.status, 'skipped');
    assert.equal(result.error, 'Binary file detected (NUL byte)');
    assert.equal(result.content, null);
    assert.equal(timing.skippedFiles, 1);
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

test('detectBOM 优先识别 4 字节 UTF-32，processFiles 正确解码 UTF-16 LE BOM 并剥离 UTF-8 BOM', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'coderecall-proc-bom-'));

  try {
    // 校验 detectBOM 的 4 字节 UTF-32 -> 3 字节 UTF-8 -> 2 字节 UTF-16 检测优先级
    assert.equal(
      detectBOM(Buffer.from([0xff, 0xfe, 0x00, 0x00, 0x61, 0x00, 0x00, 0x00])),
      'UTF-32 LE',
    );
    assert.equal(
      detectBOM(Buffer.from([0x00, 0x00, 0xfe, 0xff, 0x00, 0x00, 0x00, 0x61])),
      'UTF-32 BE',
    );
    assert.equal(detectBOM(Buffer.from([0xef, 0xbb, 0xbf, 0x61])), 'UTF-8');
    assert.equal(detectBOM(Buffer.from([0xff, 0xfe, 0x61, 0x00])), 'UTF-16 LE');
    assert.equal(detectBOM(Buffer.from([0xfe, 0xff, 0x00, 0x61])), 'UTF-16 BE');

    const utf16Text = 'export const utf16Greeting = "你好 UTF-16";\n';
    const utf16Buffer = Buffer.concat([
      Buffer.from([0xff, 0xfe]),
      Buffer.from(utf16Text, 'utf16le'),
    ]);
    const utf16Path = path.join(tempRoot, 'utf16-bom.ts');
    await fs.writeFile(utf16Path, utf16Buffer);

    const utf8Text = 'export const utf8Greeting = "你好 UTF-8";\n';
    const utf8BomBuffer = Buffer.concat([
      Buffer.from([0xef, 0xbb, 0xbf]),
      Buffer.from(utf8Text, 'utf8'),
    ]);
    const utf8BomPath = path.join(tempRoot, 'utf8-bom.ts');
    await fs.writeFile(utf8BomPath, utf8BomBuffer);

    // 验证 decodeBuffer 会剥离所有路径的前导 \uFEFF
    const decodedUtf8Bom = decodeBuffer(utf8BomBuffer);
    assert.equal(decodedUtf8Bom.content, utf8Text);
    assert.equal(decodedUtf8Bom.content.startsWith('\uFEFF'), false);
    assert.equal(decodedUtf8Bom.originalEncoding, 'UTF-8');

    // 带 UTF-16 LE BOM 但仍内嵌真实 U+0000 的文件，解码后仍应被兜底检测拦截
    const utf16WithEmbeddedNulPath = path.join(tempRoot, 'utf16-embedded-nul.ts');
    await fs.writeFile(
      utf16WithEmbeddedNulPath,
      Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('export const x = 1;\0', 'utf16le')]),
    );

    const results = await processFiles(
      tempRoot,
      [utf16Path, utf8BomPath, utf16WithEmbeddedNulPath],
      new Map(),
    );
    const byRel = new Map(results.map((r) => [r.relPath, r]));

    const utf16NulRes = byRel.get('utf16-embedded-nul.ts');
    assert.equal(utf16NulRes?.status, 'skipped');
    assert.match(utf16NulRes?.error ?? '', /Binary file detected/);

    const utf16Res = byRel.get('utf16-bom.ts');
    assert.equal(utf16Res?.status, 'added');
    assert.equal(utf16Res?.content, utf16Text);
    assert.equal(utf16Res?.hash, sha256(utf16Buffer));
    assert.ok((utf16Res?.chunks.length ?? 0) > 0);

    const utf8BomRes = byRel.get('utf8-bom.ts');
    assert.equal(utf8BomRes?.status, 'added');
    assert.equal(utf8BomRes?.content, utf8Text);
    assert.equal(utf8BomRes?.content?.startsWith('\uFEFF'), false);
    assert.equal(utf8BomRes?.hash, sha256(utf8BomBuffer));
    assert.ok((utf8BomRes?.chunks.length ?? 0) > 0);

    // 当 mtime 变化但原始内容 hash 一致时，unchanged 分支必须返回 content: null
    const known = new Map<string, KnownFileMeta>([
      [
        'utf8-bom.ts',
        {
          hash: sha256(utf8BomBuffer),
          mtime: (utf8BomRes?.mtime ?? 0) - 5000,
          size: utf8BomBuffer.length,
        },
      ],
      [
        'utf16-bom.ts',
        {
          hash: sha256(utf16Buffer),
          mtime: (utf16Res?.mtime ?? 0) - 5000,
          size: utf16Buffer.length,
        },
      ],
    ]);
    const timing = createProcessTiming();
    const rerun = await processFiles(tempRoot, [utf16Path, utf8BomPath], known, { timing });
    for (const item of rerun) {
      assert.equal(item.status, 'unchanged');
      assert.equal(item.content, null);
      assert.equal(item.chunks.length, 0);
    }
    assert.equal(timing.unchangedFiles, 2);
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});
