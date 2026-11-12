# -*- coding: utf-8 -*-
"""Benchmark 2.2 的参赛适配器：把 dsh-memory-loom 接到官方 harness 上。

官方只要两个函数（`ingest` / `retrieve`，自然用记忆榜再加 `mark` / `rewind`），
我们这边多一层：产品是 Node，这里用常驻子进程 + 行协议调它（`loom-bridge.mjs`）。

    from bench22.systems import System, Retrieval
    class LoomSystem(System):  # 本文件

## 记忆文本是怎么拼的

按产品在 dsh 里真实的注入顺序取三段：

1. `memoryBlock(sid)`——常驻注入块（人物卡、偏好区、到期提醒、边界、指针）；
2. `memory_search`——按问句检索到的行（事实 / 事件 / 偏好 / 指针对）；
3. 前两条指针的 `memory_expand`——原话正文。

这和 `bench-hmb/surface-21.mjs` 取的是同一组面，那个脚本已经对着 2.1 的
`runner.py` 逐条对过接口，所以这里的口径和它一致：只读到截止轮、时钟拨到题目的
`now`、`used_turns` 回库查 `turn` 列而不是拿 `#L` 行号冒充轮次。

## 回退

见 `loom-bridge.mjs` 顶部：用整库快照，不做增量删除。`mark()` 对外的 token 是
**已灌轮数**（幂等），因为 `natural.py` 会在 `rewind` 之后断言
`system.mark() == tok`。
"""

import atexit
import datetime
import json
import os
import re
import subprocess
import sys
import threading

from bench22.systems import Retrieval, System

HERE = os.path.dirname(os.path.abspath(__file__))
BRIDGE = os.environ.get("LOOM_BRIDGE", os.path.join(HERE, "loom-bridge.mjs"))
NODE = os.environ.get("LOOM_NODE", "node")
SEARCH_LIMIT = int(os.environ.get("LOOM_SEARCH_LIMIT", "10"))
EXPANDS = int(os.environ.get("LOOM_EXPANDS", "2"))
# 事件的正文可以长到六七千字，而检索把哪两条顶到前面会随库的物理状态变（`VACUUM INTO`
# 过后 bm25 的 rowid 变了）——2026-11-12 自然榜踩到：同一道题，第一次取面 2.1k 字，
# rewind 之后再取面 14.9k 字，多出来的 13k 全在两个展开里。
#
# 处理办法是**保留检索给的顺序**（那是产品真实会端出来的东西，换顺序等于换机制），
# 只给正文加一个字数额度；额度按榜设，不搞一刀切：
#
# - 两个考试榜：**不截**（`LOOM_EXPAND_CHARS=0`）。它们的成本项本来就已经封顶
#   （比值 0.79 / 0.23，离 0.25 的下限只差长榜那一点点），截断只掉覆盖不掉成本。
#   实测截到 600 字，「证据全中」从 83→78、32→24，白亏 13 题。
# - 自然用记忆榜：**截**。它的比值卡在 0.13 与 0.42 两个档位之间——0.42 意味着
#   成本项从 +6 掉到 +3.5，一分钱一分货地扣分。
EXPAND_CHARS = int(os.environ.get("LOOM_EXPAND_CHARS", "1200"))
REF_RANK = {"L": 0, "F": 1, "P": 1, "E": 2}

PREAMBLE = "你是用户长期聊天的伴侣小满。下面是你记得的事和你们过去的对话片段，请据此自然地回复。"

# 注入块里的行是 `- [09-01 · 事实] 我养了只猫，叫栗子，橘色的`，没有引用标记，
# 但正文在 facts / events 里能查到来源轮次（见桥的 `sources`）。
LINE_PREFIX = re.compile(r"^\[[^\]]{0,40}\]\s*")
LINE_NOTE = re.compile(r"[（(][^）)]{0,60}[）)]\s*$")


def content_lines(text):
	"""把注入块拆成一行的正文，用来反查来源轮次。"""
	out = []
	for raw in text.splitlines():
		line = raw.strip()
		if not line.startswith("- "):
			continue
		body = LINE_PREFIX.sub("", line[2:].strip()).strip()
		body = LINE_NOTE.sub("", body).strip()
		if len(body) >= 4:
			out.append(body)
	return out


def _ms(iso):
	"""ISO 时间 → 毫秒。历史里带 `+08:00`，必须保留时区，不能按本地时区猜。"""
	return int(datetime.datetime.fromisoformat(iso).timestamp() * 1000)


class LoomClient:
	"""一个 Node 子进程，一行一个请求。"""

	def __init__(self, db=None, work_dir=None, config=None):
		self._lock = threading.Lock()
		self._seq = 0
		cmd = [NODE, BRIDGE]
		self.proc = subprocess.Popen(
			cmd,
			stdin=subprocess.PIPE,
			stdout=subprocess.PIPE,
			stderr=None,
			text=True,
			encoding="utf-8",
			bufsize=1,
		)
		atexit.register(self.close)
		# 库放临时目录：一次运行一个库，跑完就不需要了。
		import tempfile

		self.work_dir = work_dir or tempfile.mkdtemp(prefix="loom22-")
		db = db or os.path.join(self.work_dir, "loom.db")
		opened = self.rpc("open", db=db, workDir=self.work_dir, config=config or {})
		self.db = opened["db"]

	def rpc(self, op, **kw):
		with self._lock:
			self._seq += 1
			payload = {"id": self._seq, "op": op}
			payload.update({k: v for k, v in kw.items() if v is not None})
			self.proc.stdin.write(json.dumps(payload, ensure_ascii=False) + "\n")
			self.proc.stdin.flush()
			line = self.proc.stdout.readline()
			if line == "":
				raise RuntimeError(f"桥进程在 {op} 上退出了（退出码 {self.proc.poll()}）")
			resp = json.loads(line)
			if not resp.get("ok"):
				raise RuntimeError(f"{op} 失败：{resp.get('error')}")
			return resp

	def close(self):
		try:
			if self.proc.poll() is None:
				self.proc.stdin.write(json.dumps({"id": 0, "op": "close"}) + "\n")
				self.proc.stdin.flush()
				self.proc.wait(timeout=10)
		except Exception:  # noqa: BLE001 - 退出路径上不抛
			try:
				self.proc.kill()
			except Exception:  # noqa: BLE001
				pass
		# 管道要自己关：子进程退出之后解释器再来 flush 会抛 `OSError: [Errno 22]`，
		# 每次跑完都留一句吓人的噪声（无害，但会把真错盖住）。
		for pipe in (self.proc.stdin, self.proc.stdout):
			try:
				pipe.close()
			except Exception:  # noqa: BLE001
				pass


class LoomSystem(System):
	name = "loom"

	def __init__(self, gw=None, **kw):
		self.sid = kw.get("sid", "bench")
		self.client = LoomClient()
		self._last_token = None
		self._snaps = {}
		self._dirty = True
		self.calls = 0

	# ---------------------------------------------------------------- 写入

	def ingest(self, turn):
		self.client.rpc(
			"turn",
			sid=self.sid,
			user=turn["user"],
			assistant=turn["assistant"],
			at=_ms(turn["time"]),
		)
		self._dirty = True

	# ---------------------------------------------------------------- 读取

	def retrieve(self, question, now, cutoff_turn, item_id=None):
		now_ms = _ms(now)
		block = self.client.rpc("block", sid=self.sid, now=now_ms)["text"]
		search = self.client.rpc("search", sid=self.sid, query=question, limit=SEARCH_LIMIT, now=now_ms)["text"]
		refs = re.findall(r"#([FEPL]\d+(?:-\d+)?)", search)
		picked = list(dict.fromkeys(refs))[:EXPANDS]
		expanded = []
		for ref in picked:
			try:
				body = self.client.rpc("expand", sid=self.sid, ref="#" + ref)["text"]
			except Exception as error:  # noqa: BLE001 - 单条展开失败不该带走整题
				body = f"（展开 #{ref} 失败：{error}）"
			# `#L` 本来就是窗口（一两百字），只有事件/事实正文需要额度；0 = 不截
			cap = EXPAND_CHARS if (ref[0] in "EFP" and EXPAND_CHARS > 0) else 10**6
			if len(body) > cap:
				body = body[:cap] + f"…（#{ref} 共 {len(body)} 字，已截断）"
			expanded.append(body)
		self.calls += 1

		parts = [PREAMBLE]
		if block.strip():
			parts.append("【常驻记忆】\n" + block)
		if search.strip():
			parts.append("【检索到的记忆】\n" + search)
		for body in expanded:
			if body.strip():
				parts.append("【原话】\n" + body)
		prompt = "\n\n".join(parts)

		spans = [[int(a), int(b or a)] for a, b in re.findall(r"#L(\d+)(?:-(\d+))?", prompt)]
		lines = content_lines(block)
		if lines:
			spans.extend(self.client.rpc("sources", sid=self.sid, lines=lines)["spans"])
		used = self.client.rpc("usedTurns", sid=self.sid, spans=spans)["turns"] if spans else []
		return Retrieval(prompt, used, {"chars": len(prompt), "refs": len(refs), "block_lines": len(lines)})

	# ---------------------------------------------------------------- 回退

	def mark(self):
		"""已灌轮数；不脏就不重拍快照。"""
		if not self._dirty and self._last_token is not None:
			return self._last_token
		got = self.client.rpc("mark")
		self._last_token = got["token"]
		self._snaps[got["token"]] = got["snap"]
		self._dirty = False
		return self._last_token

	def rewind(self, token):
		snap = self._snaps.get(token)
		if snap is None:
			raise RuntimeError(f"没有轮数 {token} 对应的快照")
		self.client.rpc("rewind", snap=snap)
		self._last_token = token
		self._dirty = False

	def close(self):
		self.client.close()


def register(registry):
	"""把 `loom` 注册进官方 REGISTRY（`run_dev.py` 调它）。"""
	registry["loom"] = lambda gw: LoomSystem(gw)
	return registry
