# -*- coding: utf-8 -*-
"""同一批题、同一历史，把「检索到了什么」逐条记下来 —— 覆盖率的差距到底在排名还是在归因。

`cover-22.py` 只回答「证据轮在不在 `used_turns` 里」。那个数低有两种完全不同的原因：

  A. **排名**：承载证据那件事的行，根本没进前 10；
  B. **归因**：行进了前 10（甚至进了提示词），但桥的 `usedTurns` 看不到它的来源轮
     —— 检索行上只有 `#E12`，没有轮次；只有展开的那两条 `#L` 才有。

这个脚本在每题截止轮上同时问两个系统：

  loom      `memory_search(limit=10)` 与 `(limit=50)`，把返回的引用逐条解回轮次
  bm25      官方 `Bm25Local`，同样的 10 + 最近 6 轮

产物每题一行：`{id, cutoff, ev, loom:[{rank,ref,turns}], loom50:[...], bm25:{...}}`。
有了它，「金标行在第几位」和「10 行覆盖了几个不同轮次」都是直接数出来的。

    python bench-22/probe-rank.py --out bench-22/work/rank-0278.jsonl
"""

import argparse
import json
import os
import re
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.environ.get("BENCH22_DATA") or os.path.join(
	os.path.expanduser("~"), "Desktop", "cmb-2.2", "benchmark-2.2", "dataset"
)
sys.path.insert(0, DATA)
sys.path.insert(0, os.path.join(os.path.dirname(DATA), "harness"))
sys.path.insert(0, HERE)

import sqlite3  # noqa: E402

from bench22.release import load_histories, load_items  # noqa: E402
from bench22.systems import Bm25Local  # noqa: E402
from loom_system import LoomClient, _ms  # noqa: E402

REF = re.compile(r"^\s*(\d+)\.\s.*?#([FEPL]\d+(?:-\d+)?)", re.M)


def resolve(db, refs):
	"""(#F12 之类) → 来源轮次集合。用产品的来源列，不做文本猜。"""
	row_turn = {}
	for rid, turn in db.execute("SELECT id, turn FROM l0"):
		row_turn[rid] = turn
	out = []
	for ref in refs:
		kind, body = ref[0], ref[1:]
		lo, _, hi = body.partition("-")
		got = set()
		if kind == "L":
			a, b = int(lo), int(hi or lo)
			# 行区间可能很长（覆盖上千行），只取端点附近不对——要全取
			for rid in range(a, b + 1):
				if rid in row_turn:
					got.add(row_turn[rid])
		elif kind == "E":
			r = db.execute("SELECT l0_from, l0_to FROM events WHERE id = ?", (int(lo),)).fetchone()
			if r:
				for rid in range(r[0], r[1] + 1):
					if rid in row_turn:
						got.add(row_turn[rid])
		elif kind == "F":
			r = db.execute("SELECT source_ids FROM facts WHERE id = ?", (int(lo),)).fetchone()
			if r:
				try:
					for rid in json.loads(r[0] or "[]"):
						if rid in row_turn:
							got.add(row_turn[rid])
				except (ValueError, TypeError):
					pass
		out.append({"ref": ref, "turns": sorted(got)})
	return out


def main():
	ap = argparse.ArgumentParser()
	ap.add_argument("--out", default=os.path.join(HERE, "work", "rank-0278.jsonl"))
	ap.add_argument("--persona", default="both")
	ap.add_argument("--limit", type=int, default=0)
	args = ap.parse_args()

	items = [i for i in load_items(DATA) if i.get("split") == "dev"]
	hist = load_histories(DATA)
	key_by_id = {
		r["id"]: r
		for r in (json.loads(line) for line in open(os.path.join(DATA, "review-only", "answer-key.jsonl"), encoding="utf-8") if line.strip())
	}
	personas = ["M01", "M02"] if args.persona == "both" else [args.persona]

	with open(args.out, "a", encoding="utf-8") as fh:
		for p in personas:
			todo = sorted([i for i in items if i["persona"] == p], key=lambda x: (x["cutoff_turn"], x["id"]))
			if args.limit:
				todo = todo[: args.limit]
			client = LoomClient()
			bm = Bm25Local()
			pos = 0
			turns = hist[p]
			t0 = time.time()
			for n, it in enumerate(todo, 1):
				while pos < it["cutoff_turn"]:
					t = dict(turns[pos])
					client.rpc("turn", sid=p, user=t["user"], assistant=t["assistant"], at=_ms(t["time"]))
					bm.ingest(t)
					pos += 1
				now = _ms(it["now"])
				client.rpc("block", sid=p, now=now)
				texts = {}
				for lim in (10, 50):
					texts[lim] = client.rpc("search", sid=p, query=it["question"], limit=lim, now=now)["text"]
				dbpath = client.rpc("stat")["db"]
				db = sqlite3.connect(f"file:{dbpath}?mode=ro", uri=True)
				try:
					got = {}
					for lim, text in texts.items():
						refs = [m[2] for m in REF.finditer(text)]
						got[lim] = resolve(db, refs)
				finally:
					db.close()
				# bm25：同样的历史，官方实现，排名顺序可取
				b = bm.retrieve(it["question"], it["now"], it["cutoff_turn"], item_id=it["id"])
				bturns = [int(t) for t in b.used_turns]
				row = {
					"id": it["id"], "persona": p, "cutoff": it["cutoff_turn"],
					"ev": [int(t) for t in ((key_by_id.get(it["id"]) or {}).get("evidence_turns") or [])],
					"loom10": got[10], "loom50": got[50],
					"bm25_turns": bturns,
					"bm25_prompt": len(b.prompt),
				}
				fh.write(json.dumps(row, ensure_ascii=False) + "\n")
				fh.flush()
				if n % 40 == 0:
					print(f"{p} {n}/{len(todo)}  {time.time() - t0:.0f}s", flush=True)
			client.close()
			print(f"{p} 完成 {len(todo)} 题，{time.time() - t0:.0f}s", flush=True)


if __name__ == "__main__":
	main()
