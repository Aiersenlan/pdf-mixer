/* ============================================================
   ui.js — 把 store 畫成畫面
   ------------------------------------------------------------
   採全量重繪：每次狀態變動就重建 board 的 DOM。
   縮圖有快取，所以重繪成本很低，換來的是狀態與畫面永遠一致。
   ============================================================ */

import {
  store, fileOrder, selectedPages, canUndo, canRedo, isSplit, splitSegments,
  pageGroups, groupLeader, isGroupExpanded, allExpanded, hasCollapsibleGroups,
} from './state.js';
import { thumbFor } from './pdfio.js';

const ICON = {
  zoom: '<svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.6-3.6M11 8v6M8 11h6"/></svg>',
  rotate: '<svg viewBox="0 0 24 24"><path d="M21 12a9 9 0 1 1-2.6-6.4"/><path d="M21 3v6h-6"/></svg>',
  dup: '<svg viewBox="0 0 24 24"><rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1"/></svg>',
  del: '<svg viewBox="0 0 24 24"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/></svg>',
  split: '<svg viewBox="0 0 24 24"><circle cx="6" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M20 4 8.1 15.9M14.5 14.5 20 20M8.1 8.1 12 12"/></svg>',
  expand: '<svg viewBox="0 0 24 24"><path d="M9 4H4v5M15 4h5v5M9 20H4v-5M15 20h5v-5"/></svg>',
  collapse: '<svg viewBox="0 0 24 24"><path d="M4 9h5V4M20 9h-5V4M4 15h5v5M20 15h-5v5"/></svg>',
};

const $ = (sel) => document.querySelector(sel);
const board = $('#board');
const emptyState = $('#empty-state');

const THUMB_RATIO = 1.32;
/** 清單檢視的縮圖框固定小尺寸，必須和 style.css 的 .view-list .thumb 一致 */
const LIST_BOX = { w: 40, h: 53 };

/** 目前排版下，縮圖框的實際像素大小 */
const thumbBox = () =>
  (store.view === 'pages' && store.layout === 'list')
    ? LIST_BOX
    : { w: store.thumbW, h: store.thumbW * THUMB_RATIO };

/* ------------------------------------------------------------
   主入口
   ------------------------------------------------------------ */

export function render() {
  document.documentElement.style.setProperty('--thumb-w', `${store.thumbW}px`);

  const hasPages = store.pages.length > 0;
  emptyState.hidden = hasPages;
  board.hidden = !hasPages;

  board.className = 'board';
  if (store.view === 'files') board.classList.add('view-files');
  else if (store.layout === 'list') board.classList.add('view-list');

  board.replaceChildren();
  if (!hasPages) { syncChrome(); return; }

  if (store.view === 'files') renderFileRows();
  else renderPageCards();

  syncChrome();
}

/* ------------------------------------------------------------
   頁面檢視
   ------------------------------------------------------------ */

function renderPageCards() {
  const grid = store.layout === 'grid';
  const frag = document.createDocumentFragment();

  let pageNo = 0;        // 第幾張（不含分割符號）
  let doneSegments = 0;  // 已經結束的段落數
  let inSegment = 0;     // 目前段落累積的頁數

  for (const g of pageGroups()) {
    if (grid) frag.appendChild(makeGap(g.start));

    if (g.type === 'split') {
      if (inSegment > 0) { doneSegments++; inSegment = 0; }
      frag.appendChild(makeSplitCard(g.item, doneSegments + 1, g.start));
      continue;
    }

    inSegment += g.pages.length;

    if (isGroupExpanded(g)) {
      const collapsible = g.pages.length > 1;
      g.pages.forEach((page, k) => {
        if (grid && k > 0) frag.appendChild(makeGap(g.start + k));
        frag.appendChild(makeCard(page, g.start + k, ++pageNo, collapsible && k === 0));
      });
    } else {
      pageNo += g.pages.length;
      frag.appendChild(makeStackCard(g));
    }
  }

  if (grid) {
    frag.appendChild(makeGap(store.pages.length));
    frag.appendChild(makeAddCard());
  }
  board.appendChild(frag);
}

/** 收合狀態的一疊：後面墊幾層白紙，最多五層 */
function makeStackCard(g) {
  const file = store.files.get(g.fileId);
  const count = g.pages.length;
  const allSelected = g.pages.every((p) => p.selected);

  const card = document.createElement('div');
  card.className = 'card is-stack' + (allSelected ? ' is-selected' : '');
  card.dataset.id = groupLeader(g);
  card.dataset.ids = g.pages.map((p) => p.id).join(',');
  card.dataset.index = String(g.start);
  card.dataset.end = String(g.start + count);
  card.draggable = true;
  card.title = `${file ? file.name : '空白頁'}（${count} 頁）— 點一下展開`;

  const tools = document.createElement('div');
  tools.className = 'card-tools';
  tools.innerHTML = `
    <input type="checkbox" data-act="select" ${allSelected ? 'checked' : ''} title="選取整份">
    <span class="spacer"></span>
    <button class="t" data-act="expand" title="展開這份文件">${ICON.expand}</button>
    <button class="t" data-act="zoom"   title="預覽第一頁">${ICON.zoom}</button>
    <button class="t" data-act="rotate" title="整份向右旋轉 90°">${ICON.rotate}</button>
    <button class="t danger" data-act="del" title="移除這 ${count} 頁">${ICON.del}</button>`;

  const stack = document.createElement('div');
  stack.className = 'stack';
  for (let i = Math.min(count, 5) - 1; i >= 1; i--) {
    const layer = document.createElement('span');
    layer.className = 'layer';
    layer.style.transform = `translate(${i * 4}px, ${i * -4}px)`;
    layer.style.opacity = String(1 - i * 0.13);
    stack.appendChild(layer);
  }

  const thumb = document.createElement('div');
  thumb.className = 'thumb';
  thumb.innerHTML = '<span class="placeholder"></span>';
  attachThumb(thumb, g.pages[0]);
  stack.appendChild(thumb);

  const foot = document.createElement('div');
  foot.className = 'card-foot';
  const chip = document.createElement('span');
  chip.className = 'file-chip';
  chip.textContent = file ? file.name : '空白頁';
  chip.title = chip.textContent;
  if (file) {
    chip.style.background = file.color.chipBg;
    chip.style.color = file.color.chipFg;
  }
  const no = document.createElement('span');
  no.className = 'page-no';
  no.textContent = `${count} 頁`;
  foot.append(chip, no);

  card.append(tools, stack, foot);
  return card;
}

/** 分割符號的卡片：一條虛線加一把剪刀，比頁面卡片窄很多 */
function makeSplitCard(item, segmentNo, index) {
  const card = document.createElement('div');
  card.className = 'card is-split' + (item.selected ? ' is-selected' : '');
  card.dataset.id = item.id;
  card.dataset.index = String(index);
  card.dataset.end = String(index + 1);
  card.draggable = true;
  card.innerHTML = `
    <div class="card-tools">
      <input type="checkbox" data-act="select" ${item.selected ? 'checked' : ''} title="選取">
      <span class="spacer"></span>
      <button class="t danger" data-act="del" title="移除分割符號">${ICON.del}</button>
    </div>
    <div class="split-body"><span class="split-badge">${ICON.split}</span></div>
    <div class="card-foot">
      <span class="file-chip split-chip">分割</span>
      <span class="page-no">第 ${segmentNo} 份</span>
    </div>`;
  return card;
}

function makeGap(index) {
  const gap = document.createElement('div');
  gap.className = 'gap';
  gap.dataset.index = String(index);
  gap.innerHTML = '<button type="button" title="在這裡插入" data-gap-add><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg></button>';
  return gap;
}

function makeCard(page, index, pageNo, collapsible = false) {
  const file = store.files.get(page.fileId);
  const card = document.createElement('div');
  card.className = 'card' + (page.selected ? ' is-selected' : '');
  card.dataset.id = page.id;
  card.dataset.index = String(index);
  card.dataset.end = String(index + 1);
  card.draggable = true;

  /* 懸停工具列 */
  const tools = document.createElement('div');
  tools.className = 'card-tools';
  tools.innerHTML = `
    <input type="checkbox" data-act="select" ${page.selected ? 'checked' : ''} title="選取">
    <span class="spacer"></span>
    ${collapsible ? `<button class="t" data-act="collapse" title="收合這份文件">${ICON.collapse}</button>` : ''}
    <button class="t" data-act="zoom"   title="放大檢視（也可以在卡片上點兩下）">${ICON.zoom}</button>
    <button class="t" data-act="rotate" title="向右旋轉 90°">${ICON.rotate}</button>
    <button class="t" data-act="dup"    title="複製這一頁">${ICON.dup}</button>
    <button class="t danger" data-act="del" title="刪除這一頁">${ICON.del}</button>`;

  /* 縮圖 */
  const thumb = document.createElement('div');
  thumb.className = 'thumb';
  if (page.kind === 'blank') {
    card.classList.add('is-blank');
    thumb.appendChild(blankSheet(page));
  } else {
    thumb.innerHTML = '<span class="placeholder"></span>';
    attachThumb(thumb, page);
  }

  /* 頁尾 */
  const foot = document.createElement('div');
  foot.className = 'card-foot';
  const chip = document.createElement('span');
  chip.className = 'file-chip';
  chip.textContent = file ? file.name : '空白頁';
  chip.title = chip.textContent;
  if (file) {
    chip.style.background = file.color.chipBg;
    chip.style.color = file.color.chipFg;
  } else {
    chip.style.background = '#3a3a3a';
    chip.style.color = '#c8ccd0';
  }
  const no = document.createElement('span');
  no.className = 'page-no';
  no.textContent = page.kind === 'blank' ? `第 ${pageNo} 張` : String(page.srcIndex + 1);
  foot.append(chip, no);

  card.append(tools, thumb, foot);
  return card;
}

/** 空白頁按實際紙張比例畫一張白紙，才看得出是直式還是橫式 */
function blankSheet(page) {
  const swap = page.rotation % 180 !== 0;
  const w = swap ? page.height : page.width;
  const h = swap ? page.width : page.height;
  const box = thumbBox();
  const pad = box.w > 60 ? 12 : 4;
  const s = Math.min((box.w - pad) / w, (box.h - pad) / h);

  const el = document.createElement('div');
  el.className = 'blank-sheet';
  el.style.width = `${Math.round(w * s)}px`;
  el.style.height = `${Math.round(h * s)}px`;
  el.innerHTML = '<span>空白頁</span>';
  return el;
}

function makeAddCard() {
  const el = document.createElement('div');
  el.className = 'add-card';
  el.id = 'add-card';
  el.innerHTML = '<div><svg class="plus" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg><span class="txt">新增 PDF、JPG、<br>PNG、WebP 檔案</span></div>';
  return el;
}

/** 非同步把縮圖塞進卡片，並套用旋轉 */
async function attachThumb(thumbEl, page) {
  try {
    const url = await thumbFor(page, store.thumbW);
    if (!url || !thumbEl.isConnected) return;
    const img = new Image();
    img.decoding = 'async';
    img.alt = '';
    // 圖片預設是可拖曳的，會蓋掉卡片的拖曳並把自己塞進 dataTransfer，
    // 於是放開時又被當成「使用者拖入一張圖片」而多出一頁
    img.draggable = false;
    img.src = url;
    img.onload = () => {
      if (!thumbEl.isConnected) return;
      thumbEl.replaceChildren(img);
      applyRotation(img, page.rotation);
    };
  } catch {
    if (thumbEl.isConnected) thumbEl.innerHTML = '<span class="blank-mark">無法預覽</span>';
  }
}

/**
 * 旋轉 90/270 時圖片的長寬要換邊，才不會被縮圖框裁掉。
 */
function applyRotation(img, rotation) {
  const { w: boxW, h: boxH } = thumbBox();
  const swap = rotation % 180 !== 0;
  img.style.maxWidth = `${swap ? boxH : boxW}px`;
  img.style.maxHeight = `${swap ? boxW : boxH}px`;
  img.style.transform = `translate(-50%, -50%) rotate(${rotation}deg)`;
}

/* ------------------------------------------------------------
   檔案檢視
   ------------------------------------------------------------ */

function renderFileRows() {
  const frag = document.createDocumentFragment();

  for (const fid of fileOrder()) {
    const file = store.files.get(fid);
    const pages = store.pages.filter((p) => p.fileId === fid);
    const row = document.createElement('div');
    row.className = 'file-row';
    row.dataset.fileId = fid;
    row.draggable = true;

    const swatch = document.createElement('div');
    swatch.className = 'swatch';
    swatch.style.background = file.color.solid;

    const thumb = document.createElement('div');
    thumb.className = 'fr-thumb';
    if (pages[0]) {
      thumbFor(pages[0], 40).then((url) => {
        if (url && thumb.isConnected) {
          thumb.style.background = `#fff url("${url}") center/contain no-repeat`;
        }
      }).catch(() => {});
    }

    const meta = document.createElement('div');
    meta.innerHTML = `<div class="fr-name"></div>
      <div class="fr-meta">${pages.length} 頁${
        pages.length !== file.pageCount ? `（原始 ${file.pageCount} 頁）` : ''
      } · ${formatSize(file.bytes.length)}</div>`;
    meta.querySelector('.fr-name').textContent = file.name;

    const actions = document.createElement('div');
    actions.className = 'fr-actions';
    actions.innerHTML = `
      <button class="t tool-btn icon-only" data-file-act="rotate" title="整份旋轉">${ICON.rotate}</button>
      <button class="t tool-btn icon-only" data-file-act="del" title="移除整份檔案">${ICON.del}</button>`;

    row.append(swatch, thumb, meta, actions);
    frag.appendChild(row);
  }
  board.appendChild(frag);
}

const formatSize = (n) =>
  n > 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`;

/**
 * 只更新選取狀態，不重建 DOM。
 *
 * 選取切換如果走整頁重繪，第二次點擊會落在新建的節點上，
 * 瀏覽器就不會發出 dblclick——雙擊預覽會整個失效。
 */
export function syncSelection() {
  const byId = new Map(store.pages.map((p) => [p.id, p]));

  for (const card of board.querySelectorAll('.card')) {
    const ids = card.dataset.ids ? card.dataset.ids.split(',') : [card.dataset.id];
    const on = ids.every((id) => byId.get(id)?.selected);
    card.classList.toggle('is-selected', on);
    const box = card.querySelector('input[data-act="select"]');
    if (box) box.checked = on;
  }
  syncChrome();
}

/* ------------------------------------------------------------
   工具列狀態同步
   ------------------------------------------------------------ */

function syncChrome() {
  const sel = selectedPages().length;
  const total = store.pages.length;
  const pageCount = store.pages.filter((p) => !isSplit(p)).length;
  const segments = splitSegments().length;

  $('#sel-count').textContent = total
    ? (sel
        ? `已選取 ${sel} 項`
        : `共 ${pageCount} 頁${segments > 1 ? ` · 匯出成 ${segments} 個檔案` : ''}`)
    : '';

  const all = $('#chk-all');
  all.checked = total > 0 && sel === total;
  all.indeterminate = sel > 0 && sel < total;

  $('#btn-undo').disabled = !canUndo();
  $('#btn-redo').disabled = !canRedo();
  $('#btn-delete').disabled = sel === 0;
  $('#btn-rotate').disabled = sel === 0;
  $('#btn-download').disabled = pageCount === 0;
  $('#btn-share').disabled = pageCount === 0;

  for (const tab of document.querySelectorAll('.tab')) {
    tab.classList.toggle('is-active', tab.dataset.view === store.view);
  }
  const expandBtn = $('#btn-expand');
  const open = allExpanded();
  expandBtn.disabled = !hasCollapsibleGroups() || store.view === 'files';
  expandBtn.querySelector('.label').textContent = open ? '全部收合' : '全部展開';
  expandBtn.querySelector('.ico').innerHTML = open ? ICON.collapse : ICON.expand;
  expandBtn.title = open ? '把每份文件收成一疊' : '展開所有文件的頁面';

  $('#btn-view-grid').classList.toggle('is-active', store.layout === 'grid');
  $('#btn-view-list').classList.toggle('is-active', store.layout === 'list');
  const inFiles = store.view === 'files';
  $('#btn-view-grid').disabled = inFiles;
  $('#btn-view-list').disabled = inFiles;
}

/* ------------------------------------------------------------
   小工具：提示訊息 / 忙碌遮罩
   ------------------------------------------------------------ */

let toastTimer;
export function toast(msg, isError = false) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.toggle('error', isError);
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, isError ? 4200 : 2200);
}

export function busy(text) {
  $('#busy-text').textContent = text ?? '處理中…';
  $('#busy').hidden = false;
}
export function unbusy() { $('#busy').hidden = true; }
