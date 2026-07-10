import assert from 'node:assert/strict';
import test from 'node:test';
import { SemanticSplitter } from '../../src/chunking/SemanticSplitter.js';

test('超长单行（如内嵌 base64）必须被强制切分到 maxRawChars 以内', () => {
  const maxRawChars = 1000;
  const splitter = new SemanticSplitter({
    maxChunkSize: 500,
    maxRawChars,
    minChunkSize: 50,
    chunkOverlap: 0,
  });

  // 模拟测试文件中的巨型 base64 字符串：单行、几乎无空白
  const longLine = 'A'.repeat(5500);
  const code = [
    'package com.example;',
    '',
    'public class PictureRenderTest {',
    `  private static final String IMG = "${longLine}";`,
    '}',
  ].join('\n');

  const chunks = splitter.splitPlainText(code, 'PictureRenderTest.java', 'java');

  assert.ok(chunks.length > 1, '超长内容应被切成多个 chunk');
  for (const chunk of chunks) {
    assert.ok(
      chunk.displayCode.length <= maxRawChars,
      `chunk.displayCode 长度 ${chunk.displayCode.length} 超过 maxRawChars=${maxRawChars}`,
    );
    assert.ok(
      chunk.vectorText.length <= maxRawChars + 200,
      `vectorText 过长: ${chunk.vectorText.length}`,
    );
  }

  // rawSpan 拼接应覆盖完整文件（无空洞、不重叠）
  const sorted = [...chunks].sort((a, b) => a.metadata.rawSpan.start - b.metadata.rawSpan.start);
  assert.equal(sorted[0].metadata.rawSpan.start, 0);
  assert.equal(sorted[sorted.length - 1].metadata.rawSpan.end, code.length);
  for (let i = 1; i < sorted.length; i++) {
    assert.equal(
      sorted[i].metadata.rawSpan.start,
      sorted[i - 1].metadata.rawSpan.end,
      'rawSpan 应首尾相接',
    );
  }
});

test('整体文件小于 maxChunkSize 但单行超长时仍应强制切分', () => {
  const maxRawChars = 800;
  const splitter = new SemanticSplitter({
    maxChunkSize: 10000,
    maxRawChars,
    minChunkSize: 10,
    chunkOverlap: 0,
  });

  const longLine = 'B'.repeat(3000);
  const chunks = splitter.splitPlainText(longLine, 'blob.txt', 'text');

  assert.ok(chunks.length >= 3, `期望至少 3 片，实际 ${chunks.length}`);
  for (const chunk of chunks) {
    assert.ok(chunk.displayCode.length <= maxRawChars);
  }
});
