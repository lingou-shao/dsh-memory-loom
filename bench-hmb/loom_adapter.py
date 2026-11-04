# -*- coding: utf-8 -*-
"""hive-memory-bench · 状态链轨的自备适配器（dsh-memory-loom）。

契约见 chain/harness/adapters/base.py：只实现 ingest / retrieve（外加可选的
count / is_empty / close）。实测的是一条语料段＝一条 fact，检索走插件自己的
`memory_search`（FTS5 + 显著性/衰减排序），不做任何改写或补写。

为什么要一个常驻的 Node 子进程：插件是 cordis 插件，只有 JS 侧有真实现；
在 Python 里复刻一遍检索就等于换了个系统来测。桥的协议见 loom_bridge.mjs。

环境变量：
  HMB_LOOM_DB      库文件路径（必填；运行器按 store_tag 给不同臂分叉）
  HMB_LOOM_HOME    插件根目录（默认本机开发路径）
  HMB_LOOM_BRIDGE  桥脚本路径（默认与本文件同目录）
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path

from .base import MemoryAdapter

DEFAULT_HOME = r'C:/Users/shaoz/Documents/GitHub/dsh-memory-loom'


class LoomAdapter(MemoryAdapter):
    name = 'loom'

    def __init__(self, db: str | None = None, mode: str | None = None):
        self.db = Path(db or os.environ.get('HMB_LOOM_DB') or '')
        if not str(self.db):
            raise RuntimeError('LoomAdapter 需要库路径：传 db= 或设 HMB_LOOM_DB')
        self.db.parent.mkdir(parents=True, exist_ok=True)

        # episode（默认）＝插件真实用法：回合写 L0，整合出索引，检索命中后
        # `memory_expand` 调回原文；verbatim＝把语料段直接当事实存的对照臂。
        self.mode = (mode or os.environ.get('HMB_LOOM_MODE') or 'episode').lower()
        default_bridge = 'loom_bridge_episode.mjs' if self.mode == 'episode' else 'loom_bridge.mjs'
        bridge = Path(os.environ.get('HMB_LOOM_BRIDGE')
                      or Path(__file__).with_name(default_bridge))
        env = dict(os.environ)
        env['HMB_LOOM_DB'] = str(self.db)
        env.setdefault('HMB_LOOM_HOME', DEFAULT_HOME)
        self._proc = subprocess.Popen(
            ['node', str(bridge)],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
            text=True, encoding='utf-8', bufsize=1, env=env,
        )
        self._rpc({'op': 'count'})          # 预热：确认桥活着，顺带把 count 缓存下来

    # ── 协议 ──────────────────────────────────────────────────────────
    def _rpc(self, payload: dict) -> dict:
        assert self._proc.stdin and self._proc.stdout
        self._proc.stdin.write(json.dumps(payload, ensure_ascii=False) + '\n')
        self._proc.stdin.flush()
        line = self._proc.stdout.readline()
        if not line:
            raise RuntimeError('loom 桥退出（无响应）')
        out = json.loads(line)
        if not out.get('ok'):
            raise RuntimeError(f"loom 桥报错：{out.get('error')}")
        return out

    # ── 契约 ──────────────────────────────────────────────────────────
    def ingest(self, chapters: list[dict]) -> dict:
        out = self._rpc({'op': 'ingest', 'mode': self.mode, 'chapters': [
            {'cid': c['cid'], 'title': c.get('title') or c.get('doc') or '', 'text': c['text']}
            for c in chapters
        ]})
        return {'chapters': out['n'], 'mode': self.mode,
                'settled_slow': out.get('settled_slow', 0)}

    def retrieve(self, query: str, k: int = 10) -> list[dict]:
        return self._rpc({'op': 'retrieve', 'query': query, 'k': k})['hits']

    def count(self) -> int:
        return self._rpc({'op': 'count'})['n']

    def is_empty(self) -> bool:
        return self.count() == 0

    def close(self) -> None:
        try:
            if self._proc.poll() is None:
                self._rpc({'op': 'close'})
        except Exception:                                # noqa: BLE001
            pass
        finally:
            try:
                self._proc.terminate()
            except Exception:                            # noqa: BLE001
                pass


if __name__ == '__main__':                              # 手工冒烟：python -m … loom_adapter
    here = Path(__file__).resolve().parent
    sys.path.insert(0, str(here))
    ad = LoomAdapter(db=sys.argv[1] if len(sys.argv) > 1 else str(Path.home() / 'loom-smoke.db'))
    print('count=', ad.count())
    print(ad.retrieve('猎户项目 的依赖名', k=3))
    ad.close()
