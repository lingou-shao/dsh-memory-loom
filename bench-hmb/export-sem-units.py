# -*- coding: utf-8 -*-
"""把一臂的库导成「可向量检索的单元」+「可判分的题目」，供离线语义实验用。

不碰产品代码：只读 loom 自己写下的库，按它索引时用的同一段文本建单元
（事实＝text＋aliases，事件＝title：summary＋aliases），再给每个单元挂上
它对应的 cid，好让判分口径和 eval-compare.py 完全一致。

用法：
    python bench-hmb/export-sem-units.py --arm loom-epB --out bench-hmb/out/sem
"""
from __future__ import annotations

import argparse
import json
import sqlite3
from pathlib import Path

ROOT = Path(__file__).resolve().parent
BENCH = Path('C:/Users/shaoz/Documents/GitHub/hive-memory-bench-main')


def l0_to_cid(arm: str) -> dict[int, str]:
    """l0 行号 → cid。桥写下的账本，一段 l0 对应一个 cid。"""
    path = ROOT / f'out/{arm}.db.cidmap.json'
    table: dict[int, str] = {}
    for entry in json.load(open(path, encoding='utf-8')):
        for i in range(int(entry['from']), int(entry['to']) + 1):
            table.setdefault(i, entry['cid'])
    return table


def units_of(db: sqlite3.Connection, ledger: dict[int, str]) -> list[dict]:
    units: list[dict] = []
    for fid, text, aliases, source_ids in db.execute(
            "SELECT id, text, aliases, source_ids FROM facts WHERE status IN ('active','disputed')"):
        try:
            ids = json.loads(source_ids or '[]')
        except json.JSONDecodeError:
            ids = []
        cid = next((ledger[i] for i in ids if i in ledger), None)
        body = f"{text} {aliases}".strip()
        units.append({'ref': f'F{fid}', 'kind': 'fact', 'id': fid, 'cid': cid, 'text': body})

    for eid, title, summary, aliases, l0_from in db.execute(
            "SELECT id, title, summary, aliases, l0_from FROM events WHERE status = 'active'"):
        cid = ledger.get(int(l0_from)) if l0_from is not None else None
        body = f"{title}：{summary} {aliases}".strip()
        units.append({'ref': f'E{eid}', 'kind': 'event', 'id': eid, 'cid': cid, 'text': body})

    return [u for u in units if u['cid']]


def questions_of() -> list[dict]:
    keys = json.load(open(BENCH / 'chain/keys/keys.json', encoding='utf-8'))
    out = []
    for q in keys:
        if q.get('reconstructible') or q.get('ambiguous'):
            continue
        a = q['answer']
        if not isinstance(a, dict):
            continue
        t = q['type']
        need: list[str] = []
        if t in ('现值', '状态归属', '时点', '缘由'):
            if a.get('at_seq'):
                need = [f"{q['doc']}#{a['at_seq']}"]
        elif t == '历史':
            need = [f"{q['doc']}#{c['seq']}" for c in (a.get('chain') or []) if c.get('to') == a.get('value')]
        elif t == '变更':
            need = [f"{q['doc']}#{c['seq']}" for c in (a.get('change_chain') or a.get('chain') or [])]
        out.append({
            'qid': q['qid'], 'type': t, 'doc': q['doc'],
            'question': q['question'], 'need': sorted(set(need)),
            'all_needed': t == '变更',
        })
    return out


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument('--arm', default='loom-epB')
    ap.add_argument('--out', default=str(ROOT / 'out/sem'))
    args = ap.parse_args()

    ledger = l0_to_cid(args.arm)
    db = sqlite3.connect(ROOT / f'out/{args.arm}.db')
    units = units_of(db, ledger)
    questions = questions_of()

    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    json.dump(units, open(out / 'units.json', 'w', encoding='utf-8'), ensure_ascii=False)
    json.dump(questions, open(out / 'questions.json', 'w', encoding='utf-8'), ensure_ascii=False)

    kinds = {}
    for u in units:
        kinds[u['kind']] = kinds.get(u['kind'], 0) + 1
    print(f'单元 {len(units)} {kinds}｜题目 {len(questions)}｜有 cid 的单元 {len(units)}')


if __name__ == '__main__':
    main()
