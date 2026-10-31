const COLORS = [
  { id: "red", name: "红", hex: "#d64545", ink: "#fff" },
  { id: "orange", name: "橙", hex: "#ef8a2a", ink: "#2a1608" },
  { id: "yellow", name: "黄", hex: "#f2c14e", ink: "#2a2110" },
  { id: "green", name: "绿", hex: "#2f9d5b", ink: "#fff" },
  { id: "cyan", name: "青", hex: "#1aa0b4", ink: "#042226" },
  { id: "blue", name: "蓝", hex: "#3c6fe0", ink: "#fff" },
  { id: "purple", name: "紫", hex: "#7c5cbf", ink: "#fff" },
  { id: "pink", name: "粉", hex: "#e25a9a", ink: "#fff" },
  { id: "brown", name: "棕", hex: "#8a5a38", ink: "#fff" },
  { id: "lime", name: "柳", hex: "#8fbf3f", ink: "#1c240c" },
  { id: "white", name: "白", hex: "#f3efe8", ink: "#2a241c" },
  { id: "ink", name: "墨", hex: "#6d6a86", ink: "#fff" },
];

const MIN_CAPACITY = 2;
const MAX_CAPACITY = 6;
const MAX_TUBES = 14;

const SAMPLE = {
  capacity: 4,
  tubes: [
    ["red", "green", "blue", "red"],
    ["green", "blue", "red", "green"],
    ["blue", "red", "green", "blue"],
    [],
    [],
  ],
};

const colorById = Object.fromEntries(COLORS.map((color) => [color.id, color]));

const ui = {
  capacity: 4,
  tubes: [],
  selected: "red",
  mode: "edit",
  puzzle: null,
  frames: null,
  moves: null,
  cursor: 0,
  timer: null,
  request: 0,
  busy: false,
};

const board = document.querySelector("#board");
const palette = document.querySelector("#palette");
const steps = document.querySelector("#steps");
const statusBox = document.querySelector("#status");
const ruleBox = document.querySelector("#rule");
const playback = document.querySelector("#playback");
const caption = document.querySelector("#caption");
const capValue = document.querySelector("#cap-value");
const solveButton = document.querySelector("#solve");
const playButton = document.querySelector("#play");
const emptySteps = document.querySelector("#empty-steps");
const jumpStart = document.querySelector("#jump-start");

function nameOf(id) {
  return colorById[id] ? colorById[id].name : id;
}

function cloneTubes(tubes) {
  return tubes.map((tube) => tube.slice());
}

function loadPuzzle(capacity, tubes) {
  stopPlay();
  ui.capacity = capacity;
  ui.tubes = cloneTubes(tubes);
  ui.mode = "edit";
  ui.puzzle = null;
  ui.frames = null;
  ui.moves = null;
  ui.cursor = 0;
  setStatus("");
  render();
}

function shownTubes() {
  if (ui.mode === "view" && ui.frames) return ui.frames[ui.cursor];
  return ui.tubes;
}

function audit(tubes, capacity) {
  const counts = {};
  for (const tube of tubes) {
    for (const id of tube) counts[id] = (counts[id] || 0) + 1;
  }
  const bad = [];
  for (const [id, count] of Object.entries(counts)) {
    if (count % capacity !== 0) bad.push(`${nameOf(id)} ${count} 格`);
  }
  if (bad.length) {
    return `${bad.join("、")}不是容量 ${capacity} 的整数倍，这样无解。`;
  }
  const needed = Object.values(counts).reduce((sum, count) => sum + count, 0) / capacity;
  if (needed > tubes.length) {
    return `这些水至少要 ${needed} 支试管，现在只有 ${tubes.length} 支。`;
  }
  return "";
}

function setStatus(message, detail) {
  statusBox.replaceChildren();
  if (!message) return;
  statusBox.append(document.createTextNode(message));
  if (detail) {
    const small = document.createElement("small");
    small.textContent = detail;
    statusBox.append(small);
  }
}

function renderPalette() {
  palette.replaceChildren();
  for (const color of COLORS) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "swatch";
    button.style.background = color.hex;
    button.style.color = color.ink;
    button.textContent = color.name;
    button.setAttribute("aria-label", color.name);
    button.setAttribute("aria-pressed", String(ui.selected === color.id));
    button.addEventListener("click", () => {
      ui.selected = color.id;
      renderPalette();
    });
    palette.append(button);
  }
  const eraser = document.createElement("button");
  eraser.type = "button";
  eraser.className = "swatch eraser";
  eraser.textContent = "空";
  eraser.setAttribute("aria-label", "去掉颜色");
  eraser.setAttribute("aria-pressed", String(ui.selected === null));
  eraser.addEventListener("click", () => {
    ui.selected = null;
    renderPalette();
  });
  palette.append(eraser);
}

function renderBoard() {
  const tubes = shownTubes();
  const editing = ui.mode === "edit" && !ui.busy;
  const move = ui.mode === "view" && ui.cursor > 0 ? ui.moves[ui.cursor - 1] : null;
  board.replaceChildren();
  tubes.forEach((tube, index) => {
    const vial = document.createElement("div");
    vial.className = "vial";
    if (move && move.from === index) vial.classList.add("from");
    if (move && move.to === index) vial.classList.add("to");

    const tools = document.createElement("div");
    tools.className = "vial-tools";
    if (editing && tubes.length > 1) {
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "remove";
      remove.textContent = "×";
      remove.setAttribute("aria-label", `移除试管 ${index + 1}`);
      remove.addEventListener("click", () => {
        ui.tubes.splice(index, 1);
        clearSolution();
        render();
      });
      tools.append(remove);
    }
    const tag = document.createElement("div");
    tag.className = "pour-tag";
    if (move && move.from === index) tag.textContent = "倒出";
    if (move && move.to === index) tag.textContent = "倒入";

    const glass = document.createElement("div");
    glass.className = "glass";

    for (let slot = ui.capacity - 1; slot >= 0; slot -= 1) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "slot";
      const id = tube[slot];
      if (id) {
        const color = colorById[id];
        button.classList.add("filled");
        button.textContent = color ? color.name : id;
        button.style.background = color ? color.hex : "#888";
        button.style.color = color ? color.ink : "#fff";
        if (move && move.to === index && slot >= tube.length - move.amount) {
          button.classList.add("just-poured");
        }
        button.setAttribute("aria-label", `试管 ${index + 1} 从下数第 ${slot + 1} 格，${nameOf(id)}`);
      } else {
        button.classList.add("empty");
        if (editing && slot === tube.length && ui.selected) button.classList.add("next");
        button.setAttribute("aria-label", `试管 ${index + 1} 从下数第 ${slot + 1} 格，空`);
      }
      if (!editing) button.classList.add("locked");
      button.addEventListener("click", () => editSlot(index, slot));
      glass.append(button);
    }

    const number = document.createElement("div");
    number.className = "vial-no";
    number.textContent = String(index + 1);

    vial.append(tools, tag, glass, number);
    board.append(vial);
  });
}

function editSlot(index, slot) {
  if (ui.mode !== "edit") return;
  const tube = ui.tubes[index];
  if (slot < tube.length) {
    if (ui.selected === null) tube.splice(slot);
    else tube[slot] = ui.selected;
  } else if (ui.selected && slot === tube.length) {
    tube.push(ui.selected);
  } else {
    return;
  }
  clearSolution();
  render();
}

function renderSteps() {
  steps.replaceChildren();
  const viewing = ui.mode === "view" && ui.moves;
  emptySteps.hidden = Boolean(viewing);
  jumpStart.hidden = !viewing;
  if (!viewing) return;
  if (ui.cursor === 0) jumpStart.setAttribute("aria-current", "step");
  else jumpStart.removeAttribute("aria-current");
  ui.moves.forEach((move, index) => {
    const item = document.createElement("li");
    const button = document.createElement("button");
    button.type = "button";
    button.className = "step-btn";
    if (ui.cursor === index + 1) button.setAttribute("aria-current", "step");
    button.textContent = `${index + 1}. 试管 ${move.from + 1} → 试管 ${move.to + 1}，${nameOf(move.color)} ${move.amount} 格`;
    button.addEventListener("click", () => go(index + 1));
    item.append(button);
    steps.append(item);
  });
  const current = steps.querySelector('[aria-current="step"]');
  if (current) current.scrollIntoView({ block: "nearest" });
}

function renderPlayback() {
  const viewing = ui.mode === "view" && ui.moves;
  playback.hidden = !viewing;
  if (!viewing) {
    caption.textContent = "";
    return;
  }
  const total = ui.moves.length;
  if (ui.cursor === 0) caption.textContent = total ? `初始局面，共 ${total} 步` : "初始局面";
  else caption.textContent = `第 ${ui.cursor} / ${total} 步`;
  playButton.textContent = ui.timer ? "暂停" : "播放";
  document.querySelector("#prev").disabled = ui.cursor === 0;
  document.querySelector("#next").disabled = ui.cursor >= total;
  document.querySelector("#to-start").disabled = ui.cursor === 0;
  document.querySelector("#to-end").disabled = ui.cursor >= total;
}

function render() {
  capValue.textContent = String(ui.capacity);
  const locked = ui.mode !== "edit" || ui.busy;
  document.querySelector("#cap-dec").disabled = locked || ui.capacity <= MIN_CAPACITY;
  document.querySelector("#cap-inc").disabled = locked || ui.capacity >= MAX_CAPACITY;
  document.querySelector("#add-tube").disabled = locked || ui.tubes.length >= MAX_TUBES;
  document.querySelector("#clear").disabled = locked;
  document.querySelector("#sample").disabled = locked;
  solveButton.disabled = locked;
  solveButton.textContent = ui.busy ? "求解中…" : "求解";
  const editing = ui.mode === "edit";
  palette.hidden = !editing;
  ruleBox.textContent = editing ? audit(ui.tubes, ui.capacity) : "";
  renderBoard();
  renderSteps();
  renderPlayback();
}

function clearSolution() {
  stopPlay();
  ui.request += 1;
  ui.busy = false;
  ui.mode = "edit";
  ui.frames = null;
  ui.moves = null;
  ui.puzzle = null;
  ui.cursor = 0;
  setStatus("");
}

function applyMove(tubes, move) {
  const next = cloneTubes(tubes);
  const chunk = next[move.from].splice(next[move.from].length - move.amount, move.amount);
  next[move.to].push(...chunk);
  return next;
}

function showSolution(result) {
  ui.puzzle = cloneTubes(ui.tubes);
  ui.moves = result.moves;
  ui.frames = [cloneTubes(ui.puzzle)];
  for (const move of result.moves) {
    ui.frames.push(applyMove(ui.frames[ui.frames.length - 1], move));
  }
  ui.cursor = 0;
  ui.mode = "view";
  const detail = `搜索 ${result.explored} 个局面，用时 ${result.elapsed_ms} ms`;
  setStatus(result.message, detail);
  render();
}

async function solve() {
  const problem = audit(ui.tubes, ui.capacity);
  if (problem) {
    clearSolution();
    setStatus(problem);
    render();
    return;
  }
  const request = ++ui.request;
  ui.busy = true;
  setStatus("正在搜索最短步骤…");
  render();
  try {
    const response = await fetch("/api/solve", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ capacity: ui.capacity, tubes: ui.tubes }),
    });
    const result = await response.json();
    if (request !== ui.request) return;
    if (result.status === "solved") {
      showSolution(result);
      return;
    }
    const detail = result.explored
      ? `搜索 ${result.explored} 个局面，用时 ${result.elapsed_ms} ms`
      : "";
    setStatus(localize(result.message || "没有得到结果。"), detail);
    render();
  } catch (error) {
    if (request !== ui.request) return;
    setStatus("没有连上求解服务。在站点目录运行 python solver/server.py 后再打开本页。");
  } finally {
    if (request === ui.request) {
      ui.busy = false;
      render();
    }
  }
}

function localize(message) {
  const ordered = COLORS.slice().sort((a, b) => b.id.length - a.id.length);
  let text = message;
  for (const color of ordered) text = text.replaceAll(color.id, color.name);
  return text;
}

function go(cursor) {
  if (!ui.frames) return;
  ui.cursor = Math.max(0, Math.min(cursor, ui.moves.length));
  render();
}

function stopPlay() {
  if (ui.timer) {
    clearInterval(ui.timer);
    ui.timer = null;
  }
}

function togglePlay() {
  if (ui.timer) {
    stopPlay();
    renderPlayback();
    return;
  }
  if (ui.cursor >= ui.moves.length) go(0);
  ui.timer = setInterval(() => {
    if (ui.cursor >= ui.moves.length) {
      stopPlay();
      renderPlayback();
      return;
    }
    go(ui.cursor + 1);
  }, 700);
}

document.querySelector("#cap-dec").addEventListener("click", () => {
  if (ui.capacity <= MIN_CAPACITY || ui.mode !== "edit") return;
  ui.capacity -= 1;
  ui.tubes.forEach((tube) => tube.splice(ui.capacity));
  clearSolution();
  render();
});

document.querySelector("#cap-inc").addEventListener("click", () => {
  if (ui.capacity >= MAX_CAPACITY || ui.mode !== "edit") return;
  ui.capacity += 1;
  clearSolution();
  render();
});

document.querySelector("#add-tube").addEventListener("click", () => {
  if (ui.tubes.length >= MAX_TUBES || ui.mode !== "edit") return;
  ui.tubes.push([]);
  clearSolution();
  render();
});

document.querySelector("#clear").addEventListener("click", () => {
  if (ui.mode !== "edit") return;
  ui.tubes = ui.tubes.map(() => []);
  clearSolution();
  render();
});

document.querySelector("#sample").addEventListener("click", () => {
  loadPuzzle(SAMPLE.capacity, SAMPLE.tubes);
});

document.querySelector("#back-edit").addEventListener("click", () => {
  if (ui.puzzle) ui.tubes = cloneTubes(ui.puzzle);
  clearSolution();
  render();
});

solveButton.addEventListener("click", solve);
document.querySelector("#prev").addEventListener("click", () => {
  stopPlay();
  go(ui.cursor - 1);
});
document.querySelector("#next").addEventListener("click", () => {
  stopPlay();
  go(ui.cursor + 1);
});
document.querySelector("#to-start").addEventListener("click", () => {
  stopPlay();
  go(0);
});
document.querySelector("#to-end").addEventListener("click", () => {
  stopPlay();
  go(ui.moves.length);
});
playButton.addEventListener("click", togglePlay);
jumpStart.addEventListener("click", () => {
  stopPlay();
  go(0);
});

loadPuzzle(SAMPLE.capacity, SAMPLE.tubes);
renderPalette();
