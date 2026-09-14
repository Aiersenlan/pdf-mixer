/* ============================================================
   pdfio.js — 檔案讀取、縮圖產生、PDF 匯出
   ------------------------------------------------------------
   讀取與縮圖 : pdf.js   (vendor/pdf.min.js)
   組合與輸出 : pdf-lib  (vendor/pdf-lib.min.js)
   全程在瀏覽器記憶體內完成，不會有任何網路傳輸。
   ============================================================ */

import { store, uid, nextColor, nextSeq } from './state.js';

const pdfjsLib = window.pdfjsLib;
pdfjsLib.GlobalWorkerOptions.workerSrc = 'vendor/pdf.worker.min.js';

/** fileId -> pdf.js PDFDocumentProxy（僅供畫縮圖／預覽） */
const renderDocs = new Map();
/** 縮圖快取： `${fileId}:${srcIndex}:${bucket}` -> dataURL */
const thumbCache = new Map();

export const A4 = { width: 595.28, height: 841.89 };

/* ------------------------------------------------------------
   讀檔
   ------------------------------------------------------------ */

const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/bmp'];

/**
 * 讀入一個 File，登記到 store.files，並回傳對應的頁面陣列（尚未插入）。
 * @param {File} file
 * @returns {Promise<any[]>}
 */
export async function loadFile(file) {
  const isPdf = file.type === 'application/pdf' || /\.pdf$/i.test(file.name);
  const isImg = IMAGE_TYPES.includes(file.type) || /\.(png|jpe?g|webp|gif|bmp)$/i.test(file.name);

  if (isPdf) return loadPdfFile(file);
  if (isImg) return loadImageFile(file);
  throw new Error(`不支援的檔案類型：${file.name}`);
}

async function loadPdfFile(file) {
  const bytes = new Uint8Array(await file.arrayBuffer());

  // pdf.js 會把傳進去的 buffer 轉移到 worker，所以一定要給它副本
  let doc;
  try {
    doc = await pdfjsLib.getDocument({ data: bytes.slice(), isEvalSupported: false }).promise;
  } catch (err) {
    if (err?.name === 'PasswordException') throw new Error(`${file.name} 有密碼保護，無法開啟`);
    throw new Error(`${file.name} 不是有效的 PDF`);
  }

  const entry = {
    id: uid('f'), name: file.name, kind: 'pdf', mime: 'application/pdf',
    bytes, color: nextColor(), pageCount: doc.numPages, addedAt: Date.now(),
  };
  store.files.set(entry.id, entry);
  renderDocs.set(entry.id, doc);

  const pages = [];
  for (let i = 0; i < doc.numPages; i++) {
    const vp = (await doc.getPage(i + 1)).getViewport({ scale: 1 });
    pages.push({
      id: uid('p'), kind: 'pdf', fileId: entry.id, srcIndex: i,
      rotation: 0, selected: false,
      width: vp.width, height: vp.height,
      seq: nextSeq(),
    });
  }
  return pages;
}

async function loadImageFile(file) {
  // 一律轉成 PNG：pdf-lib 只吃 PNG / JPEG，這樣 webp、gif、bmp 也能用
  const { bytes, width, height } = await imageToPng(file);

  const entry = {
    id: uid('f'), name: file.name, kind: 'image', mime: 'image/png',
    bytes, color: nextColor(), pageCount: 1, addedAt: Date.now(),
  };
  store.files.set(entry.id, entry);

  return [{
    id: uid('p'), kind: 'image', fileId: entry.id, srcIndex: 0,
    rotation: 0, selected: false, width, height, seq: nextSeq(),
  }];
}

async function imageToPng(file) {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = () => reject(new Error(`無法讀取圖片：${file.name}`));
      el.src = url;
    });
    // 太大的圖降尺寸，避免匯出檔案爆炸
    const MAX = 3000;
    const scale = Math.min(1, MAX / Math.max(img.naturalWidth, img.naturalHeight));
    const w = Math.round(img.naturalWidth * scale);
    const h = Math.round(img.naturalHeight * scale);

    const canvas = Object.assign(document.createElement('canvas'), { width: w, height: h });
    canvas.getContext('2d').drawImage(img, 0, 0, w, h);
    const blob = await new Promise((r) => canvas.toBlob(r, 'image/png'));
    return { bytes: new Uint8Array(await blob.arrayBuffer()), width: w, height: h };
  } finally {
    URL.revokeObjectURL(url);
  }
}

/* ------------------------------------------------------------
   縮圖
   ------------------------------------------------------------ */

let inFlight = 0;
const queue = [];
const MAX_PARALLEL = 4;

function schedule(job) {
  return new Promise((resolve, reject) => {
    queue.push({ job, resolve, reject });
    pump();
  });
}

function pump() {
  while (inFlight < MAX_PARALLEL && queue.length) {
    const { job, resolve, reject } = queue.shift();
    inFlight++;
    job().then(resolve, reject).finally(() => { inFlight--; pump(); });
  }
}

/**
 * 取得一張頁面的縮圖 dataURL；blank 頁回傳 null。
 * @param {any} page
 * @param {number} targetW 目標 CSS 寬度
 */
export async function thumbFor(page, targetW) {
  if (page.kind === 'blank') return null;

  const bucket = Math.ceil(targetW / 40) * 40;          // 分級快取，避免每拉一格就重畫
  const key = `${page.fileId}:${page.srcIndex}:${bucket}`;
  if (thumbCache.has(key)) return thumbCache.get(key);

  const promise = schedule(() => renderThumb(page, bucket));
  thumbCache.set(key, promise);
  try {
    const url = await promise;
    thumbCache.set(key, url);
    return url;
  } catch (err) {
    thumbCache.delete(key);
    throw err;
  }
}

async function renderThumb(page, bucketW) {
  const entry = store.files.get(page.fileId);
  if (!entry) return null;

  if (entry.kind === 'image') {
    const blob = new Blob([entry.bytes], { type: 'image/png' });
    return URL.createObjectURL(blob);
  }

  const doc = renderDocs.get(page.fileId);
  const pdfPage = await doc.getPage(page.srcIndex + 1);
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const base = pdfPage.getViewport({ scale: 1 });
  const viewport = pdfPage.getViewport({ scale: (bucketW * dpr * 1.15) / base.width });

  const canvas = Object.assign(document.createElement('canvas'), {
    width: Math.ceil(viewport.width),
    height: Math.ceil(viewport.height),
  });
  const ctx = canvas.getContext('2d', { alpha: false });
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  await pdfPage.render({ canvasContext: ctx, viewport }).promise;
  return canvas.toDataURL('image/jpeg', 0.85);
}

/**
 * pdf.js 的 render() 畫到沒掛進 DOM 的 canvas 時，分頁背景／沒有焦點的狀態下
 * 偶爾會整個卡住不 resolve。暫時把 canvas 掛到畫面外（不影響版面），畫完再拔掉。
 * @returns {() => void} 呼叫這個把 canvas 從 DOM 移除
 */
function attachOffscreen(canvas) {
  canvas.style.position = 'fixed';
  canvas.style.left = '-99999px';
  canvas.style.top = '0';
  document.body.appendChild(canvas);
  return () => canvas.remove();
}

/** 大圖預覽（不走快取，直接畫到指定 canvas） */
export async function renderToCanvas(page, canvas, maxW, maxH) {
  const ctx = canvas.getContext('2d');
  const entry = store.files.get(page.fileId);

  if (page.kind === 'blank' || !entry) {
    const rot = page.rotation % 180 !== 0;
    const w = rot ? page.height : page.width;
    const h = rot ? page.width : page.height;
    const s = Math.min(maxW / w, maxH / h);
    canvas.width = Math.round(w * s);
    canvas.height = Math.round(h * s);
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    return;
  }

  if (entry.kind === 'image') {
    const blob = new Blob([entry.bytes], { type: 'image/png' });
    const bmp = await createImageBitmap(blob);
    drawRotated(canvas, bmp, bmp.width, bmp.height, page.rotation, maxW, maxH);
    bmp.close?.();
    return;
  }

  const doc = renderDocs.get(page.fileId);
  const pdfPage = await doc.getPage(page.srcIndex + 1);
  // pdf.js 的 viewport 可以直接吃旋轉角度，交給它處理最準
  const base = pdfPage.getViewport({ scale: 1, rotation: (pdfPage.rotate + page.rotation) % 360 });
  const scale = Math.min(maxW / base.width, maxH / base.height);
  const viewport = pdfPage.getViewport({
    scale, rotation: (pdfPage.rotate + page.rotation) % 360,
  });
  canvas.width = Math.ceil(viewport.width);
  canvas.height = Math.ceil(viewport.height);
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  await pdfPage.render({ canvasContext: ctx, viewport }).promise;
}

function drawRotated(canvas, src, w, h, rotation, maxW, maxH) {
  const swap = rotation % 180 !== 0;
  const outW = swap ? h : w;
  const outH = swap ? w : h;
  const s = Math.min(maxW / outW, maxH / outH, 1.5);
  canvas.width = Math.round(outW * s);
  canvas.height = Math.round(outH * s);
  const ctx = canvas.getContext('2d');
  ctx.save();
  ctx.translate(canvas.width / 2, canvas.height / 2);
  ctx.rotate((rotation * Math.PI) / 180);
  ctx.drawImage(src, (-w * s) / 2, (-h * s) / 2, w * s, h * s);
  ctx.restore();
}

/* ------------------------------------------------------------
   匯出
   ------------------------------------------------------------ */

/**
 * 把一組頁面組成一份新的 PDF。
 * @param {any[]} [pages] 要輸出的頁面，預設是整份 store.pages（會自動略過分割符號）
 * @param {(done:number, total:number) => void} [onProgress]
 * @returns {Promise<Uint8Array>}
 */
export async function exportPdf(pages = store.pages, onProgress) {
  const { PDFDocument, degrees } = window.PDFLib;
  const out = await PDFDocument.create();
  const srcDocs = new Map();
  const embedded = new Map();
  pages = pages.filter((p) => p.kind !== 'split');

  for (let i = 0; i < pages.length; i++) {
    const p = pages[i];

    if (p.kind === 'pdf') {
      let src = srcDocs.get(p.fileId);
      if (!src) {
        src = await PDFDocument.load(store.files.get(p.fileId).bytes, { ignoreEncryption: true });
        srcDocs.set(p.fileId, src);
      }
      const [copied] = await out.copyPages(src, [p.srcIndex]);
      if (p.rotation) {
        copied.setRotation(degrees((copied.getRotation().angle + p.rotation) % 360));
      }
      out.addPage(copied);

    } else if (p.kind === 'image') {
      let img = embedded.get(p.fileId);
      if (!img) {
        img = await out.embedPng(store.files.get(p.fileId).bytes);
        embedded.set(p.fileId, img);
      }
      // MediaBox 用圖片原尺寸，旋轉交給 /Rotate，閱讀器會自己換邊顯示
      const page = out.addPage([img.width, img.height]);
      page.drawImage(img, { x: 0, y: 0, width: img.width, height: img.height });
      if (p.rotation) page.setRotation(degrees(p.rotation));

    } else {
      const page = out.addPage([p.width, p.height]);
      if (p.rotation) page.setRotation(degrees(p.rotation));
    }

    onProgress?.(i + 1, pages.length);
    if (i % 8 === 7) await new Promise((r) => setTimeout(r));  // 讓 UI 有機會更新
  }

  return out.save({ useObjectStreams: true });
}

/**
 * 把一頁畫成指定 DPI／畫質的 JPEG。純前端沒有真正的 PDF 壓縮引擎，
 * 唯一能有感縮小檔案的方法就是整頁轉成圖片——代價是文字不能再反白/搜尋。
 * 輸出頁面尺寸（點）刻意跟原始頁面一樣，只是內容變成點陣圖，物理大小不變。
 * @returns {Promise<{bytes: Uint8Array, outW: number, outH: number} | null>} blank 頁回傳 null
 */
async function rasterizePage(page, dpi, quality, pdfjsDoc) {
  if (page.kind === 'blank') return null;

  const entry = store.files.get(page.fileId);
  const swap = page.rotation % 180 !== 0;
  const outW = swap ? page.height : page.width;   // 輸出頁面尺寸（點），跟原始頁面一致
  const outH = swap ? page.width : page.height;
  const scale = dpi / 72;

  const canvas = document.createElement('canvas');
  const detach = attachOffscreen(canvas);
  try {
    const ctx = canvas.getContext('2d', { alpha: false });

    if (entry.kind === 'image') {
      const blob = new Blob([entry.bytes], { type: 'image/png' });
      const bmp = await createImageBitmap(blob);
      // 圖片本來的像素密度如果比目標 DPI 低，就不要硬放大
      const cap = Math.max(bmp.width / page.width, bmp.height / page.height);
      const useScale = Math.min(scale, cap > 0 ? cap : scale);
      canvas.width = Math.max(1, Math.round(outW * useScale));
      canvas.height = Math.max(1, Math.round(outH * useScale));
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.save();
      ctx.translate(canvas.width / 2, canvas.height / 2);
      ctx.rotate((page.rotation * Math.PI) / 180);
      const drawW = swap ? canvas.height : canvas.width;
      const drawH = swap ? canvas.width : canvas.height;
      ctx.drawImage(bmp, -drawW / 2, -drawH / 2, drawW, drawH);
      ctx.restore();
      bmp.close?.();
    } else {
      // 刻意不共用縮圖用的 renderDocs：跟縮圖系統搶同一份 PDFPageProxy 的渲染佇列，
      // 在分頁背景/沒有焦點時很容易卡住不 resolve，獨立載入一份才穩定。
      const pdfPage = await pdfjsDoc.getPage(page.srcIndex + 1);
      const viewport = pdfPage.getViewport({ scale, rotation: (pdfPage.rotate + page.rotation) % 360 });
      canvas.width = Math.ceil(viewport.width);
      canvas.height = Math.ceil(viewport.height);
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      await pdfPage.render({ canvasContext: ctx, viewport }).promise;
    }

    const blob = await new Promise((r) => canvas.toBlob(r, 'image/jpeg', quality));
    return { bytes: new Uint8Array(await blob.arrayBuffer()), outW, outH };
  } finally {
    detach();
  }
}

/**
 * 跟 exportPdf 做一樣的事，但每一頁都先轉成 JPEG 再嵌回去（空白頁除外）。
 * @param {any[]} [pages]
 * @param {{dpi: number, quality: number}} settings dpi 影響解析度、quality 是 JPEG 品質 0~1
 * @param {(done:number, total:number) => void} [onProgress]
 * @returns {Promise<Uint8Array>}
 */
export async function exportPdfCompressed(pages = store.pages, settings, onProgress) {
  const { PDFDocument, degrees } = window.PDFLib;
  const out = await PDFDocument.create();
  pages = pages.filter((p) => p.kind !== 'split');
  // 每份來源 PDF 獨立載入一次（不跟縮圖共用），同一份檔案的多頁共用同一個文件實例
  const freshDocs = new Map();

  for (let i = 0; i < pages.length; i++) {
    const p = pages[i];

    if (p.kind === 'blank') {
      const page = out.addPage([p.width, p.height]);
      if (p.rotation) page.setRotation(degrees(p.rotation));
    } else {
      let pdfjsDoc = null;
      if (p.kind === 'pdf') {
        pdfjsDoc = freshDocs.get(p.fileId);
        if (!pdfjsDoc) {
          const bytes = store.files.get(p.fileId).bytes;
          pdfjsDoc = await pdfjsLib.getDocument({ data: bytes.slice(), isEvalSupported: false }).promise;
          freshDocs.set(p.fileId, pdfjsDoc);
        }
      }
      const shot = await rasterizePage(p, settings.dpi, settings.quality, pdfjsDoc);
      const img = await out.embedJpg(shot.bytes);
      const page = out.addPage([shot.outW, shot.outH]);
      page.drawImage(img, { x: 0, y: 0, width: shot.outW, height: shot.outH });
    }

    onProgress?.(i + 1, pages.length);
    if (i % 3 === 2) await new Promise((r) => setTimeout(r));  // 讓 UI 有機會更新，畫布運算比較重
  }

  for (const doc of freshDocs.values()) doc.destroy?.();
  return out.save({ useObjectStreams: true });
}

export function downloadBytes(bytes, filename) {
  const blob = new Blob([bytes], { type: 'application/pdf' });
  const url = URL.createObjectURL(blob);
  const a = Object.assign(document.createElement('a'), { href: url, download: filename });
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

export function forgetRenderCache() {
  for (const doc of renderDocs.values()) doc.destroy?.();
  renderDocs.clear();
  thumbCache.clear();
}
