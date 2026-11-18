import assert from 'node:assert/strict';
import test from 'node:test';
import type Parser from 'tree-sitter';
import { createRuntime as createCppRuntime } from '../../packages/lang-cpp/src/index.js';
import { createRuntime as createTsRuntime } from '../../packages/lang-typescript/src/index.js';
import { getParser } from '../../src/chunking/ParserPool.js';
import { SemanticSplitter } from '../../src/chunking/SemanticSplitter.js';
import { SourceAdapter } from '../../src/chunking/SourceAdapter.js';
import type { Window } from '../../src/chunking/types.js';

/**
 * 将 UTF-16 字符索引的 Tree-sitter AST 深拷贝映射为 UTF-8 字节偏移 AST，
 * 用于在 Node 环境下真实复现 UTF-8 索引域解析器的分片行为。
 */
function remapTreeToUtf8Bytes(node: Parser.SyntaxNode, code: string): Parser.SyntaxNode {
  const toByte = (charIdx: number): number => Buffer.byteLength(code.slice(0, charIdx), 'utf8');

  const cloneNode = (
    src: Parser.SyntaxNode,
    parent: Parser.SyntaxNode | null,
  ): Parser.SyntaxNode => {
    const mappedChildren: Parser.SyntaxNode[] = [];
    const mapped = {
      type: src.type,
      text: src.text,
      startIndex: toByte(src.startIndex),
      endIndex: toByte(src.endIndex),
      startPosition: src.startPosition,
      endPosition: src.endPosition,
      parent,
      children: mappedChildren,
      get namedChildren() {
        return mappedChildren.filter((c) => c.isNamed);
      },
      get firstNamedChild() {
        return mappedChildren.find((c) => c.isNamed) ?? null;
      },
      isNamed: src.isNamed,
      childForFieldName(fieldName: string) {
        const orig = src.childForFieldName(fieldName);
        if (!orig) return null;
        const idx = src.children.indexOf(orig);
        return idx >= 0
          ? mappedChildren[idx]
          : cloneNode(orig, mapped as unknown as Parser.SyntaxNode);
      },
    } as unknown as Parser.SyntaxNode;

    for (const child of src.children) {
      mappedChildren.push(cloneNode(child, mapped));
    }
    return mapped;
  };

  return cloneNode(node, null);
}

/** 检测字符串中是否存在孤立 UTF-16 代理项（未成对的高/低代理项） */
function hasLoneSurrogate(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const cc = text.charCodeAt(i);
    if (cc >= 0xd800 && cc <= 0xdbff) {
      const next = text.charCodeAt(i + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      i++;
    } else if (cc >= 0xdc00 && cc <= 0xdfff) {
      return true;
    }
  }
  return false;
}

test('构造函数应校验非法的分片预算参数', () => {
  assert.throws(() => new SemanticSplitter({ maxChunkSize: 1 }));
  assert.throws(() => new SemanticSplitter({ maxChunkSize: 1.5 }));
  assert.throws(() => new SemanticSplitter({ maxChunkSize: Number.NaN }));
  assert.throws(() => new SemanticSplitter({ maxRawChars: 3 }));
  assert.throws(() => new SemanticSplitter({ maxRawChars: Number.POSITIVE_INFINITY }));
  assert.throws(() => new SemanticSplitter({ minChunkSize: -1 }));
  assert.throws(() => new SemanticSplitter({ chunkOverlap: -1 }));

  assert.doesNotThrow(
    () =>
      new SemanticSplitter({
        maxChunkSize: 2,
        maxRawChars: 4,
        minChunkSize: 0,
        chunkOverlap: 0,
      }),
  );
});

test('UTF-8 字节索引域 AST 下 rawSpan 与元数据应转换回精确的 UTF-16 字符偏移', async () => {
  const parser = await getParser('go');
  assert.ok(parser, 'Go 内置解析器应可用');

  const code = [
    'package main',
    '',
    '// 中文注释：包含多字节字符与 😀 代理对表情',
    'func greet(name string) string {',
    '  msg := "你好世界 😀"',
    '  return msg + name',
    '}',
    '',
    '// 第二个函数注释：确保跨函数分片与 overlap',
    'func farewell(target string) string {',
    '  note := "再见朋友 🚀"',
    '  return note + target',
    '}',
    '',
  ].join('\n');

  const utf16Tree = parser.parse(code);
  const utf8Root = remapTreeToUtf8Bytes(utf16Tree.rootNode, code);
  const utf8Tree = { rootNode: utf8Root } as Parser.Tree;

  const adapter = new SourceAdapter({ code, endIndex: utf8Root.endIndex });
  assert.equal(adapter.getDomain(), 'utf8');
  assert.equal(adapter.byteToChar(utf8Root.endIndex), code.length);

  // maxChunkSize 设为 55 确保拆出多个 chunk，同时开启 chunkOverlap 覆盖代理对边界保护
  const splitter = new SemanticSplitter({
    maxChunkSize: 55,
    minChunkSize: 10,
    chunkOverlap: 20,
    maxRawChars: 400,
  });

  const chunks = splitter.split(utf8Tree, code, 'pkg/greet.go', 'go');
  assert.ok(chunks.length >= 2, `期望至少 2 个 chunk，实际 ${chunks.length}`);

  // 校验所有 rawSpan 连续无空洞且精准还原原始源码
  assert.equal(chunks[0].metadata.rawSpan.start, 0);
  assert.equal(chunks[chunks.length - 1].metadata.rawSpan.end, code.length);
  for (let i = 1; i < chunks.length; i++) {
    assert.equal(
      chunks[i].metadata.rawSpan.start,
      chunks[i - 1].metadata.rawSpan.end,
      '相邻 chunk 的 rawSpan 应首尾相接',
    );
  }

  const reconstructed = chunks
    .map((chunk) => code.slice(chunk.metadata.rawSpan.start, chunk.metadata.rawSpan.end))
    .join('');
  assert.equal(reconstructed, code, 'rawSpan 拼接必须完整无误还原含 CJK/emoji 的源码');

  for (const chunk of chunks) {
    assert.equal(
      code.slice(chunk.metadata.startIndex, chunk.metadata.endIndex),
      chunk.displayCode,
      'startIndex/endIndex 必须与 UTF-16 displayCode 切片一致',
    );
    assert.equal(hasLoneSurrogate(chunk.displayCode), false, 'displayCode 不应包含孤立代理项');
    assert.equal(hasLoneSurrogate(chunk.vectorText), false, 'vectorText 不应包含孤立代理项');
    const vecSlice = code.slice(chunk.metadata.vectorSpan.start, chunk.metadata.vectorSpan.end);
    assert.equal(hasLoneSurrogate(vecSlice), false, 'vectorSpan 切片不应截断代理对');
  }
});

test('forwardAbsorbComments 应扣除前导 gap NWS 并在全注释窗口吸空时归零', () => {
  const code = 'stmt1(); /*gap*/ // c1\n// c2\nstmt2();';
  const adapter = new SourceAdapter({ code, endIndex: code.length });
  const splitter = new SemanticSplitter({
    maxChunkSize: 500,
    minChunkSize: 0,
    chunkOverlap: 0,
    maxRawChars: 2000,
  });

  // 初始化内部 adapter / language 状态
  const internals = splitter as unknown as {
    adapter: SourceAdapter;
    language: string;
    forwardAbsorbComments: (current: Window, next: Window) => void;
  };
  internals.adapter = adapter;
  internals.language = 'javascript';

  const makeNode = (type: string, startIndex: number, endIndex: number): Parser.SyntaxNode =>
    ({
      type,
      startIndex,
      endIndex,
      text: code.slice(startIndex, endIndex),
    }) as unknown as Parser.SyntaxNode;

  const stmt1Start = code.indexOf('stmt1();');
  const stmt1End = stmt1Start + 'stmt1();'.length;
  const c1Start = code.indexOf('// c1');
  const c1End = c1Start + '// c1'.length;
  const c2Start = code.indexOf('// c2');
  const c2End = c2Start + '// c2'.length;
  const stmt2Start = code.indexOf('stmt2();');
  const stmt2End = stmt2Start + 'stmt2();'.length;

  // 场景 1：current 含前置节点 + 非空白 gap + 两个尾部注释
  const stmt1Node = makeNode('expression_statement', stmt1Start, stmt1End);
  const c1Node = makeNode('comment', c1Start, c1End);
  const c2Node = makeNode('comment', c2Start, c2End);
  const stmt2Node = makeNode('expression_statement', stmt2Start, stmt2End);

  const current1: Window = {
    nodes: [stmt1Node, c1Node, c2Node],
    size: adapter.nws(stmt1Start, c2End),
    contextPath: ['a.js'],
  };
  const next1: Window = {
    nodes: [stmt2Node],
    size: adapter.nws(stmt2Start, stmt2End),
    contextPath: ['a.js'],
  };

  internals.forwardAbsorbComments(current1, next1);

  assert.deepEqual(current1.nodes, [stmt1Node]);
  assert.equal(
    current1.size,
    adapter.nws(stmt1Start, stmt1End),
    'current.size 应扣除 absorbedNws 与 frontGapNws(/*gap*/)',
  );
  assert.deepEqual(next1.nodes, [c1Node, c2Node, stmt2Node]);
  assert.equal(next1.size, adapter.nws(c1Start, stmt2End));

  // 场景 2：current 全部是注释（中间夹杂非空白 gap），吸空后 size 必须严格归零
  const commentOnlyCode = '// a\n#gap\n// b\nfn();';
  const commentOnlyAdapter = new SourceAdapter({
    code: commentOnlyCode,
    endIndex: commentOnlyCode.length,
  });
  internals.adapter = commentOnlyAdapter;

  const aStart = commentOnlyCode.indexOf('// a');
  const aEnd = aStart + '// a'.length;
  const bStart = commentOnlyCode.indexOf('// b');
  const bEnd = bStart + '// b'.length;
  const fnStart = commentOnlyCode.indexOf('fn();');
  const fnEnd = fnStart + 'fn();'.length;

  const commentA = { type: 'comment', startIndex: aStart, endIndex: aEnd } as Parser.SyntaxNode;
  const commentB = { type: 'comment', startIndex: bStart, endIndex: bEnd } as Parser.SyntaxNode;
  const fnNode = {
    type: 'expression_statement',
    startIndex: fnStart,
    endIndex: fnEnd,
  } as Parser.SyntaxNode;

  const current2: Window = {
    nodes: [commentA, commentB],
    size: commentOnlyAdapter.nws(aStart, bEnd),
    contextPath: ['a.js'],
  };
  const next2: Window = {
    nodes: [fnNode],
    size: commentOnlyAdapter.nws(fnStart, fnEnd),
    contextPath: ['a.js'],
  };

  internals.forwardAbsorbComments(current2, next2);

  assert.equal(current2.nodes.length, 0);
  assert.equal(current2.size, 0, '全注释窗口被吸空后 size 应严格归零');
  assert.deepEqual(next2.nodes, [commentA, commentB, fnNode]);
  assert.equal(next2.size, commentOnlyAdapter.nws(aStart, fnEnd));
});

test('C/C++ 多层指针声明器与 TS 箭头函数应正确提取面包屑名称', async () => {
  const cppRuntime = createCppRuntime();
  const cppParser = await cppRuntime.getParser('cpp');
  assert.ok(cppParser, 'C++ 解析器应可用');

  const cppCode = 'const char* parse_token(int x) { return 0; }';
  const cppTree = cppParser.parse(cppCode);
  const cppSplitter = new SemanticSplitter({
    maxChunkSize: 20, // 促使递归进入 function_definition 并触发层级上下文更新
    minChunkSize: 0,
    chunkOverlap: 0,
    maxRawChars: 1000,
  });
  const cppChunks = cppSplitter.split(cppTree, cppCode, 'parser.cpp', 'cpp');
  assert.ok(
    cppChunks.some((chunk) => chunk.metadata.contextPath.includes('parse_token')),
    `C++ contextPath 应包含 parse_token，实际: ${JSON.stringify(cppChunks.map((c) => c.metadata.contextPath))}`,
  );

  const tsRuntime = createTsRuntime();
  const tsParser = await tsRuntime.getParser('typescript');
  assert.ok(tsParser, 'TypeScript 解析器应可用');

  const tsCode = 'const myArrow = () => 42;';
  const tsTree = tsParser.parse(tsCode);
  const tsSplitter = new SemanticSplitter({
    maxChunkSize: 10, // 让 variable_declarator 递归到 arrow_function
    minChunkSize: 0,
    chunkOverlap: 0,
    maxRawChars: 1000,
  });
  const tsChunks = tsSplitter.split(tsTree, tsCode, 'arrow.ts', 'typescript');
  assert.ok(
    tsChunks.some((chunk) => chunk.metadata.contextPath.includes('myArrow')),
    `TS contextPath 应包含 myArrow，实际: ${JSON.stringify(tsChunks.map((c) => c.metadata.contextPath))}`,
  );
});

test('forceSplitOversizedChunk 应避免切分 UTF-16 代理对且截断超长 vectorText 头部', () => {
  // 1. 奇数 maxRawChars=5 切分纯 emoji 串，每个切点都会压在代理对边界上
  const emojis = '😀'.repeat(8); // 16 个 UTF-16 码元
  const splitter = new SemanticSplitter({
    maxChunkSize: 1000,
    minChunkSize: 0,
    chunkOverlap: 0,
    maxRawChars: 5,
  });

  const chunks = splitter.splitPlainText(emojis, 'emoji_test.txt', 'text');
  assert.ok(chunks.length >= 4);
  assert.equal(chunks.map((c) => c.displayCode).join(''), emojis);
  assert.equal(chunks[0].metadata.rawSpan.start, 0);
  assert.equal(chunks[chunks.length - 1].metadata.rawSpan.end, emojis.length);

  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    assert.ok(chunk.displayCode.length <= 5);
    assert.equal(hasLoneSurrogate(chunk.displayCode), false, 'displayCode 不得切裂 emoji 代理对');
    assert.equal(hasLoneSurrogate(chunk.vectorText), false, 'vectorText 不得包含孤立代理项');
    if (i > 0) {
      assert.equal(chunk.metadata.rawSpan.start, chunks[i - 1].metadata.rawSpan.end);
    }
  }

  // 2. 边界处既有 ASCII 又有跨界 emoji：'12345😀6789' 在 maxRawChars=6 下应在索引 5 前切开
  const mixed = '12345😀6789';
  const mixedSplitter = new SemanticSplitter({
    maxChunkSize: 1000,
    minChunkSize: 0,
    chunkOverlap: 0,
    maxRawChars: 6,
  });
  const mixedChunks = mixedSplitter.splitPlainText(mixed, 'mixed.txt', 'text');
  assert.equal(mixedChunks[0].displayCode, '12345');
  assert.equal(mixedChunks[1].displayCode, '😀6789');
  assert.equal(mixedChunks[0].metadata.rawSpan.start, 0);
  assert.equal(mixedChunks[0].metadata.rawSpan.end, 5);
  assert.equal(mixedChunks[1].metadata.rawSpan.start, 5);
  assert.equal(mixedChunks[1].metadata.rawSpan.end, mixed.length);

  // 3. 当 displayCode 未超 maxRawChars 且 header 超过 headerBudget 时，也应截断 header 并保留 metadata.contextPath
  const maxRawChars = 72; // headerBudget = 18
  const longPath = 'aaaa😀bbbbccccdddd/file.ts';
  const headerSplitter = new SemanticSplitter({
    maxChunkSize: 1000,
    minChunkSize: 0,
    chunkOverlap: 0,
    maxRawChars,
  });
  const fitChunks = headerSplitter.splitPlainText('const ok = 1;', longPath, 'typescript');
  assert.equal(fitChunks.length, 1);
  assert.deepEqual(
    fitChunks[0].metadata.contextPath,
    [longPath],
    'metadata.contextPath 应完整保留',
  );
  const firstLineEnd = fitChunks[0].vectorText.indexOf('\n');
  assert.ok(firstLineEnd >= 0);
  const headerLine = fitChunks[0].vectorText.slice(0, firstLineEnd + 1);
  assert.ok(
    headerLine.length <= Math.floor(maxRawChars / 4),
    `未超长 chunk 的 vectorText header 长度 ${headerLine.length} 应 <= headerBudget`,
  );
  assert.equal(hasLoneSurrogate(headerLine), false, '截断后的 header 末尾不应残留高代理项');
  assert.equal(
    fitChunks[0].vectorText.slice(firstLineEnd + 1),
    'const ok = 1;',
    '截断 header 不应损坏代码正文',
  );

  // 4. 超长 chunk 强制切分时，每片的 vectorText header 也应受 headerBudget 约束且 contextPath 完整
  const oversizedCode = 'x'.repeat(200);
  const oversizedPieces = headerSplitter.splitPlainText(oversizedCode, longPath, 'typescript');
  assert.ok(oversizedPieces.length >= 3);
  for (const piece of oversizedPieces) {
    assert.deepEqual(piece.metadata.contextPath, [longPath]);
    const nl = piece.vectorText.indexOf('\n');
    assert.ok(nl >= 0);
    const pieceHeader = piece.vectorText.slice(0, nl + 1);
    assert.ok(pieceHeader.length <= Math.floor(maxRawChars / 4));
    assert.equal(hasLoneSurrogate(pieceHeader), false);
  }
});

test('windowsToChunks 在 UTF-16 overlap 命中代理对中间时应回退到高代理项', async () => {
  const parser = await getParser('javascript');
  assert.ok(parser, 'JavaScript 内置解析器应可用');

  // 构造两个函数：overlap=4 个 NWS 时二分查找会落在 😀 的低代理项码元上，触发回退对齐
  const code = ['function first() { return "a😀"; }', 'function second() { return 1; }'].join('\n');

  const tree = parser.parse(code);
  const splitter = new SemanticSplitter({
    maxChunkSize: 30,
    minChunkSize: 0,
    chunkOverlap: 4,
    maxRawChars: 400,
  });

  const chunks = splitter.split(tree, code, 'overlap_emoji.js', 'javascript');
  assert.equal(chunks.length, 2, '应分为两个函数 chunk');
  assert.ok(
    chunks[1].metadata.vectorSpan.start < chunks[1].metadata.startIndex,
    '第二个 chunk 应发生 overlap',
  );

  const vecSlice = code.slice(
    chunks[1].metadata.vectorSpan.start,
    chunks[1].metadata.vectorSpan.end,
  );
  assert.equal(vecSlice.startsWith('😀'), true, 'overlap 起点应完整包含整个 emoji 代理对');
  assert.equal(hasLoneSurrogate(vecSlice), false, 'overlap 起点不得切裂 UTF-16 代理对');
  assert.equal(hasLoneSurrogate(chunks[1].vectorText), false);
});
