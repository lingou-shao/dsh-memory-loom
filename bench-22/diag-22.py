# -*- coding: utf-8 -*-
"""离线分析取面产物（`probe_surface.py` 的 jsonl）。

取面一次要 86 分钟，所以「改判据 → 重算」必须在这一层做，不要重灌。
这里只读 jsonl + 答案键，几秒出结果。

    python bench-22/diag-22.py [--surface bench-22/work/surface-22.jsonl] [--worst 15]

三张表：

1. **按 probe_type**（implicit / regular / due_day / time_twin / legacy / premise_twin …）——
   哪一类题材料进不了提示词。`implicit` 是「暗考」，最像自然榜的 X 类。
2. **按 C**（每题 token）——成本项到底站在哪个位置，以及是哪一段把它撑大的。
3. **失败清单**——`ev_hit == 0` 的题，附 `block_lines` 与 `refs`，用来分辨
   「常驻块没带出来」还是「检索没搜到」。
"""

import argparse
import json
import os
import statistics

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.environ.get(
	"BENCH22_DATA", os.path.join(HERE, "..", "..", "cmb-2.2", "benchmark-2.2", "dataset")
)
CONTROL_KINDS = {"control"}


def jl(path):
	out = []
	with open(path, encoding="utf-8") as fh:
		for line in fh:
			if line.strip():
				out.append(json.loads(line))
	return out


def pct(n, d):
	return f"{n}/{d} = {100.0 * n / d:.1f}%" if d else "—"


def main():
	ap = argparse.ArgumentParser()
	ap.add_argument("--surface", default=os.path.join(HERE, "work", "surface-22.jsonl"))
	ap.add_argument("--worst", type=int, default=15)
	args = ap.parse_args()

	rows = jl(args.surface)
	key = {k["id"]: k for k in jl(os.path.join(DATA, "review-only", "answer-key.jsonl"))}
	# 问句不在答案键上，在 `exam-inputs.jsonl` 上
	question = {r["id"]: r["question"] for r in jl(os.path.join(DATA, "exam-inputs.jsonl"))}

	def meta(r):
		k = key.get(r["id"], {})
		return k.get("probe_type") or "?", k.get("kind") or "?", (k.get("difficulty") or {}).get("level") or "?"

	print(f"取面产物 {len(rows)} 题\n")
	print("== 总览 ==")
	for p in ("M01", "M02"):
		sub = [r for r in rows if r["persona"] == p]
		if not sub:
			continue
		tok = statistics.median(r["tokens"] for r in sub)
		print(
			f"{p}: {len(sub)} 题  token 中位 {tok:.0f}  证据全中 {pct(sum(r['cover_full'] for r in sub), len(sub))}"
			f"  沾到 {pct(sum(r['cover_any'] for r in sub), len(sub))}  零共享 {sum(1 for r in sub if r['ev_total'] and not r['ev_hit'])}"
			f"  泄漏 {sum(1 for r in sub if r['leak'])}"
		)

	print("\n== 按 probe_type ==")
	groups = {}
	for r in rows:
		pt, kind, lv = meta(r)
		if kind in CONTROL_KINDS:
			continue
		g = groups.setdefault((r["persona"], pt), [])
		g.append(r)
	for (p, pt), sub in sorted(groups.items()):
		print(
			f"  {p} {pt:<18} {len(sub):>3} 题  全中 {pct(sum(x['cover_full'] for x in sub), len(sub)):>14}"
			f"  沾到 {pct(sum(x['cover_any'] for x in sub), len(sub)):>14}"
			f"  token 中位 {statistics.median(x['tokens'] for x in sub):.0f}"
		)

	print("\n== 按难度 ==")
	by = {}
	for r in rows:
		pt, kind, lv = meta(r)
		if kind in CONTROL_KINDS:
			continue
		by.setdefault((r["persona"], lv), []).append(r)
	for (p, lv), sub in sorted(by.items()):
		print(f"  {p} {lv}  {len(sub):>3} 题  全中 {pct(sum(x['cover_full'] for x in sub), len(sub))}")

	print(f"\n== 零共享的题（前 {args.worst} 条）==")
	bad = [r for r in rows if r["ev_total"] and not r["ev_hit"]]
	bad.sort(key=lambda r: r["id"])
	for r in bad[: args.worst]:
		pt, kind, lv = meta(r)
		q = question.get(r["id"], "")
		print(
			f"  {r['id']:<22} cutoff {r['cutoff_turn']:>5}  {pt:<14} {lv}  "
			f"block {r['block_lines']:>2} 行  refs {r['refs']:>2}  {r['chars']:>5} 字  {q[:34]}"
		)
	print(f"  共 {len(bad)} 题零共享（占可判的 {100.0 * len(bad) / max(1, len([r for r in rows if r['ev_total']])):.1f}%）")
	return 0


if __name__ == "__main__":
	raise SystemExit(main())
