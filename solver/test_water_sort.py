"""对照一份不剪枝的广度优先搜索，确认剪枝没有把最短步数算短或算长。"""

from collections import deque
import time
import unittest

from water_sort import solve


def _solved(state, capacity):
    for tube in state:
        if not tube:
            continue
        if len(tube) != capacity or any(cell != tube[0] for cell in tube):
            return False
    return True


def _pours(state, capacity):
    """规则内的全部倒法，不含对称剪枝。"""
    found = []
    for source, src in enumerate(state):
        if not src:
            continue
        color = src[-1]
        run = 1
        cursor = len(src) - 2
        while cursor >= 0 and src[cursor] == color:
            run += 1
            cursor -= 1
        for target, dst in enumerate(state):
            if source == target:
                continue
            space = capacity - len(dst)
            if space <= 0 or (dst and dst[-1] != color):
                continue
            amount = min(run, space)
            items = list(state)
            items[source] = src[:-amount]
            items[target] = dst + (color,) * amount
            found.append((source, target, color, amount, tuple(items)))
    return found


def reference(tubes, capacity, node_limit=100_000):
    start = tuple(tuple(tube) for tube in tubes)
    queue = deque([start])
    parent = {start: None}
    explored = 0
    while queue:
        state = queue.popleft()
        explored += 1
        if explored > node_limit:
            return None
        if _solved(state, capacity):
            moves = []
            while parent[state] is not None:
                state, move = parent[state]
                moves.append(move)
            moves.reverse()
            return moves
        for source, target, color, amount, nxt in _pours(state, capacity):
            if nxt in parent:
                continue
            parent[nxt] = (state, (source, target, color, amount))
            queue.append(nxt)
    return []


def replay(tubes, capacity, moves):
    state = [list(tube) for tube in tubes]
    for move in moves:
        src = state[move["from"]]
        amount = move["amount"]
        if amount < 1 or len(src) < amount:
            raise AssertionError(move)
        chunk = src[-amount:]
        if any(cell != move["color"] for cell in chunk):
            raise AssertionError(move)
        if len(src) > amount and src[-amount - 1] == move["color"]:
            # 空位不够时可以只倒出一部分，但顶部同色段必须被倒到空位上限。
            pass
        dst = state[move["to"]]
        if len(dst) + amount > capacity:
            raise AssertionError(move)
        if dst and dst[-1] != move["color"]:
            raise AssertionError(move)
        del src[-amount:]
        dst.extend(chunk)
    return state


class SolveTests(unittest.TestCase):
    def assert_matches_reference(self, tubes, capacity):
        expected = reference(tubes, capacity)
        self.assertIsNotNone(expected, "对照搜索超出了节点上限")
        result = solve(tubes, capacity)
        self.assertEqual(result["status"], "solved" if expected is not None else "unsolvable")
        if expected == [] and not _solved(tuple(tuple(t) for t in tubes), capacity):
            self.assertEqual(result["status"], "unsolvable")
            return
        self.assertEqual(result["status"], "solved")
        self.assertEqual(result["steps"], len(expected))
        final = replay(tubes, capacity, result["moves"])
        self.assertTrue(_solved(tuple(tuple(t) for t in final), capacity))

    def test_already_solved(self):
        result = solve([["a", "a"], ["b", "b"], []], 2)
        self.assertEqual(result["status"], "solved")
        self.assertEqual(result["steps"], 0)
        self.assertEqual(result["moves"], [])

    def test_two_pours(self):
        tubes = [["a", "b"], ["a"], ["b"], []]
        self.assert_matches_reference(tubes, 2)
        result = solve(tubes, 2)
        self.assertEqual(result["steps"], 2)
        self.assertEqual(result["moves"][0]["amount"], 1)

    def test_only_empty_first(self):
        self.assert_matches_reference([["a", "b"], ["b", "a"], []], 2)

    def test_space_limits_one_pour(self):
        tubes = [["a", "b", "b"], ["b"], ["a", "a"]]
        result = solve(tubes, 3)
        self.assertEqual(result["status"], "solved")
        self.assertEqual(result["steps"], 2)
        self.assertEqual(result["moves"][0], {"from": 0, "to": 1, "color": "b", "amount": 2})
        self.assertEqual(result["moves"][1]["amount"], 1)
        self.assert_matches_reference(tubes, 3)

    def test_same_color_two_tubes(self):
        self.assert_matches_reference([["a"], ["a"], ["a"], ["a"], []], 2)

    def test_sample_level(self):
        tubes = [
            ["red", "green", "blue", "red"],
            ["green", "blue", "red", "green"],
            ["blue", "red", "green", "blue"],
            [],
            [],
        ]
        result = solve(tubes, 4)
        self.assertEqual(result["status"], "solved")
        self.assertGreater(result["steps"], 0)
        final = replay(tubes, 4, result["moves"])
        self.assertTrue(_solved(tuple(tuple(t) for t in final), 4))
        self.assert_matches_reference(tubes, 4)

    def test_invalid_count_returns_immediately(self):
        started = time.perf_counter()
        result = solve([["red", "red", "red"], []], 4)
        self.assertLess(time.perf_counter() - started, 0.2)
        self.assertEqual(result["status"], "invalid")
        self.assertIn("red", result["message"])

    def test_blocked_is_unsolvable(self):
        tubes = [
            ["r", "r", "r", "g"],
            ["g", "g", "g", "b"],
            ["b", "b", "b", "y"],
            ["y", "y", "y", "r"],
        ]
        started = time.perf_counter()
        result = solve(tubes, 4)
        self.assertLess(time.perf_counter() - started, 0.2)
        self.assertEqual(result["status"], "unsolvable")

    def test_node_cap_does_not_hang(self):
        tubes = [
            ["red", "green", "blue", "red"],
            ["green", "blue", "red", "green"],
            ["blue", "red", "green", "blue"],
            [],
            [],
        ]
        started = time.perf_counter()
        result = solve(tubes, 4, max_nodes=1, time_limit=5)
        self.assertLess(time.perf_counter() - started, 0.5)
        self.assertEqual(result["status"], "timeout")

    def test_wide_puzzle_stops_at_deadline(self):
        tubes = _scrambled(colors=8, capacity=4, empties=2, pours=30, seed=7)
        started = time.perf_counter()
        result = solve(tubes, 4, max_nodes=10**9, time_limit=0.35)
        elapsed = time.perf_counter() - started
        self.assertLess(elapsed, 1.0)
        self.assertIn(result["status"], ("solved", "unsolvable", "timeout"))


def _scrambled(colors, capacity, empties, pours, seed):
    state = [(f"c{index}",) * capacity for index in range(colors)]
    state.extend([()] * empties)
    state = tuple(state)
    rng = _rng(seed)
    for _ in range(pours):
        options = _pours(state, capacity)
        if not options:
            break
        _source, _target, _color, _amount, state = options[rng(len(options))]
    return [list(tube) for tube in state]


def _rng(seed):
    def nxt(limit):
        nonlocal seed
        seed = (1664525 * seed + 1013904223) % 2**32
        return seed % limit

    return nxt


if __name__ == "__main__":
    unittest.main()
