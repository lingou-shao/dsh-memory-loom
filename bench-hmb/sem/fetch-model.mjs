// 从 hf-mirror 拉模型（huggingface.co 直连超时）。
//
//   node bench-hmb/sem/fetch-model.mjs                              # 默认 bge-small
//   node bench-hmb/sem/fetch-model.mjs --repo Xenova/bge-base-zh-v1.5
//   node bench-hmb/sem/fetch-model.mjs --repo Xenova/bge-reranker-base
//
// 只下 q8 量化那一个 onnx，其余变体（fp16/int8/q4/bnb4）不要。
import { mkdir, writeFile, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';

const argv = process.argv.slice(2);
const argOf = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : fallback;
};

const REPO = argOf('repo', 'Xenova/bge-small-zh-v1.5');
const BASE = `https://hf-mirror.com/${REPO}/resolve/main/`;
const ROOT = join('bench-hmb', 'sem', 'models', REPO);
const FILES = ['config.json', 'tokenizer.json', 'tokenizer_config.json', 'special_tokens_map.json', 'onnx/model_quantized.onnx'];

let total = 0;
for (const name of FILES) {
  const path = join(ROOT, name);
  try {
    const size = (await stat(path)).size;
    if (size > 0) { console.log('skip', name, size.toLocaleString()); total += size; continue; }
  } catch {}
  await mkdir(dirname(path), { recursive: true });
  const res = await fetch(BASE + name, { signal: AbortSignal.timeout(600000) });
  if (!res.ok) throw new Error(`${name}: HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  await writeFile(path, buf);
  total += buf.length;
  console.log(name, buf.length.toLocaleString(), 'bytes');
}
console.log(`${REPO} 共 ${(total / 1e6).toFixed(1)} MB`);
