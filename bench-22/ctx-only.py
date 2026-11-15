# -*- coding: utf-8 -*-
"""只取面、不答题、不判分 —— 全量 809 题的上下文。

官方的 `runner.run_persona` 本身就是纯规则的：它只做「按截止轮增量灌入 →
`system.retrieve()`」，一次模型调用都没有。单独的 `answer_and_judge` 才花钱。

所以这个脚本复用官方那一段，跳过后半截。得到的东西有两条用途：

1. **算价格**：每题进答题提示词的记忆文本有多长，直接决定 C 的大头。
2. **算覆盖**：答案键里的证据原话在不在提示词里——不花钱的「正确率上界」。

    python bench-22/ctx-only.py --out work/ctx-0278 --persona both

只读题库与产品接口，不改 `lib/`，不发一个模型请求。
"""

import argparse
import json
import os
import sys
import time
from types import SimpleNamespace


def _pick(env, *parts):
	for root in (
		os.environ.get(env),
		os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "cmb-2.2"),
		os.path.join(os.path.expanduser("~"), "Desktop", "cmb-2.2"),
	):
		if root and os.path.isdir(os.path.join(root, *parts)):
			return os.path.abspath(os.path.join(root, *parts))
	return os.path.abspath(os.path.join(*parts))


HERE = os.path.dirname(os.path.abspath(__file__))
DATA = _pick("BENCH22_DATA", "benchmark-2.2", "dataset")
sys.path.insert(0, DATA)
sys.path.insert(0, os.path.join(os.path.dirname(DATA), "harness"))
sys.path.insert(0, HERE)

from bench22 import systems  # noqa: E402
from bench22.release import load_histories, load_items  # noqa: E402
from bench22.runner import run_persona  # noqa: E402
from loom_system import register  # noqa: E402

# 官方 `--system` 的 choices 来自这个 dict；不改官方文件，直接往同一个对象里塞。
register(systems.REGISTRY)


class _NoGateway:
	"""`run_persona` 只在记录账本时写 `gw.system`，一次请求都不发。

	真网关的构造要读密钥环境变量，这里给个桩，免得因为「没有 key」挡住一次
	本来就不花钱的取面。
	"""

	system = "loom"


def main():
	ap = argparse.ArgumentParser()
	ap.add_argument("--out", default=os.path.join(HERE, "work", "ctx-0278"))
	ap.add_argument("--persona", default="both")
	ap.add_argument("--limit", type=int, default=0)
	ap.add_argument("--system", default="loom", help="loom 或官方基线（bm25-recent6 等，都是本地规则）")
	args = ap.parse_args()

	items_all = [i for i in load_items(DATA) if i.get("split") == "dev"]
	if args.limit:
		items_all = sorted(items_all, key=lambda x: x["id"])[: args.limit]
	hist = load_histories(DATA)
	personas = ["M01", "M02"] if args.persona == "both" else [args.persona]

	ns = SimpleNamespace(system=args.system, split="dev")
	t0 = time.time()
	for p in personas:
		outdir = os.path.join(args.out, p)
		os.makedirs(outdir, exist_ok=True)
		t1 = time.time()
		# `--limit` 是**每人**多少题。`items_all` 按 id 排序后前 N 条全是 M01，
		# 用全局截断时 M02 拿到 0 题、连 contexts.jsonl 都不写，看起来像崩溃。
		mine = [i for i in items_all if i["id"].startswith(p)]
		if args.limit:
			mine = sorted(mine, key=lambda x: x["id"])[: args.limit]
		leaks = run_persona(ns, DATA, hist, p, mine, outdir, _NoGateway(), None)
		path = os.path.join(outdir, "contexts.jsonl")
		rows = [json.loads(line) for line in open(path, encoding="utf-8") if line.strip()]
		chars = sum(len(r["prompt"]) for r in rows)
		print(
			f"{p}: {len(rows)} 题 / {len(hist[p])} 轮 · 记忆文本 {chars:,} 字 "
			f"· 平均 {chars // max(1, len(rows)):,} 字 · 泄漏 {len(leaks)} · {time.time() - t1:.0f}s",
			flush=True,
		)
	print(f"合计 {time.time() - t0:.0f}s -> {os.path.abspath(args.out)}")


if __name__ == "__main__":
	main()
