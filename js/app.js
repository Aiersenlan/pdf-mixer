/* ============================================================
   app.js — 事件接線與流程控制
   ============================================================ */

import {
  store, commit, undo, redo, clearHistory, resetAll,
  selectedPages, pageById, indexOfPage, fileOrder,
  makeBlankPage, makeSplit, insertPages, removePages, duplicatePage,
  rotatePages, movePages, reorderByFiles, sortPages,
  splitSegments, documentBoundaries, realPages,
  setGroupExpanded, setExpandAll, allExpanded,
} from './state.js';

import {
  loadFile, exportPdf, downloadBytes, renderToCanvas, forgetRenderCache, A4,
} from './pdfio.js';

import { render, syncSelection, toast, busy, unbusy } from './ui.js';
import { initDnd, isDraggingInternally } from './dnd.js';

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
  exportModal: $('#export-modal'),
  exportName: $('#export-name'),
  exportInfo: $('#export-info'),
  exportFiles: $('#export-files'),
};

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

  $('#btn-done').addEventListener('click', openExport);
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
      if (!els.exportModal.hidden) { els.exportModal.hidden = true; return; }
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
  $('#export-cancel').addEventListener('click', () => { els.exportModal.hidden = true; });
  $('#export-go').addEventListener('click', doExport);
  els.exportName.addEventListener('input', renderExportList);
  els.exportModal.addEventListener('click', (e) => {
    if (e.target === els.exportModal) els.exportModal.hidden = true;
  });
}

/**
 * 依分割符號決定要輸出幾個檔案，以及各自的檔名。
 * 只有一段時就用使用者輸入的名字，多段時自動加上 _1、_2…
 */
function exportPlan() {
  const segments = splitSegments(store.pages);
  const base = els.exportName.value.trim().replace(/\.pdf$/i, '') || 'merged';

  if (segments.length <= 1) {
    return [{ name: `${base}.pdf`, pages: segments[0] ?? [] }];
  }
  const width = String(segments.length).length;
  return segments.map((pages, i) => ({
    name: `${base}_${String(i + 1).padStart(width, '0')}.pdf`,
    pages,
  }));
}

function renderExportList() {
  const plan = exportPlan();
  if (plan.length <= 1) { els.exportFiles.hidden = true; return; }

  els.exportFiles.replaceChildren(...plan.map((f) => {
    const li = document.createElement('li');
    const name = document.createElement('span');
    name.textContent = f.name;
    const count = document.createElement('span');
    count.textContent = `${f.pages.length} 頁`;
    li.append(name, count);
    return li;
  }));
  els.exportFiles.hidden = false;
}

function openExport() {
  const pageCount = realPages().length;
  if (!pageCount) return;

  const names = fileOrder().map((id) => store.files.get(id).name);
  const segments = splitSegments(store.pages);
  const base = names.length === 1 ? names[0].replace(/\.[^.]+$/, '') : 'merged';

  els.exportName.value = `${base}.pdf`;
  els.exportInfo.textContent = segments.length > 1
    ? `共 ${pageCount} 頁，依 ${segments.length - 1} 個分割符號輸出成 ${segments.length} 個 PDF。`
      + '瀏覽器可能會詢問是否允許一次下載多個檔案。'
    : `共 ${pageCount} 頁，來自 ${names.length} 個檔案。整份 PDF 在你的瀏覽器內組成，不會上傳。`;

  renderExportList();
  els.exportModal.hidden = false;
  els.exportName.focus();
  els.exportName.setSelectionRange(0, els.exportName.value.replace(/\.pdf$/i, '').length);
}

async function doExport() {
  const plan = exportPlan().filter((f) => f.pages.length);
  if (!plan.length) return;
  els.exportModal.hidden = true;

  busy('正在產生 PDF…');
  try {
    const totalPages = plan.reduce((n, f) => n + f.pages.length, 0);
    let done = 0;
    const results = [];

    for (const f of plan) {
      const bytes = await exportPdf(f.pages, () => {
        busy(`正在產生 PDF… ${++done}/${totalPages} 頁`);
      });
      results.push({ name: f.name, bytes });
    }

    // 連續觸發下載中間留一點間隔，瀏覽器才不會把後面的當成彈出視窗擋掉
    for (let i = 0; i < results.length; i++) {
      downloadBytes(results[i].bytes, results[i].name);
      if (i < results.length - 1) await new Promise((r) => setTimeout(r, 400));
    }

    toast(results.length === 1
      ? `已匯出 ${results[0].name}`
      : `已匯出 ${results.length} 個檔案：${results[0].name} … ${results.at(-1).name}`);
  } catch (err) {
    console.error(err);
    toast(`匯出失敗：${err.message || err}`, true);
  } finally {
    unbusy();
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
