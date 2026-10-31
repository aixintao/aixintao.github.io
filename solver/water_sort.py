"""水排序最短路。

一步是一次倾倒：把源试管顶部连续的同色水，尽量倒进目标试管。
目标：每支试管要么空，要么装满同一种颜色。因此每种颜色的格数必须是容量的整数倍。
"""

from __future__ import annotations

from collections import deque
import time

MAX_TUBES = 14
MIN_CAPACITY = 2
MAX_CAPACITY = 6
DEFAULT_MAX_NODES = 200_000
DEFAULT_TIME_LIMIT = 1.5


def solve(
    tubes,
    capacity,
    max_nodes=DEFAULT_MAX_NODES,
    time_limit=DEFAULT_TIME_LIMIT,
):
    """返回最短倾倒。

    status 为 solved、unsolvable、timeout、invalid 之一。
    搜完可达局面才报无解；节点或时间到了上限则报 timeout，避免把「没搜完」说成无解。
    """
    problem = _validate(tubes, capacity)
    if problem is not None:
        return _result("invalid", problem)

    names, start = _encode(tubes)
    if _solved(start, capacity):
        return _result("solved", "已经排好了。", steps=0)

    try:
        node_limit = max(1, int(max_nodes))
    except (TypeError, ValueError):
        node_limit = DEFAULT_MAX_NODES
    try:
        seconds = max(0.0, float(time_limit))
    except (TypeError, ValueError):
        seconds = DEFAULT_TIME_LIMIT

    status, moves, explored, elapsed_ms = _search(start, capacity, node_limit, seconds)
    if status == "solved":
        steps = len(moves)
        text = "已经排好了。" if steps == 0 else f"最短 {steps} 步。"
        return _result(
            "solved",
            text,
            moves=[_move_name(move, names) for move in moves],
            explored=explored,
            elapsed_ms=elapsed_ms,
            steps=steps,
        )
    if status == "unsolvable":
        return _result(
            "unsolvable",
            f"已搜完全部 {explored} 个可达局面，确认无解。",
            explored=explored,
            elapsed_ms=elapsed_ms,
        )
    return _result(
        "timeout",
        f"搜了 {explored} 个局面、用时 {elapsed_ms} ms，仍未找到解。可能无解，也可能步数太长。",
        explored=explored,
        elapsed_ms=elapsed_ms,
    )


def _result(status, message, moves=None, explored=0, elapsed_ms=0, steps=None):
    return {
        "status": status,
        "steps": steps,
        "moves": moves or [],
        "explored": explored,
        "elapsed_ms": elapsed_ms,
        "message": message,
    }


def _validate(tubes, capacity):
    if isinstance(capacity, bool) or not isinstance(capacity, int):
        return "容量必须是整数。"
    if not MIN_CAPACITY <= capacity <= MAX_CAPACITY:
        return f"容量需要在 {MIN_CAPACITY} 到 {MAX_CAPACITY} 之间。"
    if not isinstance(tubes, list):
        return "试管数据不正确。"
    if not tubes:
        return "至少留下一支试管。"
    if len(tubes) > MAX_TUBES:
        return f"最多 {MAX_TUBES} 支试管。"

    counts = {}
    for index, tube in enumerate(tubes, start=1):
        if not isinstance(tube, list):
            return f"第 {index} 支试管数据不正确。"
        if len(tube) > capacity:
            return f"第 {index} 支试管超过了容量。"
        for cell in tube:
            if not isinstance(cell, str) or not cell.strip():
                return f"第 {index} 支试管里有空的颜色。"
            name = cell.strip()
            if len(name) > 24:
                return "颜色名字太长。"
            counts[name] = counts.get(name, 0) + 1

    for name, count in counts.items():
        if count % capacity != 0:
            return f"颜色 {name} 有 {count} 格，不是容量 {capacity} 的整数倍。"
    needed = sum(counts.values()) // capacity
    if needed > len(tubes):
        return f"这些水至少要 {needed} 支试管，现在只有 {len(tubes)} 支。"
    return None


def _encode(tubes):
    names = []
    index = {}
    encoded = []
    for tube in tubes:
        row = []
        for cell in tube:
            name = cell.strip()
            if name not in index:
                index[name] = len(names)
                names.append(name)
            row.append(index[name])
        encoded.append(tuple(row))
    return names, tuple(encoded)


def _solved(state, capacity):
    for tube in state:
        if not tube:
            continue
        if len(tube) != capacity:
            return False
        color = tube[0]
        for cell in tube:
            if cell != color:
                return False
    return True


def _move_name(move, names):
    source, target, color, amount = move
    return {
        "from": source,
        "to": target,
        "color": names[color],
        "amount": amount,
    }


def _search(start, capacity, node_limit, seconds):
    """带对称剪枝的广度优先搜索。内容相同的试管互换后视为同一局面。"""
    started = time.perf_counter()
    deadline = started + seconds
    start_key = tuple(sorted(start))
    parent = {start_key: None}
    seen = {start_key}
    queue = deque([(start, start_key)])
    explored = 0

    while queue:
        if explored >= node_limit or time.perf_counter() >= deadline:
            elapsed_ms = int((time.perf_counter() - started) * 1000)
            return "timeout", [], explored, elapsed_ms

        state, state_key = queue.popleft()
        explored += 1
        first_empty = -1
        for index, tube in enumerate(state):
            if not tube:
                first_empty = index
                break

        for source, src in enumerate(state):
            if not src:
                continue
            color = src[-1]
            run = 1
            cursor = len(src) - 2
            while cursor >= 0 and src[cursor] == color:
                run += 1
                cursor -= 1
            # 已经倒满的单色试管是完成态，再倒出去只会把步数变长。
            if run == capacity and len(src) == capacity:
                continue

            for target, dst in enumerate(state):
                if source == target:
                    continue
                space = capacity - len(dst)
                if space <= 0:
                    continue
                if not dst:
                    # 多支空试管只倒进最靠前的一支；整段单色倒进空管只是换位置。
                    if target != first_empty or run == len(src):
                        continue
                elif dst[-1] != color:
                    continue

                amount = run if run < space else space
                items = list(state)
                items[source] = src[:-amount]
                items[target] = dst + (color,) * amount
                nxt = tuple(items)
                nxt_key = tuple(sorted(nxt))
                if nxt_key in seen:
                    continue
                seen.add(nxt_key)
                parent[nxt_key] = (state_key, (source, target, color, amount))
                if _solved(nxt, capacity):
                    elapsed_ms = int((time.perf_counter() - started) * 1000)
                    return "solved", _rebuild(parent, nxt_key), explored, elapsed_ms
                queue.append((nxt, nxt_key))

    elapsed_ms = int((time.perf_counter() - started) * 1000)
    return "unsolvable", [], explored, elapsed_ms


def _rebuild(parent, key):
    moves = []
    while parent[key] is not None:
        key, move = parent[key]
        moves.append(move)
    moves.reverse()
    return moves
