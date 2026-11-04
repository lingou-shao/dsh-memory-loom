# -*- coding: utf-8 -*-
"""检索层评估：只问「材料够不够」，不问「答得对不对」。

判分链要 DEEPSEEK_API_KEY，这一步不需要——把 loom 检索回来的材料与答案键
做机械比对，就能知道这个系统在这套题上有没有下限。

两种问法各报一遍：
  raw —— 题面整句（与 BM25 基线同输入，公平地板）
  kw  —— 主体＋属性（模型真会用的关键词式查询）

口径：
  · 证据可得（evidence）：材料里有没有那句「{subject} 的 {slot} … {value}」，且序号不晚于取样点。
  · 时点命中（at_seq）：答案的生效序号那一版本身在不在材料里。
  · 链覆盖（chain）：变更题专用，答案链每个 seq 有多少落进材料。
"""
import json
import re
import sys
from collections import Counter, defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parent
BENCH = Path('C:/Users/shaoz/Documents/GitHub/hive-memory-bench-main')
keys = json.load(open(BENCH / 'chain/keys/keys.json', encoding='utf-8'))
corpus = json.load(open(BENCH / 'chain/corpus/corpus.json', encoding='utf-8'))
run = json.load(open(ROOT / 'out/retrieval_loom.json', encoding='utf-8'))

seq_of_cid = {c['cid']: c['seq'] for c in corpus}
text_of_cid = {c['cid']: c['text'] for c in corpus}


def setting_pattern(subject, slot, value):
    return re.compile(
        re.escape(subject) + r'\s*的' + re.escape(slot) + r'\s*(?:首次确立为|调整为)\s*' + re.escape(value)
    )


by_qid = {r['qid']: r for r in run['rows']}
MODES = ['raw', 'kw']
TYPES = ['现值', '历史', '时点', '状态归属', '缘由', '变更']


def evaluate(mode):
    stat = defaultdict(Counter)
    for q in keys:
        if q.get('reconstructible') or q.get('ambiguous'):
            continue                      # 与判分器同口径，剔出主读数
        r = by_qid.get(q['qid'])
        if r is None:
            continue
        cids = [h['cid'] for h in r.get(mode, []) if h.get('cid')]
        t = q['type']
        stat[t]['n'] += 1
        stat[t]['material'] += len(cids)
        a = q['answer']
        value, at_seq = a.get('value'), a.get('at_seq')

        if value:
            pat = setting_pattern(q['subject'], q['slot'], str(value))
            ok = any(pat.search(text_of_cid.get(c, '')) and seq_of_cid.get(c, 10 ** 6) <= q['sample_at_seq']
                     for c in cids)
            stat[t]['evidence'] += 1 if ok else 0

        if at_seq:
            stat[t]['at_seq'] += 1 if f"{q['doc']}#{at_seq}" in set(cids) else 0

        if t == '变更':
            chain = a.get('change_chain') or a.get('chain') or []
            need = {f"{q['doc']}#{c['seq']}" for c in chain}
            stat[t]['need'] += len(need)
            stat[t]['got'] += len(need & set(cids))
    return stat


for mode in MODES:
    stat = evaluate(mode)
    label = '题面整句' if mode == 'raw' else '主体+属性'
    print(f"\n=== {mode}（{label}）===")
    print(f"{'题类':<6}{'题数':>5}{'均材料块':>9}{'证据可得':>10}{'时点命中':>10}{'链覆盖':>9}")
    print('-' * 52)
    tot = Counter()
    for t in TYPES:
        s = stat[t]
        n = s['n']
        if n == 0:
            continue
        for k in ('n', 'evidence', 'at_seq', 'material', 'need', 'got'):
            tot[k] += s[k]
        ch = f"{s['got']/s['need']*100:.1f}%" if s['need'] else '—'
        print(f"{t:<6}{n:>5}{s['material']/n:>9.1f}{s['evidence']/n*100:>9.1f}%{s['at_seq']/n*100:>9.1f}%{ch:>9}")
    print('-' * 52)
    print(f"{'合计':<6}{tot['n']:>5}{tot['material']/tot['n']:>9.1f}"
          f"{tot['evidence']/tot['n']*100:>9.1f}%{tot['at_seq']/tot['n']*100:>9.1f}%"
          f"{tot['got']/tot['need']*100:>8.1f}%")
