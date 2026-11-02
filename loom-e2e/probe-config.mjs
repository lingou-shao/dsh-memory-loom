/**
 * 配置一致性探针：schema 默认值、indexDefaults、实际引擎配置三者必须对齐。
 * 上次就是 toEngineConfig 白名单漏了 l0，静默吞掉所有写入——这类问题必须机器查。
 */

import { Config, indexDefaults } from '../lib/index.js';

let failures = 0;
const check = (label, ok, detail = '') => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
};

const config = Config({ path: ':memory:' });

console.log('\n[1] index 组与 indexDefaults 对齐');
const indexKeys = Object.keys(config.index ?? {});
const defaultKeys = Object.keys(indexDefaults);
check('index 组存在', config.index !== undefined, JSON.stringify(indexKeys));
for (const key of defaultKeys) {
  check(`index.${key} = ${indexDefaults[key]}`, config.index?.[key] === indexDefaults[key], `实际 ${JSON.stringify(config.index?.[key])}`);
}
check('index 组没有 schema 里有但 defaults 没有的键', indexKeys.every((k) => defaultKeys.includes(k) || k === 'rebuildMinutes' || k === 'includeAssistant' || k === 'locale'),
  `schema 多出: ${indexKeys.filter((k) => !defaultKeys.includes(k)).join(', ') || '无'}`);

console.log('\n[2] l0 组存在且默认不截断（上次的静默坑）');
check('l0 组存在', config.l0 !== undefined, JSON.stringify(config.l0 ?? null));
check('l0.maxCharsPerMessage 默认 0（整条落库）', config.l0?.maxCharsPerMessage === 0, `实际 ${JSON.stringify(config.l0?.maxCharsPerMessage)}`);

console.log('\n[3] consolidation 关键触发参数');
check('idleMinutes = 5', config.consolidation?.idleMinutes === 5, `实际 ${config.consolidation?.idleMinutes}`);
check('triggerTokens = 20000', config.consolidation?.triggerTokens === 20000, `实际 ${config.consolidation?.triggerTokens}`);
check('maxRunSeconds > itemTimeoutSeconds', config.consolidation?.maxRunSeconds > config.consolidation?.itemTimeoutSeconds);

console.log('\n[4] 边界输入不改写崩');
check('用户显式覆盖 maxHooks', (() => { const c = Config({ path: ':memory:', index: { maxHooks: 64 } }); return c.index.maxHooks === 64; })());
check('用户显式覆盖 expandBudgetTokens', (() => { const c = Config({ path: ':memory:', index: { expandBudgetTokens: 8000 } }); return c.index.expandBudgetTokens === 8000; })());
check('非法 maxHooks=0 被拒或回默认', (() => { try { const c = Config({ path: ':memory:', index: { maxHooks: 0 } }); return c.index.maxHooks >= 1; } catch { return true; } })());

console.log(`\n${failures === 0 ? '全部通过' : failures + ' 项失败'}`);
process.exit(failures === 0 ? 0 : 1);
