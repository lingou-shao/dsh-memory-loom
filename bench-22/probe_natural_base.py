# -*- coding: utf-8 -*-
"""自然用记忆榜的**对照臂**：官方内置基线在同一批探针上的「材料到没到」。

`probe_natural.py` 只跑我们自己的面。要判断我们的 R 侧到底是强是弱，得有一列对照——
官方 `REGISTRY` 里 `bm25-recent6` / `recent6` / `full-context` 都是**纯 Python、零模型调用**，
所以能在离线口径下逐题对齐（同一套 8 字窗、同一个 token 折算）。

    python bench-22/probe_natural_base.py --system bm25-recent6 \
        --out bench-22/work/natural-bm25.jsonl

注意两件事，写结论时必须带上：

1. **这不是 A 分。** 只量「证据的 8 字窗有没有进提示词」，与判分员无关。
2. **各臂的提示词结构不同**（基线有 `【最近的对话】` 六轮，我们没有），所以 token 列只能
   当成本量级看，不能当「同等条件下的差异」。
"""

import argparse
import json
import os
import re
import statistics
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

# `probe_natural` 在导入时就会拉起 `loom_system`（它要 `bench22` 在 path 上），
# 所以这里必须先把 harness 找出来——路径解析逻辑复用它的 `_pick`。
from probe_natural import (  # noqa: E402
	FLASH_IN_PER_MTOK,
	HARNESS,
	MEM_TOK_PER_CHAR,
	_pick,
	evidence_texts,
	jl,
	squash,
	windows,
)

DATA = _pick("BENCH22_DATA", "benchmark-2.2", "dataset")


def data_path(*parts):
	return os.path.join(DATA, *parts)


def load_system(name):
	"""从官方 REGISTRY 取一个不依赖网关的臂。"""
	sys.path.insert(0, HARNESS)
	from bench22.systems import REGISTRY  # noqa: E402

	if name not in REGISTRY:
		raise SystemExit(f"没有这个臂：{name}，可选 {sorted(REGISTRY)}")
	return REGISTRY[name](None)


def main():
	ap = argparse.ArgumentParser()
	ap.add_argument("--system", default="bm25-recent6")
	ap.add_argument("--limit", type=int, default=0)
	ap.add_argument("--out", default="")
	args = ap.parse_args()
	out = args.out or os.path.join(HERE, "work", f"natural-{args.system}.jsonl")

	probes = jl(data_path("natural", "natural-probes-dev.jsonl"))
	key = {k["id"]: k for k in jl(data_path("natural", "natural-key-dev.jsonl"))}
	probes = [p for p in probes if p["id"] in key and p["tier"] == "A"]
	hist = {}
	for p in ("M01", "M02"):
		hist[p] = [
			{"turn": r["轮次"], "time": r["逻辑时间"], "user": r["用户消息"], "assistant": r["助手回复"]}
			for r in jl(data_path("histories", f"{p}.jsonl"))
		]

	os.makedirs(os.path.dirname(os.path.abspath(out)), exist_ok=True)
	rows = []
	started = time.time()
	for persona in ("M01", "M02"):
		todo = sorted([p for p in probes if p["persona"] == persona], key=lambda p: (p["cutoff_turn"], p["id"]))
		if args.limit:
			todo = todo[: args.limit]
		if not todo:
			continue
		system = load_system(args.system)
		pos = 0
		print(f"{persona}: {len(todo)} 个探针（{system.name}）", flush=True)
		t0 = time.time()
		for n, p in enumerate(todo):
			while pos < p["cutoff_turn"]:
				system.ingest(hist[persona][pos])
				pos += 1
			tok = system.mark()
			seq = p["cutoff_turn"]
			for tt in p.get("tail") or []:
				seq += 1
				system.ingest({"turn": seq, "time": tt["time"], "user": tt["user"], "assistant": tt["assistant"]})
			ret = system.retrieve(p["probe"]["user"], p["probe"]["time"], seq, item_id=p["id"])
			system.rewind(tok)

			prompt_sq = squash(ret.prompt)
			k = key[p["id"]]
			evs = evidence_texts(k.get("evidence"))
			hit = tot = 0
			for ev in evs:
				wins = windows(ev)
				hit += sum(1 for w in wins if w in prompt_sq)
				tot += len(wins)
			ev_turns = {int(n) for n in re.findall(r"第(\d+)轮", k.get("evidence") or "")}
			used = set(ret.used_turns or [])
			turn_hit = len(ev_turns & used)
			rows.append(
				{
					"id": p["id"],
					"persona": persona,
					"class": k["class"],
					"tier": p["tier"],
					"system": system.name,
					"cutoff_turn": p["cutoff_turn"],
					"chars": len(ret.prompt),
					"tokens": round(len(ret.prompt) * MEM_TOK_PER_CHAR),
					"leak": [t for t in (ret.used_turns or []) if t > seq],
					"n_evidence": len(evs),
					"ev_hit": hit,
					"ev_total": tot,
					"cover_full": bool(tot) and hit == tot,
					"cover_any": bool(hit),
					"ev_turns": sorted(ev_turns),
					"used_turns": sorted(used),
					"turn_hit": turn_hit,
					"turn_total": len(ev_turns),
					"turn_full": bool(ev_turns) and turn_hit == len(ev_turns),
					"turn_any": bool(ev_turns) and turn_hit > 0,
				}
			)
			if (n + 1) % 20 == 0:
				print(f"  [{n + 1}/{len(todo)}] 灌到第 {pos} 轮，{time.time() - t0:.0f}s", flush=True)
		print(f"{persona} 完成，{time.time() - t0:.0f}s", flush=True)

	with open(out, "w", encoding="utf-8") as fh:
		for row in rows:
			fh.write(json.dumps(row, ensure_ascii=False) + "\n")

	print(f"\n=== {args.system}：{len(rows)} 个探针，{time.time() - started:.0f}s ===", flush=True)
	for persona in ("M01", "M02"):
		sub = [r for r in rows if r["persona"] == persona]
		if not sub:
			continue
		tok = sum(r["tokens"] for r in sub)
		print(
			f"{persona}: token 中位 {statistics.median(r['tokens'] for r in sub):.0f} 合计 {tok}"
			f" → C={tok * FLASH_IN_PER_MTOK / 1e6:.3f}"
			f"  全中 {sum(r['cover_full'] for r in sub)}/{len(sub)}  沾到 {sum(r['cover_any'] for r in sub)}/{len(sub)}"
			f"  泄漏 {sum(1 for r in sub if r['leak'])}",
			flush=True,
		)
	return 0


if __name__ == "__main__":
	sys.exit(main())
