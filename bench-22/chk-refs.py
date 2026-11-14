# -*- coding: utf-8 -*-
"""临时校验：桥的 `turnsOfRefs` 能不能把检索行解回轮次（§116 的机制验证）。

不进探针套件：它验的是**评测适配器**的一个 RPC，不是产品行为。
"""
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(os.path.expanduser("~"), "Desktop", "cmb-2.2", "benchmark-2.2", "dataset")
sys.path.insert(0, os.path.join(os.path.dirname(DATA), "harness"))
sys.path.insert(0, HERE)

from loom_system import LoomClient  # noqa: E402

client = LoomClient()
sid = "chk"
turns = [
	("我的自行车是捷安特的，蓝色的，骑了三年。", "好。"),
	("自行车换成美利达了，深灰的，捷安特卖了。", "换了。"),
	("今天加班到九点，路上买了盒酸奶。", "早点睡。"),
]
at = 1777000000000
for user, reply in turns:
	client.rpc("turn", sid=sid, user=user, assistant=reply, at=at)
	at += 86400000

text = client.rpc("search", sid=sid, query="我那辆自行车是什么牌子的", limit=10)["text"]
refs = list(dict.fromkeys(re.findall(r"#([FEPL]\d+(?:-\d+)?)", text)))
print(text.strip()[:400])
print("refs:", refs)
turns_out = client.rpc("turnsOfRefs", sid=sid, refs=refs)["turns"]
print("turnsOfRefs ->", turns_out)
print("stat:", client.rpc("stat"))
client.close()
