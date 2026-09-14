/* ============================================================
   app.js — 事件接線與流程控制
   ============================================================ */

import {
  store, commit, undo, redo, clearHistory, resetAll,
  selectedPages, pageById, indexOfPage, fileOrder,
  makeBlankPage, makeSplit, insertPages, removePages, duplicatePage,
  rotatePages, movePages, reorderByFiles, sortPages,
  splitSegments, documentBoundaries,
  setGroupExpanded, setExpandAll, allExpanded, collapseSelectedGroups,
} from './state.js';

import {
  loadFile, exportPdf, exportPdfCompressed, downloadBytes, renderToCanvas, forgetRenderCache, A4,
} from './pdfio.js';

import { render, syncSelection, toast, busy, unbusy } from './ui.js';
import { initDnd, isDraggingInternally } from './dnd.js';
import { shareFiles, waitUntilLive } from './ghupload.js';

const $ = (s) => document.querySelector(s);

const els = {
  board: $('#board'),
  workspace: $('#workspace'),
  fileInput: $('#file-input'),
  dropOverlay: $('#drop-overlay'),
  menuInsert: $('#menu-insert'),
  preview: $('#preview-modal'),
  previewCanvas: $('#preview-canvas'),
  previewTitle: $('#preview-title'),
  btnDownload: $('#btn-download'),
  btnShare: $('#btn-share'),
  btnCopyLink: $('#btn-copy-link'),
  shareProgress: $('#share-progress'),
  shareProgressText: $('#share-progress-text'),
  shareProgressCancel: $('#share-progress-cancel'),
  marquee: $('#marquee'),
  downloadModal: $('#download-modal'),
  dlSizeLow: $('#dl-size-low'),
  dlSizeHigh: $('#dl-size-high'),
  dlTargetValue: $('#dl-target-value'),
  dlTargetUnit: $('#dl-target-unit'),
  dlCancel: $('#dl-cancel'),
  dlGo: $('#dl-go'),
};

/** 高壓縮預設的 DPI／JPEG 品質；指定大小壓不到時會依序試更重的設定 */
const HIGH_SETTINGS = { dpi: 120, quality: 0.6 };
const TARGET_STEPS = [
  { dpi: 100, quality: 0.45 },
  { dpi: 90, quality: 0.35 },
  { dpi: 72, quality: 0.25 },
  { dpi: 72, quality: 0.15 },
];

/** 最近一次「產生連結」成功的網址，給「複製連結」按鈕用。 */
let lastShareUrls = [];
/** 目前這次「產生連結」的取消把手；沒有在跑就是 null。 */
let shareController = null;

/** 下載視窗開著時，背景算好的「低壓縮」「高壓縮」結果；每次開窗都會作廢重算 */
let dlLowResult = null;
let dlHighResult = null;
let dlToken = 0;

/** 由「＋」按鈕觸發的新增，記住要插在哪個位置；null 代表接在最後面 */
let pendingInsertAt = null;
/** 目前預覽中的頁面索引 */
let previewIndex = -1;

/* ============================================================
   啟動
   ============================================================ */

function boot() {
  if (location.protocol === 'file:') {
    document.body.innerHTML =
      '<div style="padding:60px;font:16px system-ui;color:#e9eaec;line-height:1.9">' +
      '<h2>請透過本機伺服器開啟</h2>' +
      '<p>直接用 file:// 開啟時，瀏覽器會擋住 PDF 的 worker 與模組載入。</p>' +
      '<p>請改為執行專案根目錄的 <code>start.bat</code>，或在該目錄下執行：</p>' +
      '<pre style="background:#242424;padding:14px;border-radius:8px">python -m http.server 9321</pre>' +
      '<p>然後開啟 <code>http://localhost:9321</code>。</p></div>';
    return;
  }

  wireToolbar();
  wireSelectBar();
  wireBoard();
  wireMarqueeSelect();
  wireDragAndDrop();
  wireKeyboard();
  wirePreview();
  wireExport();

  initDnd({
    onMovePages: (ids, at) => {
      const ordered = store.pages.filter((p) => ids.includes(p.id)).map((p) => p.id);
      commit(() => movePages(ordered, at));
      render();
    },
    onMoveFile: (fileId, at) => {
      const order = fileOrder();
      const from = order.indexOf(fileId);
      if (from < 0) return;
      const target = at > from ? at - 1 : at;
      order.splice(from, 1);
      order.splice(Math.max(0, Math.min(target, order.length)), 0, fileId);
      commit(() => reorderByFiles(order));
      render();
    },
  });

  render();
}

/* ============================================================
   加入檔案
   ============================================================ */

async function addFiles(fileList, insertAt = null) {
  const files = [...fileList];
  if (!files.length) return;

  busy(`正在讀取 ${files.length} 個檔案…`);
  const newPages = [];
  const errors = [];

  for (const f of files) {
    try {
      newPages.push(...await loadFile(f));
    } catch (err) {
      errors.push(err.message || String(err));
    }
  }
  unbusy();

  if (newPages.length) {
    const at = insertAt ?? store.pages.length;
    commit(() => insertPages(at, newPages));
    render();
    toast(`已加入 ${newPages.length} 頁`);
  }
  if (errors.length) toast(errors.join('；'), true);
}

function pickFiles(insertAt = null) {
  pendingInsertAt = insertAt;
  els.fileInput.value = '';
  els.fileInput.click();
}

/* ============================================================
   工具列
   ============================================================ */

function wireToolbar() {
  els.fileInput.addEventListener('change', () => {
    const at = pendingInsertAt;
    pendingInsertAt = null;
    addFiles(els.fileInput.files, at);
  });

  for (const tab of document.querySelectorAll('.tab')) {
    tab.addEventListener('click', () => { store.view = tab.dataset.view; render(); });
  }

  bindMenu('#btn-add', '#menu-add', (act) => {
    if (act === 'add-file') pickFiles(null);
    if (act === 'add-blank-end') insertBlank(store.pages.length);
    if (act === 'split-between-docs') insertBetweenDocuments('split');
    if (act === 'blank-between-docs') insertBetweenDocuments('blank');
  });

  bindMenu('#btn-sort', '#menu-sort', null, (btn) => {
    let dropped = 0;
    commit(() => { dropped = sortPages(btn.dataset.sort); });
    render();
    toast(dropped ? `已重新排序，並移除 ${dropped} 個分割符號` : '已重新排序');
  });

  $('#btn-undo').addEventListener('click', () => { if (undo()) render(); });
  $('#btn-redo').addEventListener('click', () => { if (redo()) render(); });
  $('#btn-delete').addEventListener('click', deleteSelected);
  $('#btn-rotate').addEventListener('click', () => rotateSelected(90));

  $('#btn-reset').addEventListener('click', () => {
    if (!store.pages.length) return;
    if (!confirm('確定要清空所有檔案與頁面嗎？')) return;
    forgetRenderCache();
    resetAll();
    render();
  });

  $('#btn-expand').addEventListener('click', () => {
    setExpandAll(!allExpanded());
    render();
  });

  $('#btn-collapse-selected').addEventListener('click', () => {
    const n = collapseSelectedGroups();
    render();
    toast(n ? `已收合 ${n} 份文件` : '選取的頁面沒有可以收合的文件');
  });

  $('#btn-empty-add').addEventListener('click', () => pickFiles(null));
  $('#btn-load-samples').addEventListener('click', loadSamples);
}

function wireSelectBar() {
  $('#chk-all').addEventListener('change', (e) => {
    const on = e.target.checked;
    for (const p of store.pages) p.selected = on;
    syncSelection();
  });

  $('#btn-view-grid').addEventListener('click', () => { store.layout = 'grid'; render(); });
  $('#btn-view-list').addEventListener('click', () => { store.layout = 'list'; render(); });

  let sizeTimer;
  $('#thumb-size').addEventListener('input', (e) => {
    store.thumbW = Number(e.target.value);
    document.documentElement.style.setProperty('--thumb-w', `${store.thumbW}px`);
    clearTimeout(sizeTimer);
    sizeTimer = setTimeout(render, 180);
  });
}

/**
 * 下拉選單的共同行為：點按鈕開關、點外面關掉、點項目觸發。
 */
function bindMenu(btnSel, menuSel, onAct, onItem) {
  const btn = $(btnSel);
  const menu = $(menuSel);

  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    const open = menu.hidden;
    closeAllMenus();
    menu.hidden = !open;
  });

  menu.addEventListener('click', (e) => {
    const item = e.target.closest('button');
    if (!item) return;
    menu.hidden = true;
    if (onItem) onItem(item);
    else onAct?.(item.dataset.act);
  });
}

function closeAllMenus() {
  for (const m of document.querySelectorAll('.menu')) m.hidden = true;
}
document.addEventListener('click', closeAllMenus);

/* ============================================================
   卡片上的操作
   ============================================================ */

function wireBoard() {
  els.board.addEventListener('click', (e) => {
    /* 「＋」插入點 */
    const gapBtn = e.target.closest('[data-gap-add]');
    if (gapBtn) {
      e.stopPropagation();
      openInsertMenu(gapBtn, Number(gapBtn.parentElement.dataset.index));
      return;
    }

    /* 末端的新增卡 */
    if (e.target.closest('#add-card')) { pickFiles(null); return; }

    /* 檔案檢視的整份操作 */
    const fileAct = e.target.closest('[data-file-act]');
    if (fileAct) {
      const fid = fileAct.closest('.file-row').dataset.fileId;
      const ids = store.pages.filter((p) => p.fileId === fid).map((p) => p.id);
      if (fileAct.dataset.fileAct === 'rotate') {
        commit(() => rotatePages(ids, 90));
      } else if (confirm(`要移除「${store.files.get(fid).name}」的全部 ${ids.length} 頁嗎？`)) {
        commit(() => removePages(ids));
      }
      render();
      return;
    }

    /* 頁面卡片（收合的一疊代表整組頁面） */
    const card = e.target.closest('.card');
    if (!card) return;
    const id = card.dataset.id;
    const ids = card.dataset.ids ? card.dataset.ids.split(',') : [id];
    const act = e.target.closest('[data-act]')?.dataset.act;

    switch (act) {
      case 'select':
        for (const pid of ids) pageById(pid).selected = e.target.checked;
        syncSelection();
        return;
      case 'zoom':     openPreview(indexOfPage(id)); return;
      case 'rotate':   commit(() => rotatePages(ids, 90)); render(); return;
      case 'dup':      commit(() => duplicatePage(id)); render(); toast('已複製一頁'); return;
      case 'del':      commit(() => removePages(ids)); render(); return;
      case 'expand':   setGroupExpanded(id, true); render(); return;
      case 'collapse': setGroupExpanded(id, false); render(); return;
    }

    /* 工具列上的空白處不當作選取 */
    if (e.target.closest('.card-tools')) return;

    /* 收合的一疊：點一下就展開 */
    if (card.classList.contains('is-stack')) {
      setGroupExpanded(id, true);
      render();
      return;
    }

    /* 點卡片本體 = 切換選取；Shift 可以連續選一段 */
    toggleSelect(id, e.shiftKey);
  });

  els.board.addEventListener('dblclick', (e) => {
    const card = e.target.closest('.card');
    if (!card || card.classList.contains('is-split')) return;
    if (card.classList.contains('is-stack')) {
      setGroupExpanded(card.dataset.id, true);
      render();
      return;
    }
    openPreview(indexOfPage(card.dataset.id));
  });
}

/* ============================================================
   框選（按住左鍵拖出一個框，圈到的卡片都會被選取）
   ============================================================ */

function wireMarqueeSelect() {
  let dragging = false;
  let startX = 0;
  let startY = 0;
  let additive = false;
  let baseIds = new Set();

  const isBlankTarget = (target) =>
    !target.closest('.card, .file-row, .gap, #add-card, button, input, a, .menu');

  els.workspace.addEventListener('mousedown', (e) => {
    if (e.button !== 0 || store.view !== 'pages') return;
    if (!isBlankTarget(e.target)) return;

    dragging = true;
    additive = e.shiftKey;
    baseIds = additive ? new Set(selectedPages().map((p) => p.id)) : new Set();
    startX = e.clientX;
    startY = e.clientY;

    if (!additive) {
      for (const p of store.pages) p.selected = false;
    }
    paintMarquee(startX, startY, startX, startY);
    els.marquee.hidden = false;
    e.preventDefault();
  });

  window.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    paintMarquee(startX, startY, e.clientX, e.clientY);

    const x1 = Math.min(startX, e.clientX);
    const x2 = Math.max(startX, e.clientX);
    const y1 = Math.min(startY, e.clientY);
    const y2 = Math.max(startY, e.clientY);

    const inside = new Set(baseIds);
    for (const card of els.board.querySelectorAll('.card')) {
      const r = card.getBoundingClientRect();
      if (r.left >= x2 || r.right <= x1 || r.top >= y2 || r.bottom <= y1) continue;
      const ids = card.dataset.ids ? card.dataset.ids.split(',') : [card.dataset.id];
      for (const id of ids) inside.add(id);
    }
    for (const p of store.pages) p.selected = inside.has(p.id);
    syncSelection();
  });

  window.addEventListener('mouseup', () => {
    if (!dragging) return;
    dragging = false;
    els.marquee.hidden = true;
  });
}

function paintMarquee(x1, y1, x2, y2) {
  els.marquee.style.left = `${Math.min(x1, x2)}px`;
  els.marquee.style.top = `${Math.min(y1, y2)}px`;
  els.marquee.style.width = `${Math.abs(x2 - x1)}px`;
  els.marquee.style.height = `${Math.abs(y2 - y1)}px`;
}

let lastClickedId = null;

function toggleSelect(id, extend) {
  if (extend && lastClickedId) {
    const a = indexOfPage(lastClickedId);
    const b = indexOfPage(id);
    if (a >= 0 && b >= 0) {
      for (let i = Math.min(a, b); i <= Math.max(a, b); i++) store.pages[i].selected = true;
      syncSelection();
      return;
    }
  }
  const p = pageById(id);
  if (p) p.selected = !p.selected;
  lastClickedId = id;
  syncSelection();
}

function deleteSelected() {
  const ids = selectedPages().map((p) => p.id);
  if (!ids.length) return;
  commit(() => removePages(ids));
  render();
  toast(`已刪除 ${ids.length} 頁`);
}

function rotateSelected(delta) {
  const ids = selectedPages().map((p) => p.id);
  if (!ids.length) return;
  commit(() => rotatePages(ids, delta));
  render();
}

/* ---------------- 插入選單 ---------------- */

function openInsertMenu(anchor, index) {
  closeAllMenus();
  const r = anchor.getBoundingClientRect();
  const menu = els.menuInsert;
  menu.hidden = false;
  menu.style.left = `${Math.min(r.left, window.innerWidth - 190)}px`;
  menu.style.top = `${r.bottom + 6}px`;
  menu.dataset.index = String(index);
}

els.menuInsert.addEventListener('click', (e) => {
  const btn = e.target.closest('button');
  if (!btn) return;
  const at = Number(els.menuInsert.dataset.index);
  els.menuInsert.hidden = true;
  if (btn.dataset.act === 'insert-file') pickFiles(at);
  else if (btn.dataset.act === 'insert-split') insertSplit(at);
  else insertBlank(at);
});

/**
 * 空白頁沿用鄰頁的尺寸，接起來才不會大小不一。
 * 往前找不到就往後找，都沒有（例如旁邊只有分割符號）才退回 A4。
 */
function sizeNear(at) {
  const oriented = (p) => (p.rotation % 180 !== 0
    ? { width: p.height, height: p.width }
    : { width: p.width, height: p.height });

  for (let i = at - 1; i >= 0; i--) if (store.pages[i].width) return oriented(store.pages[i]);
  for (let i = at; i < store.pages.length; i++) if (store.pages[i].width) return oriented(store.pages[i]);
  return A4;
}

function insertBlank(at) {
  const size = sizeNear(at);
  commit(() => insertPages(at, [makeBlankPage(size.width, size.height)]));
  render();
  toast('已加入空白頁');
}

function insertSplit(at) {
  commit(() => insertPages(at, [makeSplit()]));
  render();
  toast('已加入分割符號，匯出時會從這裡切成另一個檔案');
}

/**
 * 在每個「來源文件交界」批次插入分割符號或空白頁。
 * @param {'split'|'blank'} kind
 */
function insertBetweenDocuments(kind) {
  const isSeparator = kind === 'split'
    ? (p) => p.kind === 'split'
    : (p) => p.kind === 'blank';

  const spots = documentBoundaries(isSeparator);
  if (!spots.length) {
    toast(kind === 'split' ? '文件之間都已經有分割符號了' : '文件之間都已經有空白頁了');
    return;
  }

  commit(() => {
    // 由後往前插入，前面的索引才不會被往後推
    for (const at of [...spots].reverse()) {
      if (kind === 'split') {
        insertPages(at, [makeSplit()]);
      } else {
        const size = sizeNear(at);
        insertPages(at, [makeBlankPage(size.width, size.height)]);
      }
    }
  });
  render();
  toast(kind === 'split'
    ? `已在 ${spots.length} 處文件交界加入分割符號`
    : `已在 ${spots.length} 處文件交界加入空白頁`);
}

/* ============================================================
   外部檔案拖放
   ============================================================ */

function wireDragAndDrop() {
  let depth = 0;
  const hasFiles = (e) => [...(e.dataTransfer?.types ?? [])].includes('Files');

  window.addEventListener('dragenter', (e) => {
    if (!hasFiles(e) || isDraggingInternally()) return;
    depth++;
    els.dropOverlay.hidden = false;
  });
  window.addEventListener('dragover', (e) => {
    if (!hasFiles(e) || isDraggingInternally()) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  });
  window.addEventListener('dragleave', () => {
    if (--depth <= 0) { depth = 0; els.dropOverlay.hidden = true; }
  });
  window.addEventListener('drop', (e) => {
    depth = 0;
    els.dropOverlay.hidden = true;
    if (!hasFiles(e) || isDraggingInternally()) return;
    if (!e.dataTransfer.files?.length) return;
    e.preventDefault();
    addFiles(e.dataTransfer.files, null);
  });
}

/* ============================================================
   鍵盤
   ============================================================ */

function wireKeyboard() {
  window.addEventListener('keydown', (e) => {
    const typing = /^(INPUT|TEXTAREA)$/.test(e.target.tagName);

    if (e.key === 'Escape') {
      if (!els.preview.hidden) { closePreview(); return; }
      if (!els.downloadModal.hidden) { closeDownloadModal(); return; }
      closeAllMenus();
      for (const p of store.pages) p.selected = false;
      syncSelection();
      return;
    }
    if (typing) return;

    const mod = e.ctrlKey || e.metaKey;

    if (mod && e.key.toLowerCase() === 'z' && !e.shiftKey) { e.preventDefault(); if (undo()) render(); return; }
    if (mod && (e.key.toLowerCase() === 'y' || (e.shiftKey && e.key.toLowerCase() === 'z'))) {
      e.preventDefault(); if (redo()) render(); return;
    }
    if (mod && e.key.toLowerCase() === 'a') {
      e.preventDefault();
      for (const p of store.pages) p.selected = true;
      syncSelection(); return;
    }
    if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); deleteSelected(); return; }
    if (e.key.toLowerCase() === 'r') { rotateSelected(e.shiftKey ? -90 : 90); return; }

    if (!els.preview.hidden) {
      if (e.key === 'ArrowLeft') openPreview(previewIndex - 1);
      if (e.key === 'ArrowRight') openPreview(previewIndex + 1);
    }
  });
}

/* ============================================================
   預覽
   ============================================================ */

function wirePreview() {
  $('#preview-close').addEventListener('click', closePreview);
  $('#preview-prev').addEventListener('click', () => openPreview(previewIndex - 1));
  $('#preview-next').addEventListener('click', () => openPreview(previewIndex + 1));
  $('#preview-rotate').addEventListener('click', () => {
    const p = store.pages[previewIndex];
    if (!p) return;
    commit(() => rotatePages([p.id], 90));
    render();
    openPreview(previewIndex);
  });
  els.preview.addEventListener('click', (e) => {
    if (e.target === els.preview || e.target.classList.contains('modal-body')) closePreview();
  });
}

async function openPreview(index) {
  if (index < 0 || index >= store.pages.length) return;
  previewIndex = index;
  const page = store.pages[index];
  const file = store.files.get(page.fileId);

  els.preview.hidden = false;
  els.previewTitle.textContent =
    `${file ? file.name : '空白頁'} — 第 ${index + 1} / ${store.pages.length} 張` +
    (page.rotation ? `（旋轉 ${page.rotation}°）` : '');

  const maxW = window.innerWidth - 80;
  const maxH = window.innerHeight - 130;
  try {
    await renderToCanvas(page, els.previewCanvas, maxW, maxH);
  } catch {
    toast('這一頁無法預覽', true);
  }
}

function closePreview() {
  els.preview.hidden = true;
  previewIndex = -1;
}

/* ============================================================
   匯出
   ============================================================ */

function wireExport() {
  els.btnDownload.addEventListener('click', openDownloadModal);
  els.btnShare.addEventListener('click', doShare);
  els.shareProgressCancel.addEventListener('click', () => shareController?.abort());
  els.btnCopyLink.addEventListener('click', () => copyShareLinks(false));

  els.dlCancel.addEventListener('click', closeDownloadModal);
  els.downloadModal.addEventListener('click', (e) => {
    if (e.target === els.downloadModal) closeDownloadModal();
  });
  els.dlGo.addEventListener('click', doDownload);
  for (const el of [els.dlTargetValue, els.dlTargetUnit]) {
    el.addEventListener('input', () => { $('input[name="dl-mode"][value="target"]').checked = true; });
  }
}

function shareBusy(text) {
  els.shareProgressText.textContent = text;
  els.shareProgress.hidden = false;
}

function shareUnbusy() {
  els.shareProgress.hidden = true;
}

/** @param {boolean} silent 自動複製時失敗就算了，不用跳錯誤 toast 打擾使用者 */
async function copyShareLinks(silent) {
  if (!lastShareUrls.length) return false;
  try {
    await navigator.clipboard.writeText(lastShareUrls.join('\n'));
    if (!silent) toast('已複製連結');
    return true;
  } catch {
    if (!silent) toast('複製失敗，請手動選取', true);
    return false;
  }
}

/**
 * 依分割符號決定要輸出幾個檔案，以及各自的檔名：單一檔案沿用原檔名，
 * 多個來源檔案時用「merged」，有分割符號時再加上 _1、_2…
 */
function exportPlan() {
  const segments = splitSegments(store.pages);
  const names = fileOrder().map((id) => store.files.get(id).name);
  const base = names[0] ? names[0].replace(/\.[^.]+$/, '') : 'merged';

  if (segments.length <= 1) {
    return [{ name: `${base}.pdf`, pages: segments[0] ?? [] }];
  }
  const width = String(segments.length).length;
  return segments.map((pages, i) => ({
    name: `${base}_${String(i + 1).padStart(width, '0')}.pdf`,
    pages,
  }));
}

/**
 * 把目前的匯出計畫實際組成 PDF 位元組，共用給下載跟分享。
 * pageBuilder 預設是無損的 exportPdf，傳自訂的 (pages, onProgress) => Promise<Uint8Array>
 * 就能換成 exportPdfCompressed 之類的其他做法。
 */
async function buildExportResults(plan, onProgress, pageBuilder = exportPdf) {
  const totalPages = plan.reduce((n, f) => n + f.pages.length, 0);
  let done = 0;
  const results = [];
  for (const f of plan) {
    const bytes = await pageBuilder(f.pages, () => {
      onProgress(`正在建立 PDF… ${++done}/${totalPages} 頁`);
    });
    results.push({ name: f.name, bytes });
  }
  return results;
}

const totalBytesOf = (results) => results.reduce((n, r) => n + r.bytes.length, 0);
const formatBytes = (n) => (n >= 1048576 ? `${(n / 1048576).toFixed(2)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

/** 連續觸發下載中間留一點間隔，瀏覽器才不會把後面的當成彈出視窗擋掉 */
async function downloadAll(results) {
  for (let i = 0; i < results.length; i++) {
    downloadBytes(results[i].bytes, results[i].name);
    if (i < results.length - 1) await new Promise((r) => setTimeout(r, 400));
  }
  toast(results.length === 1
    ? `已匯出 ${results[0].name}`
    : `已匯出 ${results.length} 個檔案：${results[0].name} … ${results.at(-1).name}`);
}

/* ---------------- 下載前選壓縮方式 ---------------- */

function setDlSizeState(el, text, cls) {
  el.textContent = text;
  el.className = `dl-size${cls ? ` ${cls}` : ''}`;
}

function openDownloadModal() {
  const plan = exportPlan().filter((f) => f.pages.length);
  if (!plan.length) { toast('沒有頁面可以匯出', true); return; }

  const token = ++dlToken;
  dlLowResult = null;
  dlHighResult = null;
  setDlSizeState(els.dlSizeLow, '計算中…');
  setDlSizeState(els.dlSizeHigh, '計算中…');
  $('input[name="dl-mode"][value="low"]').checked = true;
  els.downloadModal.hidden = false;

  // 背景同時把「低壓縮」「高壓縮」兩個版本都做出來，選哪個就直接用哪個，不用等
  buildExportResults(plan, () => {}, exportPdf).then((results) => {
    if (token !== dlToken) return;
    dlLowResult = results;
    setDlSizeState(els.dlSizeLow, formatBytes(totalBytesOf(results)), 'is-ready');
  }).catch((err) => {
    if (token !== dlToken) return;
    console.error(err);
    setDlSizeState(els.dlSizeLow, '算失敗', 'is-error');
  });

  buildExportResults(plan, () => {}, (pages, cb) => exportPdfCompressed(pages, HIGH_SETTINGS, cb)).then((results) => {
    if (token !== dlToken) return;
    dlHighResult = results;
    setDlSizeState(els.dlSizeHigh, formatBytes(totalBytesOf(results)), 'is-ready');
  }).catch((err) => {
    if (token !== dlToken) return;
    console.error(err);
    setDlSizeState(els.dlSizeHigh, '算失敗', 'is-error');
  });
}

function closeDownloadModal() {
  dlToken++; // 讓還在背景跑的計算作廢，結果出來也不會再套用
  els.downloadModal.hidden = true;
}

/**
 * 「指定大小」：低壓縮、高壓縮如果本來就有一個達標就直接用；
 * 兩個都不夠小才真的進入「加重壓縮再試一次」的迴圈，依序試更低的 DPI／畫質。
 */
async function resolveTargetDownload(plan, targetBytes) {
  if (dlLowResult && totalBytesOf(dlLowResult) <= targetBytes) return { results: dlLowResult, met: true };
  if (dlHighResult && totalBytesOf(dlHighResult) <= targetBytes) return { results: dlHighResult, met: true };

  let best = dlHighResult;
  let bestBytes = best ? totalBytesOf(best) : Infinity;

  for (const settings of TARGET_STEPS) {
    const results = await buildExportResults(plan, busy, (pages, cb) => exportPdfCompressed(pages, settings, cb));
    const bytes = totalBytesOf(results);
    if (bytes < bestBytes) { best = results; bestBytes = bytes; }
    if (bytes <= targetBytes) return { results, met: true };
  }
  return { results: best, met: false };
}

async function doDownload() {
  const mode = $('input[name="dl-mode"]:checked')?.value ?? 'low';
  const plan = exportPlan().filter((f) => f.pages.length);
  if (!plan.length) { toast('沒有頁面可以匯出', true); return; }

  els.downloadModal.hidden = true;

  if (mode === 'low' || mode === 'high') {
    const cached = mode === 'low' ? dlLowResult : dlHighResult;
    if (cached) { await downloadAll(cached); return; }
    // 保險：萬一背景計算還沒好使用者就按下載，現場等它做完
    busy('正在建立 PDF…');
    try {
      const results = mode === 'low'
        ? await buildExportResults(plan, busy)
        : await buildExportResults(plan, busy, (pages, cb) => exportPdfCompressed(pages, HIGH_SETTINGS, cb));
      await downloadAll(results);
    } catch (err) {
      console.error(err);
      toast(`匯出失敗：${err.message || err}`, true);
    } finally {
      unbusy();
    }
    return;
  }

  // 指定大小
  const value = Number(els.dlTargetValue.value);
  const unitBytes = Number(els.dlTargetUnit.value);
  const targetBytes = value > 0 ? value * unitBytes : 0;
  if (!targetBytes) { toast('請輸入有效的檔案大小', true); return; }

  busy('正在嘗試壓到指定大小以下…');
  try {
    const { results, met } = await resolveTargetDownload(plan, targetBytes);
    await downloadAll(results);
    if (!met) toast(`壓不到指定大小，已下載能壓到最小的版本（${formatBytes(totalBytesOf(results))}）`, true);
  } catch (err) {
    console.error(err);
    toast(`匯出失敗：${err.message || err}`, true);
  } finally {
    unbusy();
  }
}

/* ---------------- 產生分享連結 ---------------- */

async function doShare() {
  const plan = exportPlan().filter((f) => f.pages.length);
  if (!plan.length) { toast('沒有頁面可以匯出', true); return; }

  shareController = new AbortController();
  const { signal } = shareController;

  els.btnShare.disabled = true;
  els.btnDownload.disabled = true;
  shareBusy('正在建立 PDF…');
  try {
    const results = await buildExportResults(plan, shareBusy);

    shareBusy(results.length === 1 ? `正在上傳 ${results[0].name}…` : `正在上傳 ${results.length} 個檔案…`);
    const urls = await shareFiles(results, { signal });

    // 所有檔案是同一個 commit，只要其中一個網址確認上線，
    // 代表這個 commit（也就是全部檔案）都已經部署完成。
    const live = await waitUntilLive(urls[urls.length - 1], (attempt) => {
      shareBusy(`正在等待 PDF 建立完成…（第 ${attempt} 次確認）`);
    }, { signal });
    const timedOut = !live;

    lastShareUrls = urls;
    els.btnCopyLink.disabled = false;
    els.btnCopyLink.title = '';
    const copied = !timedOut && await copyShareLinks(true);

    toast(timedOut
      ? '連結已產生，但部署好像比較久，如果打開是 404 請稍後再試'
      : (copied
        ? (urls.length === 1 ? '連結已複製，貼給 Claude 或其他人' : `已產生並複製 ${urls.length} 個連結`)
        : (urls.length === 1 ? '連結已產生，按「複製連結」貼給 Claude 或其他人' : `已產生 ${urls.length} 個連結`)));
  } catch (err) {
    if (err.name === 'AbortError') {
      toast('已取消');
    } else {
      console.error(err);
      toast(`分享失敗：${err.message || err}`, true);
    }
  } finally {
    shareController = null;
    els.btnShare.disabled = false;
    els.btnDownload.disabled = false;
    shareUnbusy();
  }
}

/* ============================================================
   範例檔
   ============================================================ */

async function loadSamples() {
  const names = ['sample_A.pdf', 'sample_B.pdf', 'sample_C.pdf', 'sample_D.pdf'];
  busy('載入範例檔案…');
  const files = [];
  for (const n of names) {
    try {
      const res = await fetch(`samples/${n}`);
      if (!res.ok) continue;
      files.push(new File([await res.blob()], n, { type: 'application/pdf' }));
    } catch { /* 沒有範例檔就跳過 */ }
  }
  unbusy();
  if (!files.length) {
    toast('找不到範例檔，請先執行 tools/make_samples.py', true);
    return;
  }
  await addFiles(files, null);
  clearHistory();
  render();
}

boot();
