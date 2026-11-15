# -*- coding: utf-8 -*-
"""§119 的输入先量：`events.body` 到底能带来多少「摘要里没有、原文里有的字面」。

§119.2 定的形态是「加一列 body 存整轮原文，进 events_fts，渲染仍只读 title/summary」。
判据看着很干净，但有一个前提没人验过：**问句的字面在摘要里缺、在原文里有**——如果缺的
那部分本来就是虚词或被改写成第三人称时彻底换掉了词，body 进来也只是多占长度。

这个脚本只做输入量，不改任何东西。三个数：

  1. 摘要覆盖原文多少（按二元组，不按字数——召回只认 token）；
  2. 每条事件行里，问句二元组有多少个「摘要没有、原文有」；
  3. 那些「只有原文才命中」的 token，有多少条能落到含证据轮的事件行上。

第 3 个数是 body 的天花板：它为 0 就不必讨论权重、长度归一化、四套读数了。

    python bench-22/probe-body-input.py --db bench-22/work/db/M02-5413.db --persona M02
"""

import argparse
import json
import os
import re
import statistics
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.environ.get("BENCH22_DATA") or os.path.join(
	os.path.expanduser("~"), "Desktop", "cmb-2.2", "benchmark-2.2", "dataset"
)

CJK_RUN = re.compile(r"[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]+")
LATIN_RUN = re.compile(r"[A-Za-z][A-Za-z0-9_]+")
DIGIT_RUN = re.compile(r"[0-9]+")
THIN = set("怎么什哪几谁啥呀吗呢吧啊嘛的了是在和与就也都还又再只才而且或不没我你他她它们这那个些后前当时今明昨天年月日号点早晚最初先次来")


def tokens_of(text):
	"""与 lib/index.js 的 tokensOf 同一套切分：CJK 二元组 + 拉丁词小写 + 数字。"""
	out = []
	for run in CJK_RUN.findall(text or ""):
		chars = list(run)
		for i in range(len(chars) - 1):
			out.append(chars[i] + chars[i + 1])
		if len(chars) == 1:
			out.append(chars[0])
	for run in LATIN_RUN.findall(text or ""):
		out.append(run.lower())
	for run in DIGIT_RUN.findall(text or ""):
		out.append(run)
	return out


def jl(path):
	with open(path, encoding="utf-8") as fh:
		for line in fh:
			if line.strip():
				yield json.loads(line)


def main():
	ap = argparse.ArgumentParser()
	ap.add_argument("--db", required=True)
	ap.add_argument("--persona", default="M02")
	ap.add_argument("--ctx", default=os.path.join(HERE, "work", "ctx-0279"))
	ap.add_argument("--limit", type=int, default=0, help="只跑前 N 题（调试用）")
	args = ap.parse_args()

	import sqlite3

	db = sqlite3.connect(args.db)
	db.row_factory = sqlite3.Row

	# --- 库里的事件与原文 ---
	events = db.execute("SELECT id, title, summary, tokens, l0_from, l0_to, turn_from, turn_to FROM events").fetchall()
	l0 = {r["id"]: r for r in db.execute("SELECT id, turn, tokens FROM l0")}

	body_tokens = {}
	for ev in events:
		bag = []
		for rid in range(ev["l0_from"], ev["l0_to"] + 1):
			row = l0.get(rid)
			if row is not None:
				bag.append(row["tokens"])
		body_tokens[ev["id"]] = set(" ".join(bag).split())

	# --- 题与截止轮 ---
	cuts = {}
	for r in jl(os.path.join(args.ctx, args.persona, "contexts.jsonl")):
		cuts[r["id"]] = r["cutoff_turn"]
	keys = {}
	for r in jl(os.path.join(DATA, "review-only", "answer-key.jsonl")):
		keys[r["id"]] = [int(t) for t in (r.get("evidence_turns") or [])]
	items = [r for r in jl(os.path.join(DATA, "exam-inputs.jsonl")) if r.get("persona") == args.persona]

	# 行号 → 轮次，用来判「这条事件含不含证据轮」
	row_turn = {rid: row["turn"] for rid, row in l0.items()}

	rows = []
	for item in items:
		sid = item["id"] if "id" in item else item.get("item_id")
		if sid not in cuts or not keys.get(sid):
			continue
		cut, ev_turns = cuts[sid], set(keys[sid])
		qtok = [t for t in dict.fromkeys(tokens_of(item["question"]))]
		avail = [ev for ev in events if ev["turn_to"] <= cut]
		stat = {
			"id": sid,
			"ev_turns": sorted(ev_turns),
			"events": len(avail),
			"q_tokens": len(qtok),
			"summary_cov": 0,        # 摘要覆盖原文二元组的比例（按 token 计，平均）
			"only_body": [],         # 只出现在原文里的问句 token
			"only_body_ev": [],      # 上面那些 token 落在含证据轮的事件行里的部分
			"hit_any": False,        # 有没有任何事件行的摘要命中 ≥1 个问句 token
		}
		covs = []
		for ev in avail:
			stok = set(ev["tokens"].split())
			body = body_tokens[ev["id"]]
			if body:
				covs.append(len(stok & body) / len(body))
			has_ev = any(row_turn.get(rid) in ev_turns for rid in range(ev["l0_from"], ev["l0_to"] + 1))
			for t in qtok:
				if t in stok:
					stat["hit_any"] = True
				elif t in body:
					stat["only_body"].append(t)
					if has_ev:
						stat["only_body_ev"].append(t)
		stat["summary_cov"] = statistics.mean(covs) if covs else 0.0
		stat["only_body"] = sorted(set(stat["only_body"]))
		stat["only_body_ev"] = sorted(set(stat["only_body_ev"]))
		rows.append(stat)
		if args.limit and len(rows) >= args.limit:
			break

	n = len(rows)
	print(f"题 {n}（{args.persona}，截止前的库状态）· 事件行合计 {sum(r['events'] for r in rows):,}")
	print()
	cov = [r["summary_cov"] for r in rows]
	print(f"摘要覆盖原文（按二元组）中位 {statistics.median(cov):.1%} · 均值 {statistics.mean(cov):.1%}")
	print()
	print("问句 token 的去向（每题计「有几个 token 是摘要里没有、原文里有的」）：")
	ob = [len(r["only_body"]) for r in rows]
	obe = [len(r["only_body_ev"]) for r in rows]
	print(f"  摘要全不命中任何问句 token 的题：{sum(1 for r in rows if not r['hit_any'])} / {n}")
	print(f"  每题 only_body 中位 {statistics.median(ob):.1f} · 均值 {statistics.mean(ob):.2f} · 最大 {max(ob) if ob else 0}")
	print(f"  其中落在含证据轮事件行上的：中位 {statistics.median(obe):.1f} · 均值 {statistics.mean(obe):.2f}")
	print(f"  这一步为 0 的题（body 对它们没有任何输入）：{sum(1 for x in obe if x == 0)} / {n} = {sum(1 for x in obe if x == 0) / n:.1%}")
	print()
	print("样例（前 5 题里 only_body_ev 非空的）：")
	shown = 0
	for r in rows:
		if r["only_body_ev"] and shown < 5:
			print(f"  {r['id']} 证据轮 {r['ev_turns']} · only_body {len(r['only_body'])} · 落证据 {r['only_body_ev'][:6]}")
			shown += 1

	# 汇总一个可复现的数字
	with open(os.path.join(HERE, "work", f"body-input-{args.persona}.jsonl"), "w", encoding="utf-8") as fh:
		for r in rows:
			fh.write(json.dumps(r, ensure_ascii=False) + "\n")
	print()
	print(f"逐题产物 {os.path.join('bench-22', 'work', f'body-input-{args.persona}.jsonl')}")


if __name__ == "__main__":
	main()
