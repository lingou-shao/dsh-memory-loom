# -*- coding: utf-8 -*-
"""离线取面：把 2.2 dev 集整卷取一遍，不花一分钱。

要回答三个问题（都不需要答题模型）：

1. **成本项 C 是多少**——记忆文本进提示词的 token 数 × flash 输入价。
   官方口径 `MEM_TOK_PER_CHAR = 0.70`，和 `runner.py` 同一常数。
2. **材料进没进提示词**——答案键给了 `evidence_turns`（承载要点的原始轮次）。
   取这些轮次用户消息的 8 字窗，看提示词里有没有。这是「R 侧能不能想起」的
   离线代理，官方 qwen-base 的这一格是 59.1%。**代理就是代理**：它只量「字面
   进没进」，不量模型用不用得上（714 那套 §57 量过，检索面 662 对判分 689，
   差 27 题）。
3. **有没有越界**——`used_turns` 里出现截止轮之后的轮次就是泄漏。

    python bench-22/probe_surface.py --split dev [--limit 5] [--out FILE]

时间：整卷 = 两人物全量入库（M01 7043 轮 ≈ 17 min）+ 每题一次取面。
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

from loom_system import LoomSystem, _ms  # noqa: E402

DATA = os.environ.get(
	"BENCH22_DATA", os.path.join(HERE, "..", "..", "cmb-2.2", "benchmark-2.2", "dataset")
)

MEM_TOK_PER_CHAR = 0.70
FLASH_IN_PER_MTOK = 1.296
WINDOW = 8

# 官方参考系（qwen-base）的 C，见 results/README.md；`C_ref` 就是它的成本。
C_REF = {"short": 1.121, "long": 4.755, "natural": 11.481}


def jl(path):
	out = []
	with open(path, encoding="utf-8") as fh:
		for line in fh:
			if line.strip():
				out.append(json.loads(line))
	return out


def squash(text):
	"""去掉空白：历史里有换行和全角空格，8 字窗跨不过去就会漏判。"""
	return re.sub(r"\s+", "", text or "")


def windows(text, size=WINDOW):
	body = squash(text)
	if len(body) <= size:
		return [body] if len(body) >= 4 else []
	return [body[i : i + size] for i in range(len(body) - size + 1)]


def covered(prompt_squashed, evidence_text):
	"""证据轮的 8 字窗有多少落在提示词里，返回 (命中窗数, 总窗数)。"""
	wins = windows(evidence_text)
	if not wins:
		return 0, 0
	hit = sum(1 for w in wins if w in prompt_squashed)
	return hit, len(wins)


def main():
	ap = argparse.ArgumentParser()
	ap.add_argument("--split", default="dev")
	ap.add_argument("--persona", default="both")
	ap.add_argument("--limit", type=int, default=0)
	ap.add_argument("--out", default=os.path.join(HERE, "work", "surface-22.jsonl"))
	args = ap.parse_args()

	# `exam-inputs.jsonl` 里没有 split 字段（那是答案键上的），所以先按 id 归并。
	key = {k["id"]: k for k in jl(os.path.join(DATA, "review-only", "answer-key.jsonl"))}
	items = []
	for row in jl(os.path.join(DATA, "exam-inputs.jsonl")):
		k = key.get(row["id"])
		if k is None:
			continue
		if args.split != "all" and k.get("split") != args.split:
			continue
		items.append(row)
	personas = ["M01", "M02"] if args.persona == "both" else [args.persona]
	items = [i for i in items if i["persona"] in personas]
	if args.limit:
		# 每题截到前 N 题，按 cutoff 升序，保证只灌到用得到的位置
		keep = []
		for p in personas:
			keep += sorted([i for i in items if i["persona"] == p], key=lambda x: x["cutoff_turn"])[: args.limit]
		items = keep
	items.sort(key=lambda x: (x["persona"], x["cutoff_turn"]))

	hist = {}
	for p in personas:
		hist[p] = [
			{"turn": r["轮次"], "time": r["逻辑时间"], "user": r["用户消息"], "assistant": r["助手回复"]}
			for r in jl(os.path.join(DATA, "histories", f"{p}.jsonl"))
		]

	os.makedirs(os.path.dirname(os.path.abspath(args.out)), exist_ok=True)
	rows = []
	# 边跑边落盘：整卷要 80 分钟，写一次结尾的做法被中断过一回，M01 那一小时全丢了。
	out = open(args.out, "w", encoding="utf-8")
	started = time.time()
	for p in personas:
		person = [i for i in items if i["persona"] == p]
		if not person:
			continue
		system = LoomSystem()
		system.sid = p
		turns = {t["turn"]: t for t in hist[p]}
		pos = 0
		print(f"{p}: {len(person)} 题，历史 {len(hist[p])} 轮", flush=True)
		t0 = time.time()
		last = t0
		for n, item in enumerate(person):
			while pos < item["cutoff_turn"]:
				row = hist[p][pos]
				system.ingest({"turn": row["turn"], "time": row["time"], "user": row["user"], "assistant": row["assistant"]})
				pos += 1
			if n and n % 50 == 0:
				now = time.time()
				print(f"  [{n}/{len(person)}] 灌到第 {pos} 轮，本段 {now - last:.0f}s", flush=True)
				last = now
			ret = system.retrieve(item["question"], item["now"], item["cutoff_turn"], item["id"])
			prompt_sq = squash(ret.prompt)
			ev = key[item["id"]].get("evidence_turns") or []
			hit = tot = 0
			for t in ev:
				row = turns.get(t)
				if row is None:
					continue
				h, w = covered(prompt_sq, row["user"])
				hit += h
				tot += w
			row_out = {
					"id": item["id"],
					"persona": p,
					"cutoff_turn": item["cutoff_turn"],
					"chars": len(ret.prompt),
					"tokens": round(len(ret.prompt) * MEM_TOK_PER_CHAR),
					"refs": ret.meta.get("refs", 0),
					"block_lines": ret.meta.get("block_lines", 0),
					"leak": [t for t in ret.used_turns if t > item["cutoff_turn"]],
					"n_evidence": len(ev),
					"ev_hit": hit,
					"ev_total": tot,
					"cover_full": bool(tot) and hit == tot,
					"cover_any": bool(hit),
			}
			rows.append(row_out)
			out.write(json.dumps(row_out, ensure_ascii=False) + "\n")
			out.flush()
		system.close()
		print(f"{p} 取面完成，{time.time() - t0:.0f}s", flush=True)

	out.close()

	print(f"\n=== 汇总（{len(rows)} 题，{time.time() - started:.0f}s）===", flush=True)
	board = {"M01": "short", "M02": "long"}
	for p in personas:
		sub = [r for r in rows if r["persona"] == p]
		if not sub:
			continue
		tokens = sum(r["tokens"] for r in sub)
		ref = C_REF[board[p]]
		c = tokens * FLASH_IN_PER_MTOK / 1e6
		print(
			f"{p} {board[p]}: {len(sub)} 题  token 中位 {statistics.median(r['tokens'] for r in sub):.0f}"
			f"  合计 {tokens}  → C={c:.3f}（C_ref {ref}，比值 {c / ref:.3f}）",
			flush=True,
		)
		print(
			f"   证据全中 {sum(r['cover_full'] for r in sub)}/{len(sub)}"
			f"  沾到一点 {sum(r['cover_any'] for r in sub)}/{len(sub)}"
			f"  泄漏 {sum(1 for r in sub if r['leak'])}",
			flush=True,
		)
		by = {}
		for r in sub:
			by.setdefault(r["id"].split("/")[-1], []).append(r)
		print(f"   分题型: " + "  ".join(f"{k}:{sum(x['cover_full'] for x in v)}/{len(v)}" for k, v in sorted(by.items())), flush=True)
	return 0


if __name__ == "__main__":
	sys.exit(main())
