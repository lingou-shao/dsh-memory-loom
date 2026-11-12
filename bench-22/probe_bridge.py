# -*- coding: utf-8 -*-
"""D1 的 go/no-go 探针：桥能不能用，回退能不能真的把尾巴丢掉。

不需要网关、不需要密钥、不花钱——这里只验「记忆层的协议」，不验答题。

    python bench-22/probe_bridge.py

四件事：
1. 灌 20 轮之后，检索**能**找到其中一句（桥在正常工作，而不是永远返回空）；
2. `mark()` 幂等：连调两次同一个值；
3. 灌 3 轮尾巴（带独有暗号）之后检索**能**看到它；
4. `rewind` 之后同一句检索**看不到**尾巴，且 `mark()` 回到原值、还能继续写。
"""

import datetime
import os
import sys
import tempfile

HARNESS = os.environ.get("BENCH22_HARNESS", os.path.join(os.path.dirname(__file__), "..", "..", "cmb-2.2", "benchmark-2.2", "harness"))
if os.path.isdir(HARNESS):
	sys.path.insert(0, os.path.abspath(HARNESS))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from loom_system import LoomSystem, _ms  # noqa: E402

TAIL_MARK = "紫色雨伞"
HIST = [
	("我今天去看了牙医，医生说智齿要拔", "拔智齿是有点吓人，不过拖着更麻烦。约了哪天？"),
	("下周三下午两点", "记下了，下周三下午两点，我到时候提醒你。"),
	("我最近在学做饭，昨天做了番茄炒蛋", "第一次做能炒熟就很不错了，盐放多了还是少了？"),
	("有点咸，我下次少放半勺", "那就记着少半勺，锅里少一点盐比多放好救。"),
	("我妈生日是四月十七", "四月中，那还有一个多月，到时候一起挑个礼物。"),
	("她喜欢康乃馨，不喜欢玫瑰", "康乃馨好，颜色也多。我记着这条，别买错了。"),
	("我换了工作，现在在做数据分析", "换赛道了呀，数据分析挺吃细心的，你正好。"),
	("通勤要一个小时二十分钟", "那有点远，路上可以听点东西，别一直刷手机。"),
	("我养了只猫，叫栗子，橘色的", "栗子这名字配橘猫，太对了。它黏人吗？"),
	("特别黏，晚上非要睡我枕头边", "那你这枕头基本是它的了。掉毛厉害吗？"),
	("还可以，就是爱挠沙发", "买个猫抓板放沙发边上，慢慢就换过去了。"),
	("周末想去爬山，但是怕下雨", "先看天气预报，周六要是晴就走早点，下午容易变天。"),
	("我膝盖以前受过伤", "那下山要注意，护膝戴上，别硬冲。"),
	("我最近睡不好，老是三点多醒", "三点多醒最磨人。晚上少喝咖啡，睡前别看手机。"),
	("咖啡我一天两杯，早上一杯下午一杯", "下午那杯可以先换成别的试试，两点以后就别喝了。"),
	("我下个月要考试，考注册会计师", "注会啊，那得早开始。每天固定两小时比周末突击强。"),
	("我打算每天晚上八点到十点看书", "八点到十点是好时段，手机放远一点。"),
	("我有个朋友叫小川，他最近失恋了", "小川啊，那他这几天估计不太好，你有空多陪陪。"),
	("他喜欢喝冰美式", "冰美式，记着了。约他出来的时候别劝他喝酒。"),
	("我爸血压高，一直在吃药", "那得盯着复查，药别断，盐也少一点。"),
]
TAIL = [
	("刚才路过一家店，门口挂着紫色雨伞", "紫色雨伞挺少见的，是那种老式的长柄伞吗？"),
	("对，就是紫色雨伞，很好看", "好看就多看两眼，别一冲动买第三把伞。"),
	("嗯，我记住了紫色雨伞", "行，紫色雨伞，我陪你记着。"),
]
BASE = datetime.datetime(2026, 9, 1, 9, 0, 0, tzinfo=datetime.timezone(datetime.timedelta(hours=8)))


def iso(hours):
	return (BASE + datetime.timedelta(hours=hours)).isoformat()


def feed(system, rows, start_hour):
	for i, (user, assistant) in enumerate(rows):
		hour = start_hour + i
		system.ingest({"turn": hour + 1, "time": iso(hour), "user": user, "assistant": assistant})


def probe(system, question, now_iso):
	"""整道题的取面：和 `runner.py` 一样只给三样东西（问句、now、cutoff）。"""
	return system.retrieve(question, now_iso, 10**6)


def main():
	fails = []

	def check(ok, label, detail=""):
		print(("  PASS " if ok else "  FAIL ") + label + (f"  [{detail}]" if detail else ""))
		if not ok:
			fails.append(label)

	print("== 1. 建库 + 灌 20 轮 ==")
	system = LoomSystem()
	system.sid = "probe"
	feed(system, HIST, 0)
	print(f"  灌入 {len(HIST)} 轮")

	print("== 2. 检索一个只在历史里出现过的事实 ==")
	now = iso(20)
	prompt = probe(system, "我那只猫叫什么名字", now).prompt
	check("栗子" in prompt, "历史内容能被检索到", f"prompt {len(prompt)} 字")
	block_now = system.client.rpc("block", sid=system.sid, now=_ms(now))["text"]
	check(len(block_now.strip()) > 0, "常驻注入块不是空的", f"block {len(block_now)} 字")

	print("== 3. mark 幂等 ==")
	tok1 = system.mark()
	tok2 = system.mark()
	check(tok1 == tok2, "连续两次 mark 返回同一个 token", f"{tok1}")

	print("== 4. 灌尾巴，尾巴要能被看到 ==")
	feed(system, TAIL, 20)
	dirty = probe(system, TAIL_MARK, iso(23))
	check(TAIL_MARK in dirty.prompt, "尾巴写进去后能检索到", f"prompt {len(dirty.prompt)} 字")
	check(
		{21, 22, 23} & set(dirty.used_turns) and max(dirty.used_turns) <= 23,
		"尾巴的轮次被如实报进 used_turns，且没有越界",
		f"{dirty.used_turns}",
	)

	print("== 5. rewind ==")
	system.rewind(tok1)
	check(system.mark() == tok1, "rewind 之后 mark() 回到原值", f"{system.mark()}")
	clean = probe(system, TAIL_MARK, iso(23)).prompt
	check(TAIL_MARK not in clean, "rewind 之后检索不到尾巴", f"prompt {len(clean)} 字")
	check("栗子" in clean, "rewind 没有连带删掉历史")

	print("== 6. rewind 之后还能继续写 ==")
	system.ingest({"turn": 24, "time": iso(24), "user": "我明天要早起，六点半", "assistant": "六点半，那我记着你早点睡。"})
	after = system.retrieve("我明天几点起", iso(25), 10**6)
	check("六点半" in after.prompt, "rewind 之后新轮次正常入库", f"prompt {len(after.prompt)} 字")
	check(TAIL_MARK not in after.prompt, "新轮次没有把尾巴带回来")

	print("== 7. 回退后的 used_turns 坐标系 ==")
	# 回退会重建实例，产品内部的轮次计数器从 1 重来；如果 used_turns 跟着它走，
	# 这里就会冒出 1、2 这种「历史里根本没有」的轮次号。评测程序拿 used_turns
	# 判泄漏，坐标错了就两边都不对：要么漏判，要么把正常历史判成越界。
	check(
		all(1 <= t <= 21 for t in after.used_turns) and max(after.used_turns, default=0) > 0,
		"used_turns 落在真实轮次范围内",
		f"{after.used_turns}",
	)

	system.close()
	print()
	if fails:
		print(f"结论：不通过，{len(fails)} 项失败 -> {fails}")
		return 1
	print("结论：通过（桥可用，回退干净）")
	return 0


if __name__ == "__main__":
	sys.exit(main())
