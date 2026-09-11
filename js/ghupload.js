/* ============================================================
   ghupload.js — 把匯出的 PDF 送到 Cloudflare Worker，換一個
   可以直接分享／貼給 Claude 的公開連結。

   Worker 那一端才有 GitHub token，這裡完全不需要帳號或任何設定，
   使用者只要按一個勾選框就能用。部署方式見 cloudflare-worker/README.md。
   ============================================================ */

const SHARE_ENDPOINT = 'https://dric-pdf-mixer.aiersen-ke.workers.dev/';

/**
 * @param {Uint8Array} bytes
 * @param {string} filename
 * @returns {Promise<string>} 分享連結
 */
export async function shareFile(bytes, filename) {
  const res = await fetch(SHARE_ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/pdf',
      'X-Filename': filename,
    },
    body: bytes,
  });

  let json;
  try {
    json = await res.json();
  } catch {
    throw new Error(`分享失敗（${res.status}）`);
  }
  if (!res.ok || json.error) throw new Error(json.error || `分享失敗（${res.status}）`);
  return json.url;
}

/**
 * 分享連結是先 commit 到 GitHub，GitHub Pages 重新建置完成前開了會 404。
 * 用輪詢等它真的上線，而不是丟一個還沒生效的連結給使用者。
 * @param {string} url
 * @param {(attempt: number) => void} [onWaiting] 每次還沒好時呼叫，回報第幾次嘗試
 * @returns {Promise<boolean>} 是否在時間內確認上線
 */
export async function waitUntilLive(url, onWaiting) {
  const timeoutMs = 90_000;
  const intervalMs = 3_000;
  const deadline = Date.now() + timeoutMs;
  let attempt = 0;

  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { method: 'HEAD', cache: 'no-store' });
      if (res.ok) return true;
    } catch {
      /* 網路暫時失敗，當作還沒好，繼續等 */
    }
    attempt += 1;
    onWaiting?.(attempt);
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return false;
}
