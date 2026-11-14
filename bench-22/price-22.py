# -*- coding: utf-8 -*-
"""一趟全量要花多少钱，以及榜单上的成本项 C 是多少。

两件事必须分开算，它们不是同一个数：

- **C（榜单成本项）**：官方 `runner.summarize` 只把「系统自己的调用」和「记忆文本进
  提示词」计进去。答题、判分**不算 C**。loom 的写入与检索是纯规则，系统侧调用为 0，
  所以 C 就等于记忆文本的 token 数乘 flash 输入价。
- **实际花费（押金烧的）**：答题 + 判分全都走网关，全部计价。这才是 ¥。

单价见 `bench22/prices.json`（prices-2.2.0）：输入 1.296 / 输出 5.184 CNY 每百万 token。

    python bench-22/price-22.py --ctx work/ctx-0278 --natural work/natural-0277.jsonl

token 一律用 `字 × 0.70` 估（官方 `MEM_TOK_PER_CHAR`），没有真实 usage 可用：
四套基准全走规则路径，一次模型调用都没发生过。
"""

import argparse
import json
import os
import statistics

HERE = os.path.dirname(os.path.abspath(__file__))
IN_PRICE = 1.296 / 1e6
OUT_PRICE = 5.184 / 1e6
TOK_PER_CHAR = 0.70


def jl(path):
	with open(path, encoding="utf-8") as fh:
		return [json.loads(line) for line in fh if line.strip()]


def main():
	ap = argparse.ArgumentParser()
	ap.add_argument("--ctx", default=os.path.join(HERE, "work", "ctx-0278"))
	ap.add_argument("--natural", default=os.path.join(HERE, "work", "natural-0277.jsonl"))
	ap.add_argument("--answer-out", type=int, default=200, help="答题输出 token 的假设值")
	ap.add_argument("--judge-in", type=int, default=1190, help="考试榜判分输入 token（实测 1,700 字 × 0.7）")
	ap.add_argument("--judge-out", type=int, default=60)
	ap.add_argument("--nat-judge-calls", type=float, default=2.0, help="自然榜每题平均判分调用次数")
	ap.add_argument("--nat-judge-in", type=int, default=2100)
	args = ap.parse_args()

	rows = []
	for p in ("M01", "M02"):
		path = os.path.join(args.ctx, p, "contexts.jsonl")
		if os.path.exists(path):
			rows += jl(path)
	if not rows:
		raise SystemExit(f"{args.ctx} 里没有 contexts，先跑 ctx-only.py")

	# 答题提示词 = 记忆文本 + "\n\n【现在】<now>\n用户：<question>"
	question_chars = statistics.median(len("【现在】2026-09-05T20:48:17+08:00\n用户：") + 30 for _ in range(1))
	mem_chars = [len(r["prompt"]) for r in rows]
	mem_tok = [c * TOK_PER_CHAR for c in mem_chars]
	answer_in = [m + question_chars * TOK_PER_CHAR for m in mem_tok]

	n = len(rows)
	c_board = sum(mem_tok) * IN_PRICE
	answer_cost = sum(answer_in) * IN_PRICE + n * args.answer_out * OUT_PRICE
	judge_cost = n * (args.judge_in * IN_PRICE + args.judge_out * OUT_PRICE)

	nat = jl(args.natural) if os.path.exists(args.natural) else []
	nat_n = len(nat)
	nat_mem_tok = sum(r["chars"] * TOK_PER_CHAR for r in nat)
	nat_cost = (
		sum((r["chars"] * TOK_PER_CHAR + question_chars * TOK_PER_CHAR) for r in nat) * IN_PRICE
		+ nat_n * args.answer_out * OUT_PRICE
		+ nat_n * args.nat_judge_calls * (args.nat_judge_in * IN_PRICE + args.judge_out * OUT_PRICE)
	)

	print(f"=== 题量：{n} 题（M01+M02）+ 自然榜 {nat_n} 题 ===")
	print(f"记忆文本：中位 {statistics.median(mem_chars):,.0f} 字 / 合计 {sum(mem_chars):,} 字")
	print(f"           中位 {statistics.median(mem_tok):,.0f} tok / 合计 {sum(mem_tok):,.0f} tok")
	print()
	print("--- 榜单成本项 C（只含系统侧 + 记忆文本；答题判分不计）---")
	print(f"  短+长对话榜  C = ¥{c_board:.3f}")
	print(f"  自然榜       C = ¥{nat_mem_tok * IN_PRICE:.3f}")
	print(f"  合计         C = ¥{c_board + nat_mem_tok * IN_PRICE:.3f}")
	print()
	print("--- 实际花费（押金烧的：答题 + 判分）---")
	print(f"  答题 {n} 次          ¥{answer_cost:.3f}")
	print(f"  判分 {n} 次          ¥{judge_cost:.3f}")
	print(f"  自然榜 {nat_n} 题      ¥{nat_cost:.3f}（判分按 {args.nat_judge_calls} 次/题）")
	print(f"  合计                ¥{answer_cost + judge_cost + nat_cost:.3f}")
	print()
	print(f"参考：官方 Qwen 基础方案三榜 C 合计 ¥17.36（封存集抽样口径），")
	print(f"      我们系统侧 0 调用，C 只剩记忆文本这一项。")


if __name__ == "__main__":
	main()
