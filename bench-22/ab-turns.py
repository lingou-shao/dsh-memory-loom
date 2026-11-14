# -*- coding: utf-8 -*-
"""归因并集到底涨了多少 —— 在同一份提示词上事后分账，不是两次跑着比。

§116.4 记过一个坑：同一版本、同一份历史、同一个截止轮，两次跑出来的提示词会差
10–80 字（整合是异步的，`settle()` 让出多少轮会改排序）。那个量级和这次要量的
增量是同一个量级，所以「跑一遍关、跑一遍开，看覆盖率差多少」分不清是效应还是噪声。

好在提示词是在 `used_turns` 之前就拼完的：记账改不了上面任何一个字。于是适配器把
两路轮次都写进 `meta`（`used_base` = 老的 `#L` + 常驻块回查；`used_refs` = 检索行
来源列解回来的），`used_turns` 只是两者的并集。这个脚本就在**同一行**上算两个数。

    python bench-22/ab-turns.py --ctx bench-22/work/ctx-0279 \
        --baseline bench-22/work/ctx-0278-full

口径与 `cover-22.py` 的「轮次」一条完全一致（分母是 `evidence_turns` 里落在历史中的
那些轮），只换 `used` 的来源。
"""

import argparse
import json
import os
import statistics

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.environ.get("BENCH22_DATA") or os.path.join(
	os.path.expanduser("~"), "Desktop", "cmb-2.2", "benchmark-2.2", "dataset"
)


def jl(path):
	with open(path, encoding="utf-8") as fh:
		return [json.loads(line) for line in fh if line.strip()]


def turn_sets(row):
	"""一行里三种读法：老口径 / 只有来源列 / 并集。"""
	meta = row.get("meta") or {}
	base = {int(t) for t in (meta.get("used_base") or [])}
	refs = {int(t) for t in (meta.get("used_refs") or [])}
	union = {int(t) for t in (row.get("used_turns") or [])}
	return base, refs, union or (base | refs)


def main():
	ap = argparse.ArgumentParser()
	ap.add_argument("--ctx", default=os.path.join(HERE, "work", "ctx-0279"))
	ap.add_argument("--baseline", default=os.path.join(HERE, "work", "ctx-0278-full"))
	ap.add_argument("--dump", default="", help="逐题落到这个 jsonl（默认不写）")
	args = ap.parse_args()

	hist = {}
	for p in ("M01", "M02"):
		path = os.path.join(DATA, "histories", f"{p}.jsonl")
		hist[p] = {int(r["轮次"]) for r in jl(path)}
	key_by_id = {r["id"]: r for r in jl(os.path.join(DATA, "review-only", "answer-key.jsonl"))}

	base_old = {}
	if args.baseline:
		for p in ("M01", "M02"):
			path = os.path.join(args.baseline, p, "contexts.jsonl")
			if os.path.exists(path):
				for r in jl(path):
					base_old[r["id"]] = r

	tot = {"n": 0, "hit_base": 0, "hit_union": 0, "hit_refs": 0, "leak": 0, "old": 0, "old_hit": 0}
	dump = []
	print(f"{'':6} {'题':>5} {'老口径':>8} {'+来源列':>8} {'Δ':>6} {'增轮中位':>8} {'越界':>5} {'逐题变好/变坏':>14}")

	for persona in ("M01", "M02"):
		path = os.path.join(args.ctx, persona, "contexts.jsonl")
		if not os.path.exists(path):
			continue
		rows = jl(path)
		n = hb = hu = hr = leak = up = down = 0
		incs = []
		for row in rows:
			k = key_by_id.get(row["id"]) or {}
			turns = {int(t) for t in (k.get("evidence_turns") or [])} & hist[persona]
			if not turns:
				continue
			base, refs, union = turn_sets(row)
			n += 1
			rb = len(turns & base) / len(turns)
			ru = len(turns & union) / len(turns)
			rr = len(turns & refs) / len(turns)
			hb += rb > 0
			hu += ru > 0
			hr += rr > 0
			incs.append(len(union) - len(base))
			up += ru > rb
			down += ru < rb
			cut = row.get("cutoff_turn") or 0
			leak += any(t > cut for t in union)
			if args.baseline and row["id"] in base_old:
				old = {int(t) for t in (base_old[row["id"]].get("used_turns") or [])}
				tot["old"] += 1
				tot["old_hit"] += (len(turns & old) / len(turns)) > 0
			if args.dump:
				dump.append(
					{
						"id": row["id"],
						"evidence": sorted(turns),
						"base": sorted(base),
						"refs": sorted(refs),
						"union": sorted(union),
						"cov_base": round(rb, 4),
						"cov_union": round(ru, 4),
					}
				)
		tot["n"] += n
		tot["hit_base"] += hb
		tot["hit_union"] += hu
		tot["hit_refs"] += hr
		tot["leak"] += leak
		print(
			f"{persona:6} {n:5} {hb / n * 100:7.1f}% {hu / n * 100:7.1f}% "
			f"{(hu - hb) / n * 100:+5.1f} {statistics.median(incs):8.1f} {leak:5} {up:6}/{down:<6}"
		)

	n = tot["n"]
	print()
	print(f"=== 合计 {n} 题（{args.ctx}）===")
	print(f"  老口径（#L + 常驻块回查）  {tot['hit_base']}/{n} = {tot['hit_base'] / n * 100:.1f}%")
	print(f"  只按来源列                 {tot['hit_refs']}/{n} = {tot['hit_refs'] / n * 100:.1f}%")
	print(f"  并集（现在的 used_turns）  {tot['hit_union']}/{n} = {tot['hit_union'] / n * 100:.1f}%")
	print(f"  越界题（turn > cutoff）    {tot['leak']}")
	if tot["old"]:
		print(
			f"  〔跨跑参考〕旧产物同题 {tot['old']}：老口径 {tot['old_hit'] / tot['old'] * 100:.1f}% "
			f"→ 本次并集 {tot['hit_union'] / n * 100:.1f}%（差值含 §116.4 时序噪声，只做旁证）"
		)

	if args.dump:
		with open(args.dump, "w", encoding="utf-8") as fh:
			for row in dump:
				fh.write(json.dumps(row, ensure_ascii=False) + "\n")
		print(f"  逐题 -> {os.path.abspath(args.dump)}")


if __name__ == "__main__":
	main()
