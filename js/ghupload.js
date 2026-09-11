/* ============================================================
   ghupload.js — 把匯出的 PDF 透過 GitHub REST API 推送到使用者
   自己指定的 repo，換一個可以直接分享／貼給 Claude 的公開連結。

   Token 只從這個瀏覽器直接打 https://api.github.com，
   不會經過任何其他伺服器，也不會寫死在程式碼裡。
   ============================================================ */

const API = 'https://api.github.com';

/** 大檔案不能直接 String.fromCharCode(...bytes)，call stack 會爆，分段處理。 */
function toBase64(bytes) {
  const chunkSize = 0x8000;
  let binary = '';
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

async function gh(path, token, options = {}) {
  const res = await fetch(`${API}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    let msg = `${res.status} ${res.statusText}`;
    try {
      const j = JSON.parse(body);
      if (j.message) msg = j.message;
    } catch { /* 不是 JSON 就用預設訊息 */ }
    throw new Error(msg);
  }
  return res.status === 204 ? null : res.json();
}

/**
 * 用 Git Data API（blob → tree → commit → ref）新增/更新一個檔案。
 * 不像 Contents API 單次請求受限在 1MB，這條路徑對一般大小的 PDF 都沒問題。
 */
export async function uploadFileToGitHub({ owner, repo, branch, path, token, bytes, message }) {
  if (!owner || !repo || !token) throw new Error('請填齊 GitHub 帳號、repo 與 token');
  const base = `/repos/${owner}/${repo}`;
  const cleanPath = path.replace(/^\/+/, '');

  const ref = await gh(`${base}/git/ref/heads/${encodeURIComponent(branch)}`, token);
  const commitSha = ref.object.sha;
  const baseCommit = await gh(`${base}/git/commits/${commitSha}`, token);

  const blob = await gh(`${base}/git/blobs`, token, {
    method: 'POST',
    body: JSON.stringify({ content: toBase64(bytes), encoding: 'base64' }),
  });

  const tree = await gh(`${base}/git/trees`, token, {
    method: 'POST',
    body: JSON.stringify({
      base_tree: baseCommit.tree.sha,
      tree: [{ path: cleanPath, mode: '100644', type: 'blob', sha: blob.sha }],
    }),
  });

  const newCommit = await gh(`${base}/git/commits`, token, {
    method: 'POST',
    body: JSON.stringify({ message, tree: tree.sha, parents: [commitSha] }),
  });

  await gh(`${base}/git/refs/heads/${encodeURIComponent(branch)}`, token, {
    method: 'PATCH',
    body: JSON.stringify({ sha: newCommit.sha }),
  });

  return newCommit.sha;
}

/**
 * 猜出 GitHub Pages 會把這個檔案服務在哪個網址。
 * `<owner>.github.io` 這種使用者站點是服務在根目錄，其他 repo 會多一層 `/repo/`。
 */
export function pagesUrlFor({ owner, repo, path }) {
  const cleanPath = path.replace(/^\/+/, '');
  if (repo.toLowerCase() === `${owner.toLowerCase()}.github.io`) {
    return `https://${owner}.github.io/${cleanPath}`;
  }
  return `https://${owner}.github.io/${repo}/${cleanPath}`;
}
