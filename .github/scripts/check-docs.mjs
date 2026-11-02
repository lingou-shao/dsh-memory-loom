#!/usr/bin/env node
/**
 * 文档与代码的一致性检查，给 CI 用。
 *
 * 只查三条，都是已经真实踩过的：
 *   1. README 里那条 Release tarball 直链的版本号 —— 换版时忘改，用户点下去 404（0.2.13 → 0.2.16 期间残留过一次）。
 *   2. 源码里注册的 memory_* 工具，README 是否都提到了 —— 加了工具忘写文档，README 的工具表就少一行，
 *      而这份表是用户判断「这插件到底能干什么」的唯一入口。
 *   3. lib/index.js 里写死的 BUILD_VERSION —— 它是 `memory_doctor` 报「运行版本」的唯一来源。
 *      升级后没重启时，磁盘上的包是新的、跑的还是旧代码，用户只能靠这一行分辨。它要是过期了，
 *      这一行就从「诊断依据」变成「伪证」，比没有更糟。
 *
 * 不查的：README 里的中文数字（「十二个工具」）、行号表、章节编号。
 * 那些改起来频繁又容易假报警，人工看一眼比脚本可靠。
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (rel) => readFileSync(join(root, rel), "utf8");
const problems = [];

// ── 1. Release 直链的版本号 ───────────────────────────────────────────
const { version } = JSON.parse(read("package.json"));
const readme = read("README.md");
const link = readme.match(/releases\/download\/v([^/\s`]+)\/dsh-memory-loom-([^\s`)]+)\.tgz/u);
if (link === null) {
	problems.push("README 里找不到 Release tarball 直链（应形如 releases/download/v<版本>/dsh-memory-loom-<版本>.tgz）");
} else {
	const [, tagVersion, fileVersion] = link;
	if (tagVersion !== version) problems.push(`README 直链的 tag 是 v${tagVersion}，package.json 是 ${version}`);
	if (fileVersion !== version) problems.push(`README 直链的文件名是 ${fileVersion}.tgz，package.json 是 ${version}`);
}

// ── 2. 工具文档覆盖 ───────────────────────────────────────────────────
const registered = [...read("lib/index.js").matchAll(/name: "(memory_[a-z_]+)"/gu)].map((m) => m[1]);
const mentioned = new Set([...readme.matchAll(/\bmemory_[a-z_]+\b/gu)].map((m) => m[0]));
const undocumented = [...new Set(registered)].filter((name) => !mentioned.has(name));
if (undocumented.length > 0) problems.push(`README 没提到这些工具：${undocumented.join("、")}`);

// ── 3. 代码自报的版本 ─────────────────────────────────────────────────
const declared = read("lib/index.js").match(/const BUILD_VERSION = "([^"]+)"/u);
if (declared === null) problems.push('lib/index.js 里找不到 `const BUILD_VERSION = "..."`（memory_doctor 靠它报运行版本）');
else if (declared[1] !== version) problems.push(`lib/index.js 的 BUILD_VERSION 是 ${declared[1]}，package.json 是 ${version}——装上的包和跑起来的代码会对不上`);

// ── 报告 ──────────────────────────────────────────────────────────────
if (problems.length > 0) {
	console.error(`✗ 文档与代码不一致（${problems.length} 条）：`);
	for (const line of problems) console.error(`  · ${line}`);
	process.exit(1);
}
console.log(`✓ 版本一致：${version}（${new Set(registered).size} 个工具全部有文档）`);
