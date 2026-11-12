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


def _pick(env, *parts):
	"""题库 / harness 的位置：环境变量 > 仓库旁的相对路径 > 桌面上那份。

	早几轮没写兜底，换个终端就 ModuleNotFoundError，白排半小时的错。
	"""
	cands = []
	if os.environ.get(env):
		cands.append(os.environ[env])
	cands.append(os.path.join(HERE, "..", "..", "cmb-2.2", *parts))
	cands.append(os.path.join(os.path.expanduser("~"), "Desktop", "cmb-2.2", *parts))
	for c in cands:
		if os.path.isdir(c):
			return os.path.abspath(c)
	return os.path.abspath(cands[-1])


HARNESS = _pick("BENCH22_HARNESS", "benchmark-2.2", "harness")
DATA = _pick("BENCH22_DATA", "benchmark-2.2", "dataset")
sys.path.insert(0, HARNESS)
sys.path.insert(0, HERE)

from loom_system import LoomSystem  # noqa: E402

MEM_TOK_PER_CHAR = 0.70
FLASH_IN_PER_MTOK = 1.296
WINDOW = 8
# 证据行长这样：`- 第1347轮 2026-10-03 05:57 user：我拔的是左下那颗…`
EVIDENCE_LINE = re.compile(r"user[:：]\s*(.+)$")

# ── 看门狗 ──────────────────────────────────────────────────────────────
# 已经两次「跑了几十分钟才发现读数全错」：§96 的轮次重号（63/76 题中招），
# 以及 §95 那批混口径的产物。两次的错都有**廉价的外观**——提示词忽然从
# 两千字变成一万六、指针从 9 行变成 4,231 行——只是当时没人查。
# 这里把外观写成断言，**第 1 题就要过**；一题不对立刻停，不带着坏状态跑完 76 题。
#
# 阈值来自健康产物的实测分布（`work/natural-22-v6.jsonl`，76 题）：
#   最宽 `#L` 跨度 中位 5、p99 9、**max 9**；提示词 中位 2,446 字、max 4,877。
# 取 4 倍左右的余量，而不是拍一个整数。
MAX_SPAN_LINES = 40
MAX_PROMPT_CHARS = 12_000
POINTER = re.compile(r"#L(\d+)(?:-(\d+))?")


def guard(prompt, used_turns, seq):
	"""一题取完面就查一遍形状，返回违规清单（空 = 放行）。"""
	bad = []
	spans = [(int(a), int(b or a)) for a, b in POINTER.findall(prompt)]
	if spans:
		lo, hi = max(spans, key=lambda p: p[1] - p[0])
		if hi - lo > MAX_SPAN_LINES:
			bad.append(
				f"指针 #L{lo}-{hi} 覆盖 {hi - lo} 行（上限 {MAX_SPAN_LINES}）"
				f"——一个重号轮次就能把「一轮」拉成整段历史，`memory_expand` 会从这里切走一大片"
			)
	if len(prompt) > MAX_PROMPT_CHARS:
		bad.append(f"提示词 {len(prompt)} 字（上限 {MAX_PROMPT_CHARS}）")
	leak = [t for t in (used_turns or []) if t > seq]
	if leak:
		bad.append(f"used_turns 里出现未来轮次 {leak[:5]}（截止轮 {seq}）")
	return bad


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
	ap.add_argument("--persona", default="both", choices=["M01", "M02", "both"])
	ap.add_argument("--out", default=os.path.join(HERE, "work", "natural-22.jsonl"))
	ap.add_argument(
		"--log",
		default=os.path.join(HERE, "work", "natural-run.log"),
		help="进度日志。上一轮把 stdout 接了 `| tail -40`，进度全被吞掉，看不到在第几题。",
	)
	ap.add_argument("--soft", action="store_true", help="看门狗只报警不中止（默认中止，退出码 3）")
	ap.add_argument("--self-test", action="store_true", help="只跑看门狗自检：合成坏形状，确认它会响")
	args = ap.parse_args()

	if args.self_test:
		# 一个从不响的看门狗比没有更糟：它给出「查过了」的错觉。所以先证明它会响。
		cases = [
			("健康", "【正文 · #L120-125 原话】\n行\n行", [3, 5], 100),
			("超宽指针", "【正文 · #L377-4608 原话】", [3], 100),
			("超长提示词", "x" * 20_000, [3], 100),
			("未来轮次", "【正文 · #L1-2】", [1, 999], 100),
		]
		ok = True
		for name, prompt, used, seq in cases:
			bad = guard(prompt, used, seq)
			want = name != "健康"
			mark = "✓" if bool(bad) == want else "✗"
			if bool(bad) != want:
				ok = False
			print(f"  {mark} {name:8} 响={bool(bad)}  {bad[:1] if bad else ''}")
		return 0 if ok else 1

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
	# 逐题落盘：以前攒到结尾一次写，被 kill 就整卷白跑（§「长跑探针要逐条落盘」）。
	# 写到 `.part`，跑完才改名——半卷永远不能冒充完整产物，这是上一轮踩过的坑。
	part = args.out + ".part"
	fh = open(part, "w", encoding="utf-8")
	log = open(args.log, "w", encoding="utf-8") if args.log else None

	def say(line):
		print(line, flush=True)
		if log:
			log.write(line + "\n")
			log.flush()

	rows = []
	started = time.time()
	personas = ("M01", "M02") if args.persona == "both" else (args.persona,)
	for persona in personas:
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
			k = key[p["id"]]
			evs = evidence_texts(k.get("evidence"))
			hit = tot = 0
			ev_rows = []
			for ev in evs:
				wins = windows(ev)
				h = sum(1 for w in wins if w in prompt_sq)
				hit += h
				tot += len(wins)
				# 逐条证据记下来：换窗长（6/8/12 字）、换判据都能离线重算，不用再赌一次
				# 26 分钟的入库。`prompt` 也存，代价是每题 2–3 KB。
				ev_rows.append({"text": ev, "hit": h, "total": len(wins), "chars": len(squash(ev))})
			# 官方诊断 ①「需要的记忆进了提示词吗」用的是**轮次**口径（used_turns ∩ 证据轮），
			# 不是字面窗。两把尺子都记，否则我们的数没法跟榜单上的 59.1% 并排。
			ev_turns = {int(n) for n in re.findall(r"第(\d+)轮", k.get("evidence") or "")}
			used = set(ret.used_turns or [])
			turn_hit = len(ev_turns & used)
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
					"prompt": ret.prompt,
					"ev": ev_rows,
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
			fh.write(json.dumps(rows[-1], ensure_ascii=False) + "\n")
			fh.flush()

			# 看门狗：**每一题**都查形状，不是抽查。坏形状是逐题累积的，
			# 第 1 题只歪一点、第 40 题才崩，抽查正好抽不到。
			bad = guard(ret.prompt, ret.used_turns, seq)
			if bad and not args.soft:
				say(f"\n✗ 第 {n + 1} 题 {p['id']} 形状异常，已中止（{time.time() - started:.0f}s）：")
				for one in bad:
					say(f"    · {one}")
				say(f"  已落盘的 {len(rows)} 题在 {part}，别当完整产物用。")
				fh.close()
				system.close()
				return 3
			for one in bad:
				say(f"  ⚠ {p['id']}: {one}")

			if (n + 1) % 5 == 0 or n + 1 == len(todo):
				# 每 5 题核一次库的形态：l0 行数应当接近 2×已灌轮数。rewind 如果没真回退，
				# 行数会一路堆上去、turn 编号还会重号——那之后所有 used_turns 都不可信。
				st = system.client.rpc("stat")
				spent = time.time() - started
				left = spent / (n + 1) * (len(todo) - n - 1)
				say(
					f"  [{n + 1}/{len(todo)}] 灌到第 {pos} 轮，{spent:.0f}s"
					f"（剩 ~{left / 60:.0f} 分）l0 {st['rows']} 行 / mark {tok} 轮"
				)
		system.close()
		say(f"{persona} 完成，{time.time() - t0:.0f}s")

	# 跑到这里才算完整：改名是**最后一步**，`.part` 存在就意味着这卷不能用。
	fh.close()
	os.replace(part, args.out)

	say(f"（跳过 B 档 {len(skipped)} 个：需要系统自己的回复）")
	say(f"\n=== 汇总（{len(rows)} 个探针，{time.time() - started:.0f}s）===")
	for persona in ("M01", "M02"):
		sub = [r for r in rows if r["persona"] == persona]
		if not sub:
			continue
		tok = sum(r["tokens"] for r in sub)
		c = tok * FLASH_IN_PER_MTOK / 1e6
		say(
			f"{persona}: {len(sub)} 探针  token 中位 {statistics.median(r['tokens'] for r in sub):.0f}  合计 {tok}"
			f" → C={c:.3f}  证据全中 {sum(r['cover_full'] for r in sub)}/{len(sub)}"
			f"  沾到 {sum(r['cover_any'] for r in sub)}/{len(sub)}  泄漏 {sum(1 for r in sub if r['leak'])}"
		)
		for cls in ("X", "H", "Y", "Z", "N0"):
			g = [r for r in sub if r["class"] == cls]
			if g:
				say(
					f"  {cls}: {len(g):>2} 个  全中 {sum(x['cover_full'] for x in g):>2}  沾到 {sum(x['cover_any'] for x in g):>2}"
					f"  token 中位 {statistics.median(x['tokens'] for x in g):.0f}"
				)
	if log:
		log.close()
	return 0


if __name__ == "__main__":
	sys.exit(main())
