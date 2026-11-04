# -*- coding: utf-8 -*-
"""L0 FTS 的天花板：变更链缺口里，有多少能被「原文倒排」补回来。

背景（design §36.2 / §36.3）：events 的索引文本只有 title+summary+aliases，
原文不进索引。`l0.tokens` 一直在写但没人读。问题是补一张 L0 FTS 表之后，
缺口能补多少、代价多少。

口径：
  - 题：变更类、非 reconstructible、非 ambiguous（与判分器同口径）。
  - 缺口 gap = 该题 change_chain 的全部 seq − 现有 hits 已覆盖的 cid。
  - 用 L0 原文建临时 FTS 表，按同一套分词（CJK bigram + latin + digit）检索：
      strict = 全部 token AND（等价 compileMatch）
      loose  = token OR + containment ≥ 0.25（等价 compileLooseMatch 的门）
  - 指标：
      gap_recall  = 补回的 gap / 全部 gap
      precision   = 新增材料里属于 gap 的比例（越低越像「大面积滚回原文」）
      added_chars = 要多读多少字

用法：python bench-hmb/analyze-l0-gap.py [--arm loom-epB] [--top 12]
"""
import json
import re
import sqlite3
import sys
from collections import Counter, defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parent
BENCH = Path('C:/Users/shaoz/Documents/GitHub/hive-memory-bench-main')

arm = 'loom-epB'
top_n = 12
for i, a in enumerate(sys.argv):
    if a == '--arm':
        arm = sys.argv[i + 1]
    if a == '--top':
        top_n = int(sys.argv[i + 1])

DB = ROOT / f'out/{arm}.db'
HITS = ROOT / f'out/retrieval_{arm}.json'
CJKR = re.compile(r'[\u4e00-\u9fff\u3040-\u309f\u30a0-\u30ff\uac00-\ud7af]+')
LATIN = re.compile(r"[A-Za-z][A-Za-z0-9_'-]*")
DIGIT = re.compile(r'\d+(?:[.:-]\d+)*')


def tokens_of(text):
    out = []
    for m in CJKR.finditer(text):
        chars = list(m.group(0))
        for k in range(len(chars) - 1):
            out.append(chars[k] + chars[k + 1])
        if len(chars) == 1:
            out.append(chars[0])
    out += [m.group(0).lower() for m in LATIN.finditer(text)]
    out += [m.group(0) for m in DIGIT.finditer(text)]
    return out


def uniq(text, limit):
    seen, out = set(), []
    for t in tokens_of(text):
        if t in seen:
            continue
        seen.add(t)
        out.append(t)
        if len(out) >= limit:
            break
    return out


def containment(needle, haystack):
    small, large = set(tokens_of(needle)), set(tokens_of(haystack))
    if not small:
        return 0.0
    return len(small & large) / len(small)


keys = json.load(open(BENCH / 'chain/keys/keys.json', encoding='utf-8'))
rows = {r['qid']: r for r in json.load(open(HITS, encoding='utf-8'))['rows']}
cidmap = {e['cid']: e for e in json.load(open(f'{DB}.cidmap.json', encoding='utf-8'))}

db = sqlite3.connect(DB)
l0 = {i: t for i, t in db.execute('SELECT id, text FROM l0')}
fts = sqlite3.connect(':memory:')
fts.execute('CREATE VIRTUAL TABLE l0fts USING fts5(tokens, text, cid UNINDEXED)')
for i, text in l0.items():
    # 反向查 cid：cidmap 是 1:1 的 l0 区间
    hit = next((c for c, e in cidmap.items() if e['from'] <= i <= e['to']), None)
    if hit is None:
        continue
    fts.execute('INSERT INTO l0fts (tokens, text, cid) VALUES (?,?,?)',
                (' '.join(tokens_of(text)), text, hit))
fts.commit()


def query_l0(q, mode):
    if mode == 'strict':
        expr = ' '.join(f'"{t}"' for t in uniq(q, 24))
    else:
        expr = ' OR '.join(f'"{t}"' for t in uniq(q, 12))
    if not expr:
        return []
    out = []
    for tokens, text, cid in fts.execute(
            'SELECT tokens, text, cid FROM l0fts WHERE l0fts MATCH ? ORDER BY bm25(l0fts) LIMIT ?',
            (expr, top_n)):
        if mode == 'loose' and containment(q, text) < 0.25:
            continue
        out.append((cid, len(text)))
    return out


def run(mode):
    """mode: raw / kw —— 用哪种问法去查 L0。"""
    stat = defaultdict(Counter)
    for q in keys:
        if q.get('reconstructible') or q.get('ambiguous') or q['type'] != '变更':
            continue
        r = rows.get(q['qid'])
        if not r:
            continue
        chain = q['answer'].get('change_chain') or q['answer'].get('chain') or []
        need = {f"{q['doc']}#{c['seq']}" for c in chain}
        if not need:
            continue
        got = {h['cid'] for h in r.get(mode, []) if h.get('cid')}
        gap = need - got
        if not gap:
            continue
        text = q['question'] if mode == 'raw' else f"{q['subject']} {q['slot']}"
        for kind in ('strict', 'loose'):
            hits = query_l0(text, kind)
            cids = {c for c, _ in hits}
            new = cids - got
            found = gap & cids
            s = stat[kind]
            s['q'] += 1
            s['gap'] += len(gap)
            s['found'] += len(found)
            s['new'] += len(new)
            s['new_hit'] += len(gap & new)
            s['chars'] += sum(n for c, n in hits if c in new)
            if found:
                s['q_help'] += 1
    return stat


print(f'arm={arm}  L0 行数={len(l0)}  top={top_n}')
for mode in ('kw', 'raw'):
    stat = run(mode)
    print(f"\n问法={mode}")
    for kind in ('strict', 'loose'):
        s = stat[kind]
        if not s['q']:
            continue
        prec = s['new_hit'] / s['new'] * 100 if s['new'] else 0
        print(f"  {kind:6} 有缺口的题={s['q']:3}  补回 {s['found']}/{s['gap']} = "
              f"{s['found']/s['gap']*100:5.1f}%   新增材料={s['new']:4} 条"
              f"（其中缺口 {s['new_hit']}，精度 {prec:4.1f}%）"
              f"  多读 {s['chars']/max(1,s['q']):5.0f} 字/题")
