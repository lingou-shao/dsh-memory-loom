# -*- coding: utf-8 -*-
"""用仓库自带的 BM25 参考实现跑同一套检索，作为对照。

不改仓库任何文件，只 import 它的 adapter——这样两边的输入（题面）、k、语料
完全一致，差异只剩「记忆系统本身」。
"""
import json
import sys
import time
from pathlib import Path

BENCH = Path('C:/Users/shaoz/Documents/GitHub/hive-memory-bench-main')
sys.path.insert(0, str(BENCH / 'chain/harness'))   # naive_bm25 内部 `import common`
sys.path.insert(0, str(BENCH / 'chain'))           # 让 harness 是个包，相对导入才成立

from harness.adapters.naive_bm25 import BM25Adapter  # noqa: E402

corpus = json.load(open(BENCH / 'chain/corpus/corpus.json', encoding='utf-8'))
keys = json.load(open(BENCH / 'chain/keys/keys.json', encoding='utf-8'))

chapters = [{'cid': c['cid'], 'title': c['doc'], 'text': c['text']} for c in corpus]
ad = BM25Adapter()
t0 = time.time()
print('ingest:', ad.ingest(chapters), f'{time.time()-t0:.1f}s')

k_of = lambda q: 50 if q['type'] == '变更' else 6
rows = []
t0 = time.time()
for q in keys:
    k = k_of(q)
    rec = {'qid': q['qid'], 'type': q['type'], 'k': k}
    for mode, query in (('raw', q['question']), ('kw', f"{q['subject']} {q['slot']}")):
        hits = ad.retrieve(query, k=k)
        rec[mode] = [{'cid': h.get('cid'), 'chars': len(h.get('text') or '')} for h in hits]
    rows.append(rec)
print(f'检索 {len(rows)} 题 {time.time()-t0:.1f}s')

out = Path(__file__).resolve().parent / 'out/retrieval_bm25.json'
out.parent.mkdir(exist_ok=True)
json.dump({'arm': 'bm25', 'n_ingested': len(corpus), 'rows': rows},
          open(out, 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
print('→', out)
