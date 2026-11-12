# -*- coding: utf-8 -*-
"""自然用记忆榜的离线取面（不答题、不判分、不花钱）。

这一榜占综合分 **50%**，官方的 A 是 R 与 P 的调和平均，而 P 侧（不乱提）几乎白送，
所以全部战场在 R 侧：**该想起的时候，材料有没有进提示词**。

官方流程（`natural.py:run_item`）是「mark → 灌 tail → 取面 → rewind」，
这里一模一样，只是把 `answer_fn` 换成记录：

    python bench-22/probe_natural.py [--limit 0] [--out FILE]

量到的两件事：

1. `chars` / `tokens`：进提示词的记忆文本 —— 直接就是成本项 C 的分子。
2. `ev_hit / ev_total`：答案键 `evidence` 里每一条「第 N 轮 … user：原文」的 8 字窗，
   有多少落在提示词里。**这是代理指标**：它只说「材料到了」，不说「模型用得上」，
   更不说「提得自然」。Y / N0 / Z 三类（克制侧）离线判不了。
"""

import argparse
import json
import os
import re
import statistics
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
HARNESS = os.environ.get(
	"BENCH22_HARNESS", os.path.join(HERE, "..", "..", "cmb-2.2", "benchmark-2.2", "harness")
)
sys.path.insert(0, os.path.abspath(HARNESS))
sys.path.insert(0, HERE)

from loom_system import LoomSystem  # noqa: E402

DATA = os.environ.get(
	"BENCH22_DATA", os.path.join(HERE, "..", "..", "cmb-2.2", "benchmark-2.2", "dataset")
)

MEM_TOK_PER_CHAR = 0.70
FLASH_IN_PER_MTOK = 1.296
WINDOW = 8
# 证据行长这样：`- 第1347轮 2026-10-03 05:57 user：我拔的是左下那颗…`
EVIDENCE_LINE = re.compile(r"user[:：]\s*(.+)$")


def jl(path):
	out = []
	with open(path, encoding="utf-8") as fh:
		for line in fh:
			if line.strip():
				out.append(json.loads(line))
	return out


def squash(text):
	return re.sub(r"\s+", "", text or "")


def windows(text, size=WINDOW):
	body = squash(text)
	if len(body) <= size:
		return [body] if len(body) >= 4 else []
	return [body[i : i + size] for i in range(len(body) - size + 1)]


def evidence_texts(evidence):
	"""把 `evidence` 里带 `user：` 的行切出来，其余（F1/F2 事实行）也当成证据。"""
	out = []
	for line in (evidence or "").splitlines():
		line = line.strip().lstrip("-").strip()
		if not line:
			continue
		m = EVIDENCE_LINE.search(line)
		if m:
			out.append(m.group(1).strip())
			continue
		# `F1：用户约了大后天去L10医院拔智齿` —— 去掉编号前缀
		out.append(re.sub(r"^F\d+[:：]\s*", "", line))
	return [x for x in out if len(squash(x)) >= 4]


def main():
	ap = argparse.ArgumentParser()
	ap.add_argument("--limit", type=int, default=0)
	ap.add_argument("--out", default=os.path.join(HERE, "work", "natural-22.jsonl"))
	args = ap.parse_args()

	probes = jl(os.path.join(DATA, "natural", "natural-probes-dev.jsonl"))
	key = {k["id"]: k for k in jl(os.path.join(DATA, "natural", "natural-key-dev.jsonl"))}
	probes = [p for p in probes if p["id"] in key]
	# B 档（19 个）是「现场多轮」：探针要接上系统自己的回复再往下问，离线和真值都
	# 拿不到那几句回复，所以只跑 A 档（76 个）。B 档留给真跑（要答题模型）。
	skipped = [p for p in probes if p["tier"] != "A"]
	probes = [p for p in probes if p["tier"] == "A"]
	hist = {}
	for p in ("M01", "M02"):
		hist[p] = [
			{"turn": r["轮次"], "time": r["逻辑时间"], "user": r["用户消息"], "assistant": r["助手回复"]}
			for r in jl(os.path.join(DATA, "histories", f"{p}.jsonl"))
		]

	os.makedirs(os.path.dirname(os.path.abspath(args.out)), exist_ok=True)
	rows = []
	started = time.time()
	for persona in ("M01", "M02"):
		todo = sorted([p for p in probes if p["persona"] == persona], key=lambda p: (p["cutoff_turn"], p["id"]))
		if args.limit:
			todo = todo[: args.limit]
		if not todo:
			continue
		system = LoomSystem()
		system.sid = persona
		pos = 0
		print(f"{persona}: {len(todo)} 个探针", flush=True)
		t0 = time.time()
		for n, p in enumerate(todo):
			while pos < p["cutoff_turn"]:
				row = hist[persona][pos]
				system.ingest({"turn": row["turn"], "time": row["time"], "user": row["user"], "assistant": row["assistant"]})
				pos += 1
			tok = system.mark()
			seq = p["cutoff_turn"]
			for tt in p.get("tail") or []:
				seq += 1
				system.ingest({"turn": seq, "time": tt["time"], "user": tt["user"], "assistant": tt["assistant"]})
			probe = p["probe"]
			ret = system.retrieve(probe["user"], probe["time"], seq, item_id=p["id"])
			system.rewind(tok)

			prompt_sq = squash(ret.prompt)
			evs = evidence_texts(key[p["id"]].get("evidence"))
			hit = tot = 0
			for ev in evs:
				wins = windows(ev)
				hit += sum(1 for w in wins if w in prompt_sq)
				tot += len(wins)
			k = key[p["id"]]
			rows.append(
				{
					"id": p["id"],
					"persona": persona,
					"class": k["class"],
					"tier": p["tier"],
					"cutoff_turn": p["cutoff_turn"],
					"chars": len(ret.prompt),
					"tokens": round(len(ret.prompt) * MEM_TOK_PER_CHAR),
					"refs": ret.meta.get("refs", 0),
					"block_lines": ret.meta.get("block_lines", 0),
					"leak": [t for t in ret.used_turns if t > seq],
					"n_evidence": len(evs),
					"ev_hit": hit,
					"ev_total": tot,
					"cover_full": bool(tot) and hit == tot,
					"cover_any": bool(hit),
				}
			)
			if (n + 1) % 10 == 0:
				print(f"  [{n + 1}/{len(todo)}] 灌到第 {pos} 轮，{time.time() - t0:.0f}s", flush=True)
		system.close()
		print(f"{persona} 完成，{time.time() - t0:.0f}s", flush=True)

	with open(args.out, "w", encoding="utf-8") as fh:
		for row in rows:
			fh.write(json.dumps(row, ensure_ascii=False) + "\n")

	print(f"（跳过 B 档 {len(skipped)} 个：需要系统自己的回复）", flush=True)
	print(f"\n=== 汇总（{len(rows)} 个探针，{time.time() - started:.0f}s）===", flush=True)
	for persona in ("M01", "M02"):
		sub = [r for r in rows if r["persona"] == persona]
		if not sub:
			continue
		tok = sum(r["tokens"] for r in sub)
		c = tok * FLASH_IN_PER_MTOK / 1e6
		print(
			f"{persona}: {len(sub)} 探针  token 中位 {statistics.median(r['tokens'] for r in sub):.0f}  合计 {tok}"
			f" → C={c:.3f}  证据全中 {sum(r['cover_full'] for r in sub)}/{len(sub)}"
			f"  沾到 {sum(r['cover_any'] for r in sub)}/{len(sub)}  泄漏 {sum(1 for r in sub if r['leak'])}",
			flush=True,
		)
		for cls in ("X", "H", "Y", "Z", "N0"):
			g = [r for r in sub if r["class"] == cls]
			if g:
				print(
					f"  {cls}: {len(g):>2} 个  全中 {sum(x['cover_full'] for x in g):>2}  沾到 {sum(x['cover_any'] for x in g):>2}"
					f"  token 中位 {statistics.median(x['tokens'] for x in g):.0f}",
					flush=True,
				)
	return 0


if __name__ == "__main__":
	sys.exit(main())
