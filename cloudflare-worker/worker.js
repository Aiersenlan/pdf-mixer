/**
 * pdf-mixer 的「分享連結」proxy。
 *
 * 前端把匯出的 PDF 原始位元組直接 POST 過來，這裡用只存在 Cloudflare
 * 這一端的 GitHub token 把檔案推到指定 repo，回傳對應的 GitHub Pages 網址。
 * Token 永遠不會出現在瀏覽器、原始碼或任何回應裡。
 *
 * 部署方式見同目錄下的 README.md。
 */

const MAX_BYTES = 25 * 1024 * 1024; // 25MB，超過就拒絕，避免被拿來塞大檔案濫用

function corsHeaders(origin, allowedOrigin) {
  return {
    'Access-Control-Allow-Origin': origin === allowedOrigin ? origin : allowedOrigin,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-Filename',
  };
}

/** 只留字母、數字、點、底線、減號，避免路徑穿越或寫到奇怪的地方 */
function safeFilename(name) {
  const base = (name || 'shared.pdf').split(/[\\/]/).pop().slice(0, 120);
  const cleaned = base.replace(/[^A-Za-z0-9._-]/g, '_').replace(/^\.+/, '') || 'shared.pdf';
  return cleaned.toLowerCase().endsWith('.pdf') ? cleaned : `${cleaned}.pdf`;
}

/** 大檔案不能直接 String.fromCharCode(...bytes)，call stack 會爆，分段處理 */
function toBase64(bytes) {
  const chunkSize = 0x8000;
  let binary = '';
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

async function gh(env, path, options = {}) {
  const res = await fetch(`https://api.github.com${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${env.GITHUB_TOKEN}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'pdf-mixer-share-worker',
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`GitHub API ${res.status}: ${body.slice(0, 300)}`);
  }
  return res.status === 204 ? null : res.json();
}

/** 用 Git Data API（blob → tree → commit → ref）新增一個檔案，不受 Contents API 1MB 限制 */
async function pushFile(env, path, bytes) {
  const base = `/repos/${env.GITHUB_OWNER}/${env.GITHUB_REPO}`;

  const ref = await gh(env, `${base}/git/ref/heads/${env.GITHUB_BRANCH}`);
  const commitSha = ref.object.sha;
  const baseCommit = await gh(env, `${base}/git/commits/${commitSha}`);

  const blob = await gh(env, `${base}/git/blobs`, {
    method: 'POST',
    body: JSON.stringify({ content: toBase64(bytes), encoding: 'base64' }),
  });

  const tree = await gh(env, `${base}/git/trees`, {
    method: 'POST',
    body: JSON.stringify({
      base_tree: baseCommit.tree.sha,
      tree: [{ path, mode: '100644', type: 'blob', sha: blob.sha }],
    }),
  });

  const newCommit = await gh(env, `${base}/git/commits`, {
    method: 'POST',
    body: JSON.stringify({ message: `分享：新增 ${path}`, tree: tree.sha, parents: [commitSha] }),
  });

  await gh(env, `${base}/git/refs/heads/${env.GITHUB_BRANCH}`, {
    method: 'PATCH',
    body: JSON.stringify({ sha: newCommit.sha }),
  });
}

/** `<owner>.github.io` 這種使用者站點服務在根目錄，其他 repo 會多一層 `/repo/` */
function pagesUrl(env, path) {
  if (env.GITHUB_REPO.toLowerCase() === `${env.GITHUB_OWNER.toLowerCase()}.github.io`) {
    return `https://${env.GITHUB_OWNER}.github.io/${path}`;
  }
  return `https://${env.GITHUB_OWNER}.github.io/${env.GITHUB_REPO}/${path}`;
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';
    const headers = corsHeaders(origin, env.ALLOWED_ORIGIN);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers });
    }
    if (request.method !== 'POST') {
      return new Response('Method not allowed', { status: 405, headers });
    }

    try {
      const buf = await request.arrayBuffer();
      if (buf.byteLength === 0) throw new Error('沒有收到檔案內容');
      if (buf.byteLength > MAX_BYTES) throw new Error('檔案太大（上限 25MB）');

      const filename = safeFilename(request.headers.get('X-Filename'));
      const folder = (env.GITHUB_FOLDER || '').replace(/^\/+|\/+$/g, '');
      // 時間戳前綴避免不同人上傳同名檔案時互相覆蓋
      const stamp = Date.now().toString(36);
      const path = folder ? `${folder}/${stamp}-${filename}` : `${stamp}-${filename}`;

      await pushFile(env, path, new Uint8Array(buf));

      return new Response(JSON.stringify({ url: pagesUrl(env, path) }), {
        status: 200,
        headers: { ...headers, 'Content-Type': 'application/json' },
      });
    } catch (err) {
      return new Response(JSON.stringify({ error: String((err && err.message) || err) }), {
        status: 500,
        headers: { ...headers, 'Content-Type': 'application/json' },
      });
    }
  },
};
