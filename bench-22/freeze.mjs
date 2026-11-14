#!/usr/bin/env node
/**
 * 开跑之前把「这次读数是哪一版、跑的是哪份库」钉下来（§117，取自 `1.1.zip` 的 ACCEPTANCE 阶段 0）。
 *
 * 外部那份验收计划的第一条硬约束是：**判定阈值必须在开跑之前写死并提交**，事后不得调。
 * 它防的不是手滑，是「看着结果挑阈值」——一次扫描出二十个读数，总能挑出一个好看的。
 *
 * 我们这边一直靠人记：§112.7 那句「读数跑到一半改代码 = 读数作废」是教训，不是机制。
 * 这个脚本把冻结项落成文件，读数目录里放一份，事后对得上就对得上，对不上就不用争。
 *
 *   node bench-22/freeze.mjs --out bench-22/work/ctx-0280/freeze.json
 *
 * 记的东西只有两类：**会改结果的外部量**，和**会改结果的代码量**。都不做解释，只做指纹。
 */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const DATA = process.env.BENCH22_DATA ?? 'C:/Users/shaoz/Desktop/cmb-2.2/benchmark-2.2/dataset';

const argOf = (name, fallback = undefined) => {
	const at = process.argv.indexOf(`--${name}`);
	return at === -1 ? fallback : process.argv[at + 1];
};

const sha = (file) => {
	try {
		return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
	} catch {
		return null;
	}
};
const git = (...args) => {
	try {
		return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).trim();
	} catch {
		return null;
	}
};

/*
 * 阈值表：只收**跑之前就要定下来**的那些。收全了就变成配置镜像，改一个默认值
 * 也要动这份文件，人就会开始忽略它。收的是四套读数真正会被推动的旋钮。
 */
const THRESHOLDS = [
	'retrieval.solidOverlap',
	'retrieval.relaxMinOverlap',
	'retrieval.relaxBelow',
	'retrieval.minScore',
	'retrieval.rawHits',
	'retrieval.topicTail',
	'retrieval.maxItems',
	'retrieval.rawPreview',
	'retrieval.tailBeyond',
	'retrieval.dueTodayMax',
	'consolidation.batchSize'
];

const defaultsOf = () => {
	const source = fs.readFileSync(path.join(ROOT, 'lib/index.js'), 'utf8');
	const out = {};
	for (const key of THRESHOLDS) {
		const leaf = key.split('.').pop();
		const hit = new RegExp(`[\\r\\n]\\s*${leaf}: ([^,\\r\\n]+),?[\\r\\n]`, 'u').exec(source);
		out[key] = hit === null ? null : hit[1].trim();
	}
	return out;
};

const record = {
	at: new Date().toISOString(),
	git: {
		sha: git('rev-parse', 'HEAD'),
		dirty: (git('status', '--porcelain') ?? '').trim() !== '',
		changed: (git('status', '--porcelain') ?? '').trim().split('\n').filter(Boolean)
	},
	code: {
		version: /const BUILD_VERSION = "([^"]+)"/u.exec(fs.readFileSync(path.join(ROOT, 'lib/index.js'), 'utf8'))?.[1] ?? null,
		lib_sha256: sha(path.join(ROOT, 'lib/index.js')),
		thresholds: defaultsOf()
	},
	data: {
		root: DATA,
		exam_inputs: sha(path.join(DATA, 'exam-inputs.jsonl')),
		answer_key: sha(path.join(DATA, 'review-only', 'answer-key.jsonl')),
		histories_m01: sha(path.join(DATA, 'histories', 'M01.jsonl')),
		histories_m02: sha(path.join(DATA, 'histories', 'M02.jsonl'))
	},
	env: {
		timezone: process.env.TZ ?? '(system)',
		loom_search_limit: process.env.LOOM_SEARCH_LIMIT ?? null,
		loom_expands: process.env.LOOM_EXPANDS ?? null,
		loom_expand_chars: process.env.LOOM_EXPAND_CHARS ?? null
	}
};

const out = argOf('out');
if (out === undefined) {
	console.error('用法: node freeze.mjs --out <文件>');
	process.exit(1);
}
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, `${JSON.stringify(record, null, '\t')}\n`);

console.log(`已冻结 ${out}`);
console.log(`  版本 ${record.code.version} · ${record.code.lib_sha256.slice(0, 12)} · ${record.git.sha?.slice(0, 8)}${record.git.dirty ? '（工作区有改动）' : ''}`);
if (record.git.dirty) for (const line of record.git.changed) console.log(`    ${line}`);
