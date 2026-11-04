// 延迟与体积：换更大模型的代价是多少。
//
//   node bench-hmb/sem/timing.mjs [--model Xenova/bge-base-zh-v1.5]
import { pipeline, env } from '@huggingface/transformers';
import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';

env.allowRemoteModels = false;
env.allowLocalModels = true;
env.localModelPath = 'bench-hmb/sem/models';
env.useBrowserCache = false;

const argv = process.argv.slice(2);
const argOf = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : fallback;
};
const MODEL = argOf('model', 'Xenova/bge-small-zh-v1.5');

const dir = join('bench-hmb/sem/models', MODEL, 'onnx');
let bytes = 0;
for (const f of await readdir(dir)) bytes += (await stat(join(dir, f))).size;

const t0 = Date.now();
const ex = await pipeline('feature-extraction', MODEL, { dtype: 'q8' });
const loadMs = Date.now() - t0;
const q = '截至第 60 次提交，猎户项目 的依赖名当前是什么值？（请给出值、状态，以及该值生效的序号）';
const one = await ex([q], { pooling: 'cls', normalize: true });
await ex([q], { pooling: 'cls', normalize: true });
const t1 = Date.now();
for (let i = 0; i < 20; i++) await ex([q], { pooling: 'cls', normalize: true });
const per = (Date.now() - t1) / 20;
const t2 = Date.now();
await ex(Array.from({ length: 32 }, () => q), { pooling: 'cls', normalize: true });
const batch = (Date.now() - t2) / 32;
console.log(`${MODEL}｜${one.dims[1]} 维｜onnx ${(bytes / 1e6).toFixed(0)} MB｜加载 ${loadMs}ms｜单条 ${per.toFixed(1)}ms｜批量 ${batch.toFixed(1)}ms/条`);
