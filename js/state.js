/* ============================================================
   state.js — 文件模型 + 復原/重做
   ------------------------------------------------------------
   資料模型
     FileEntry { id, name, kind:'pdf'|'image', mime, bytes, color, pageCount, addedAt }
     Page      { id, kind:'pdf'|'image'|'blank'|'split', fileId, srcIndex,
                 rotation, selected, width, height, seq }

   kind 'split' 是「分割符號」，本身不產生任何頁面，只是在匯出時把後面的
   內容切到下一個檔案。它同樣放在 pages 陣列裡，因此拖曳、刪除、復原
   全部沿用既有機制。

   pages 是唯一的「順序來源」。files 只是原始位元組與外觀的倉庫，
   刪光某檔案的所有頁面後該檔案仍留在 files 中（重做時還需要它）。
   ============================================================ */

/** 每個來源檔案分配一個色相，用來畫色塊與檔名徽章 */
const HUES = [214, 22, 152, 265, 330, 45, 190, 288, 8, 100, 240, 170];

let hueCursor = 0;
export function nextColor() {
  const h = HUES[hueCursor++ % HUES.length];
  return {
    solid: `hsl(${h} 72% 48%)`,
    chipBg: `hsl(${h} 55% 26%)`,
    chipFg: `hsl(${h} 85% 80%)`,
  };
}

let seq = 0;
export const uid = (prefix = 'x') => `${prefix}${++seq}`;

/** 「加入的先後順序」計數器，用於「還原成加入時的順序」 */
let orderSeq = 0;
export const nextSeq = () => ++orderSeq;

export const store = {
  /** @type {Map<string, any>} */
  files: new Map(),
  /** @type {any[]} */
  pages: [],
  view: 'pages',      // 'pages' | 'files'
  layout: 'grid',     // 'grid'  | 'list'
  thumbW: 132,

  /* 收合狀態屬於檢視設定，不進復原/重做 */
  groupMode: true,            // true = 同一份文件的連續頁面收成一疊
  expanded: new Set(),        // 明確展開的群組（key 是群組第一頁的 id）
};

/* ---------------- 復原 / 重做 ---------------- */

const HISTORY_LIMIT = 60;
const past = [];
const future = [];

const snapshot = () => store.pages.map((p) => ({ ...p }));

/**
 * 包住一次會改變 pages 的操作，自動記錄快照。
 * @param {() => void} mutate
 */
export function commit(mutate) {
  past.push(snapshot());
  if (past.length > HISTORY_LIMIT) past.shift();
  future.length = 0;
  mutate();
}

export function undo() {
  if (!past.length) return false;
  future.push(snapshot());
  store.pages = past.pop();
  return true;
}

export function redo() {
  if (!future.length) return false;
  past.push(snapshot());
  store.pages = future.pop();
  return true;
}

export const canUndo = () => past.length > 0;
export const canRedo = () => future.length > 0;

export function clearHistory() {
  past.length = 0;
  future.length = 0;
}

/* ---------------- 查詢輔助 ---------------- */

export const selectedPages = () => store.pages.filter((p) => p.selected);
export const pageById = (id) => store.pages.find((p) => p.id === id);
export const indexOfPage = (id) => store.pages.findIndex((p) => p.id === id);

/** 依 pages 目前順序推導出的檔案順序（每個檔案取第一次出現的位置） */
export function fileOrder() {
  const seen = [];
  for (const p of store.pages) {
    if (p.fileId && !seen.includes(p.fileId)) seen.push(p.fileId);
  }
  return seen;
}

/* ---------------- 群組（收合成一疊） ---------------- */

/**
 * 把 pages 切成「連續同來源」的群組。分割符號自成一組，空白頁也自成一組。
 * 例如 A1 B1 A2 A3 A4 B2 B3 B4 會分成 [A1] [B1] [A2 A3 A4] [B2 B3 B4]。
 * @returns {Array<{type:'group'|'split', pages?:any[], item?:any, fileId?:string, start:number}>}
 */
export function pageGroups() {
  const groups = [];
  let cur = null;

  store.pages.forEach((item, index) => {
    if (isSplit(item)) {
      groups.push({ type: 'split', item, start: index });
      cur = null;
      return;
    }
    if (cur && item.fileId && cur.fileId === item.fileId) {
      cur.pages.push(item);
      return;
    }
    cur = { type: 'group', fileId: item.fileId, pages: [item], start: index };
    groups.push(cur);
    if (!item.fileId) cur = null;        // 空白頁不吸收後面的頁面
  });

  return groups;
}

export const groupLeader = (g) => g.pages[0].id;

/** 單頁群組沒有收合的意義，一律視為展開 */
export const isGroupExpanded = (g) =>
  !store.groupMode || g.pages.length === 1 || store.expanded.has(g.pages[0].id);

/**
 * 展開／收合單一群組。
 * 目前是「全部展開」時收合其中一組，會切回收合模式並把其他組記成展開，
 * 這樣只用一個布林 + 一個集合就能表達所有狀態。
 */
export function setGroupExpanded(leaderId, on) {
  if (on) {
    store.expanded.add(leaderId);
    return;
  }
  if (!store.groupMode) {
    store.expanded = new Set(
      pageGroups()
        .filter((g) => g.type === 'group' && g.pages.length > 1)
        .map(groupLeader)
        .filter((id) => id !== leaderId),
    );
    store.groupMode = true;
  } else {
    store.expanded.delete(leaderId);
  }
}

export function setExpandAll(on) {
  store.groupMode = !on;
  store.expanded.clear();
}

/** 目前畫面上是不是每一組都展開了 */
export function allExpanded() {
  if (!store.groupMode) return true;
  return pageGroups()
    .filter((g) => g.type === 'group' && g.pages.length > 1)
    .every((g) => store.expanded.has(groupLeader(g)));
}

/** 有沒有任何可以收合的群組（決定按鈕要不要 disabled） */
export const hasCollapsibleGroups = () =>
  pageGroups().some((g) => g.type === 'group' && g.pages.length > 1);

/* ---------------- 頁面操作（皆需包在 commit 內） ---------------- */

/** 分割符號：不是頁面，只標記「這裡開始是下一個檔案」 */
export function makeSplit() {
  return {
    id: uid('s'), kind: 'split', fileId: null, srcIndex: -1,
    rotation: 0, selected: false, width: 0, height: 0, seq: nextSeq(),
  };
}

export const isSplit = (p) => p.kind === 'split';
/** 真正會產生頁面的項目（排除分割符號） */
export const realPages = () => store.pages.filter((p) => !isSplit(p));

/**
 * 依分割符號把 pages 切成數段，每一段會輸出成一個 PDF。
 * 連續的、開頭的、結尾的分割符號都不會產生空檔案。
 */
export function splitSegments(pages = store.pages) {
  const segments = [];
  let current = [];
  for (const p of pages) {
    if (isSplit(p)) {
      if (current.length) segments.push(current);
      current = [];
    } else {
      current.push(p);
    }
  }
  if (current.length) segments.push(current);
  return segments;
}

/**
 * 找出「來源文件換人」的邊界索引，供批次插入分割符號／空白頁使用。
 * @param {(p:any)=>boolean} isSeparator 遇到這種項目就視為已經隔開了，不重複插入
 * @returns {number[]} 由小到大的插入位置
 */
export function documentBoundaries(isSeparator) {
  const list = [];
  let prevFile = null;
  store.pages.forEach((p, i) => {
    if (isSeparator(p)) { prevFile = null; return; }
    if (!p.fileId) return;                    // 空白頁／分割符號不影響判斷
    if (prevFile && p.fileId !== prevFile) list.push(i);
    prevFile = p.fileId;
  });
  return list;
}

export function makeBlankPage(width = 595.28, height = 841.89) {
  return {
    id: uid('p'), kind: 'blank', fileId: null, srcIndex: -1,
    rotation: 0, selected: false, width, height, seq: nextSeq(),
  };
}

/** 把 pages 插入到指定位置 */
export function insertPages(at, newPages) {
  const i = Math.max(0, Math.min(at, store.pages.length));
  store.pages.splice(i, 0, ...newPages);
}

export function removePages(ids) {
  const set = new Set(ids);
  store.pages = store.pages.filter((p) => !set.has(p.id));
}

export function duplicatePage(id) {
  const i = indexOfPage(id);
  if (i < 0) return;
  const copy = { ...store.pages[i], id: uid('p'), selected: false };
  store.pages.splice(i + 1, 0, copy);
}

export function rotatePages(ids, delta = 90) {
  const set = new Set(ids);
  for (const p of store.pages) {
    if (set.has(p.id) && !isSplit(p)) {
      p.rotation = (((p.rotation + delta) % 360) + 360) % 360;
    }
  }
}

/**
 * 把一組頁面搬到 targetIndex（targetIndex 以「搬移前」的索引為準）。
 * @param {string[]} ids 依畫面順序排好的頁面 id
 * @param {number} targetIndex 插入邊界 0..pages.length
 */
export function movePages(ids, targetIndex) {
  const set = new Set(ids);
  // 目標邊界之前被抽走幾張，插入點就要往前移幾格
  const removedBefore = store.pages
    .slice(0, targetIndex)
    .filter((p) => set.has(p.id)).length;

  const moving = store.pages.filter((p) => set.has(p.id));
  const rest = store.pages.filter((p) => !set.has(p.id));
  rest.splice(targetIndex - removedBefore, 0, ...moving);
  store.pages = rest;
}

/** 依新的檔案順序重新分組頁面（檔案檢視用），檔案內頁序不變 */
export function reorderByFiles(newFileOrder) {
  const buckets = new Map(newFileOrder.map((id) => [id, []]));
  const orphans = [];
  for (const p of store.pages) {
    if (p.fileId && buckets.has(p.fileId)) buckets.get(p.fileId).push(p);
    else orphans.push(p);
  }
  store.pages = [...newFileOrder.flatMap((id) => buckets.get(id)), ...orphans];
}

/* ---------------- 排序 ---------------- */

/**
 * @returns {number} 依檔名排序時被清掉的分割符號數量
 */
export function sortPages(mode) {
  const nameOf = (p) => (store.files.get(p.fileId)?.name ?? '￿').toLowerCase();

  if (mode === 'reverse') {
    store.pages.reverse();
    return 0;
  }
  if (mode === 'original') {
    store.pages.sort((a, b) => a.seq - b.seq);
    return 0;
  }

  // 依檔名重排之後，原本的分割位置已經沒有意義了，直接移除
  const dropped = store.pages.filter(isSplit).length;
  if (dropped) store.pages = store.pages.filter((p) => !isSplit(p));
  const dir = mode === 'name-desc' ? -1 : 1;
  store.pages.sort((a, b) => {
    const c = nameOf(a).localeCompare(nameOf(b), 'zh-Hant', { numeric: true });
    if (c !== 0) return c * dir;
    // 同一個檔案內永遠維持原始頁序
    return a.srcIndex - b.srcIndex || a.seq - b.seq;
  });
  return dropped;
}

export function resetAll() {
  store.files.clear();
  store.pages = [];
  store.groupMode = true;
  store.expanded.clear();
  hueCursor = 0;
  clearHistory();
}
