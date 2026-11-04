# -*- coding: utf-8 -*-
"""检索层对照：同一个题库、同样 k、同样输入，只换记忆系统。

只判「材料够不够」——材料里没有那一版，后面接多强的模型都答不对，故这是
任何 LLM 都突破不了的天花板。三口径：

  at_seq   答案「生效序号」那一版本身在不在材料里（现值/状态/时点题的硬门槛）
  chain    变更题：答案链的每个 seq 有多少落进材料
  hist     历史题：答案值对应的那一版在不在材料里

证据句一律按 cid 判，不靠正则——同体异名档（舟子/周舟）会让字面匹配假阴性。
"""
import json
import sys
from collections import Counter, defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parent
BENCH = Path('C:/Users/shaoz/Documents/GitHub/hive-memory-bench-main')
keys = json.load(open(BENCH / 'chain/keys/keys.json', encoding='utf-8'))
TYPES = ['现值', '历史', '时点', '状态归属', '缘由', '变更']


def load(name):
    d = json.load(open(ROOT / f'out/retrieval_{name}.json', encoding='utf-8'))
    return d, {r['qid']: r for r in d['rows']}


def evaluate(rows, mode):
    stat = defaultdict(Counter)
    for q in keys:
        if q.get('reconstructible') or q.get('ambiguous'):
            continue                      # 与判分器同口径，剔出主读数
        r = rows.get(q['qid'])
        if r is None:
            continue
        cids = {h['cid'] for h in r.get(mode, []) if h.get('cid')}
        t = q['type']
        stat[t]['n'] += 1
        stat[t]['blocks'] += len(cids)
        a = q['answer']

        if t in ('现值', '状态归属', '时点'):
            stat[t]['n'] += 0
            stat[t]['hit'] += 1 if a.get('at_seq') and f"{q['doc']}#{a['at_seq']}" in cids else 0
        elif t == '历史':
            chain = a.get('chain') or []
            want = {f"{q['doc']}#{c['seq']}" for c in chain if c.get('to') == a.get('value')}
            stat[t]['hit'] += 1 if want & cids else 0
        elif t == '缘由':
            stat[t]['hit'] += 1 if a.get('at_seq') and f"{q['doc']}#{a['at_seq']}" in cids else 0
        elif t == '变更':
            chain = a.get('change_chain') or a.get('chain') or []
            need = {f"{q['doc']}#{c['seq']}" for c in chain}
            stat[t]['hit'] += 1 if need and need <= cids else 0
            stat[t]['need'] += len(need)
            stat[t]['got'] += len(need & cids)
    return stat


def show(arms):
    for mode in ('raw', 'kw'):
        print(f"\n{'='*68}\n问法={mode}（{'题面整句' if mode == 'raw' else '主体＋属性'}）")
        head = f"{'题类':<7}" + ''.join(f"{a:>16}" for a in arms) 
        print(head)
        print(f"{'':7}" + ''.join(f"{'命中/题数':>16}" for _ in arms))
        print('-' * 68)
        per = {a: evaluate(rows, mode) for a, (_, rows) in arms.items()}
        for t in TYPES:
            line = f"{t:<7}"
            for a in arms:
                s = per[a][t]
                line += f"{s['hit']}/{s['n']:<14}" if s['n'] else f"{'—':>16}"
            print(line)
        line = f"{'合计':<7}"
        for a in arms:
            tot_hit = sum(per[a][t]['hit'] for t in TYPES)
            tot_n = sum(per[a][t]['n'] for t in TYPES)
            line += f"{tot_hit}/{tot_n} ({tot_hit/tot_n*100:.1f}%)".rjust(16)
        print('-' * 68)
        print(f"全体材料齐备率{mode:>4}: " + '  '.join(
            f"{a}={sum(per[a][t]['hit'] for t in TYPES)/sum(per[a][t]['n'] for t in TYPES)*100:.1f}%" for a in arms))
        if any(per[a]['变更']['need'] for a in arms):
            print('变更链平均覆盖: ' + '  '.join(
                f"{a}={per[a]['变更']['got']/per[a]['变更']['need']*100:.1f}%" for a in arms))


arms = {}
for name in sys.argv[1:] or ['loom', 'bm25']:
    d, rows = load(name)
    arms[name] = (d, rows)
    print(f"{name}: 写入 {d['n_ingested']} 段，检索题数 {len(rows)}")
show(arms)
