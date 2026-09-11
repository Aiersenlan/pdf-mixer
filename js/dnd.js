/* ============================================================
   dnd.js — 拖曳排序（頁面卡片 / 檔案列）
   ------------------------------------------------------------
   用原生 HTML5 drag and drop。插入位置由「離游標最近的卡片邊界」
   決定，格狀與清單兩種排版都適用。
   ============================================================ */

import { store } from './state.js';

const board = document.querySelector('#board');
const workspace = document.querySelector('#workspace');

let dragging = null;   // { kind:'page'|'file', ids:string[] }
let dropAt = null;     // 插入邊界索引
let autoScrollTimer = null;
let endedAt = 0;               // 內部拖曳結束的時間

/**
 * @param {{onMovePages:(ids:string[], at:number)=>void,
 *          onMoveFile:(fileId:string, at:number)=>void}} handlers
 */
export function initDnd(handlers) {
  board.addEventListener('dragstart', (e) => onDragStart(e));
  board.addEventListener('dragend', clearDrag);

  workspace.addEventListener('dragover', (e) => {
    if (!dragging) return;                       // 外部檔案拖入由 app.js 處理
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    updateDropTarget(e.clientX, e.clientY);
    autoScroll(e.clientY);
  });

  workspace.addEventListener('drop', (e) => {
    if (!dragging) return;
    e.preventDefault();
    e.stopPropagation();          // 別讓 window 上的「加入檔案」處理器也收到
    const { kind, ids } = dragging;
    const at = dropAt;
    clearDrag();
    if (at === null) return;
    if (kind === 'page') handlers.onMovePages(ids, at);
    else handlers.onMoveFile(ids[0], at);
  });
}

function onDragStart(e) {
  const card = e.target.closest('.card');
  const row = e.target.closest('.file-row');

  if (card) {
    // 收合起來的一疊代表整組頁面，要一起搬
    const own = card.dataset.ids ? card.dataset.ids.split(',') : [card.dataset.id];
    const anySelected = own.some((id) => store.pages.find((p) => p.id === id)?.selected);
    // 拖一張被選取的卡片時，整組選取的頁面一起搬
    const ids = anySelected
      ? store.pages.filter((p) => p.selected).map((p) => p.id)
      : own;

    dragging = { kind: 'page', ids };
    const set = new Set(ids);
    for (const el of board.querySelectorAll('.card')) {
      const elIds = el.dataset.ids ? el.dataset.ids.split(',') : [el.dataset.id];
      if (elIds.some((id) => set.has(id))) el.classList.add('dragging');
    }
  } else if (row) {
    dragging = { kind: 'file', ids: [row.dataset.fileId] };
    row.classList.add('dragging');
  } else {
    return;
  }

  e.dataTransfer.effectAllowed = 'move';
  // Firefox 需要有資料才會啟動拖曳
  e.dataTransfer.setData('text/plain', dragging.ids.join(','));
}

function clearDrag() {
  if (dragging) endedAt = Date.now();
  dragging = null;
  dropAt = null;
  clearTimeout(autoScrollTimer);
  autoScrollTimer = null;
  for (const el of board.querySelectorAll('.dragging, .drop-target, .drop-before, .drop-after')) {
    el.classList.remove('dragging', 'drop-target', 'drop-before', 'drop-after');
  }
}

/* ---------------- 計算並顯示插入點 ---------------- */

function updateDropTarget(x, y) {
  const selector = dragging.kind === 'file' ? '.file-row' : '.card';
  const items = [...board.querySelectorAll(selector)];
  if (!items.length) { dropAt = 0; return; }

  const vertical = dragging.kind === 'file' || store.layout === 'list';
  let best = null;
  let bestDist = Infinity;

  items.forEach((el, i) => {
    const r = el.getBoundingClientRect();
    // 一張卡片可能代表好幾頁（收合的一疊），插入點要看 data-index / data-end
    const startAt = el.dataset.index !== undefined ? Number(el.dataset.index) : i;
    const endAt = el.dataset.end !== undefined ? Number(el.dataset.end) : i + 1;

    const edges = vertical
      ? [[r.left + r.width / 2, r.top, startAt, 'before'],
         [r.left + r.width / 2, r.bottom, endAt, 'after']]
      : [[r.left, r.top + r.height / 2, startAt, 'before'],
         [r.right, r.top + r.height / 2, endAt, 'after']];

    for (const [px, py, at, side] of edges) {
      const d = Math.hypot(px - x, py - y);
      if (d < bestDist) { bestDist = d; best = { at, el, side }; }
    }
  });

  if (!best || best.at === dropAt) return;
  dropAt = best.at;
  paintDropTarget(best, vertical);
}

function paintDropTarget(best, vertical) {
  for (const el of board.querySelectorAll('.drop-target, .drop-before, .drop-after')) {
    el.classList.remove('drop-target', 'drop-before', 'drop-after');
  }

  if (!vertical) {
    const gap = board.querySelector(`.gap[data-index="${dropAt}"]`);
    if (gap) { gap.classList.add('drop-target'); return; }
  }
  best.el.classList.add(best.side === 'before' ? 'drop-before' : 'drop-after');
}

/* ---------------- 拖到邊緣自動捲動 ---------------- */

function autoScroll(y) {
  const r = workspace.getBoundingClientRect();
  const EDGE = 70;
  let dy = 0;
  if (y < r.top + EDGE) dy = -Math.ceil((r.top + EDGE - y) / 4);
  else if (y > r.bottom - EDGE) dy = Math.ceil((y - (r.bottom - EDGE)) / 4);

  clearTimeout(autoScrollTimer);
  if (!dy) return;
  const step = () => {
    workspace.scrollTop += dy;
    autoScrollTimer = setTimeout(step, 16);
  };
  step();
}

/**
 * 拖曳結束後的短暫窗口也算「內部拖曳」：drop 事件在各處理器之間傳遞是有時間差的，
 * 這段緩衝可以擋掉殘留的檔案拖放事件。
 */
export const isDraggingInternally = () => dragging !== null || Date.now() - endedAt < 400;
