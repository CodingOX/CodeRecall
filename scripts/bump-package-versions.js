#!/usr/bin/env node

/**
 * 把主包和全部语言插件的 version 写成同一个版本。
 * 传入 x.y.z 时使用该版本；不传则在根 package.json 的 patch 上加 1。
 * 只改各包自己的 version，不改依赖范围。
 */

import fs from 'node:fs';

const files = [
  'package.json',
  'packages/lang-typescript/package.json',
  'packages/lang-kotlin/package.json',
  'packages/lang-csharp/package.json',
  'packages/lang-cpp/package.json',
  'packages/lang-java/package.json',
  'packages/lang-ruby/package.json',
  'packages/lang-c/package.json',
  'packages/lang-php/package.json',
  'packages/lang-rust/package.json',
  'packages/lang-swift/package.json',
  'packages/lang-all/package.json',
];

const versionPattern = /^\d+\.\d+\.\d+$/;

function readVersion(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8')).version;
}

function nextPatch(version) {
  const parts = version.split('.').map((part) => Number(part));
  if (parts.length !== 3 || parts.some((part) => !Number.isInteger(part))) {
    console.error(`[bump] 无法递增版本：${version}`);
    process.exit(1);
  }
  parts[2] += 1;
  return parts.join('.');
}

const requested = process.argv[2];
const next = requested || nextPatch(readVersion('package.json'));

if (!versionPattern.test(next)) {
  console.error(`[bump] 版本号格式不正确：${next}`);
  process.exit(1);
}

for (const file of files) {
  const pkg = JSON.parse(fs.readFileSync(file, 'utf8'));
  pkg.version = next;
  fs.writeFileSync(file, `${JSON.stringify(pkg, null, 2)}\n`);
}

process.stdout.write(`${next}\n`);
