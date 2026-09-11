/**
 * pdf-mixer 的「分享連結」proxy。
 *
 * 前端把匯出的 PDF（可能不只一份，例如切成好幾個檔案）以 JSON 送過來，
 * 這裡用只存在 Cloudflare 這一端的 GitHub token，一次 commit 把全部檔案
 * 推到指定 repo，回傳每個檔案對應的 GitHub Pages 網址。
 * Token 永遠不會出現在瀏覽器、原始碼或任何回應裡。
 *
 * 一次 commit 塞完所有檔案，而不是每個檔案各自 commit，是為了：
 *   - 只觸發一次 GitHub Pages 重新建置，而不是 N 次
 *   - 多個檔案不會互搶同一個 git ref（原本各自 commit 時偶爾會撞車）
 *   - 呼叫端只需要對其中一個網址做「等部署完成」的輪詢，其餘網址跟著同一個
 *     commit 一起上線
 *
 * 部署方式見同目錄下的 README.md。
 */

const MAX_TOTAL_BYTES = 25 * 1024 * 1024; // 25MB，超過就拒絕，避免被拿來塞大檔案濫用
const MAX_FILES = 30; // 一次分享的檔案數上限，避免離譜的濫用

function corsHeaders(origin, allowedOrigin) {
  return {
    'Access-Control-Allow-Origin': origin === allowedOrigin ? origin : allowedOrigin,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
}

/** 只留字母、數字、點、底線、減號，避免路徑穿越或寫到奇怪的地方 */
function safeFilename(name) {
  const base = (name || 'shared.pdf').split(/[\\/]/).pop().slice(0, 120);
  const cleaned = base.replace(/[^A-Za-z0-9._-]/g, '_').replace(/^\.+/, '') || 'shared.pdf';
  return cleaned.toLowerCase().endsWith('.pdf') ? cleaned : `${cleaned}.pdf`;
}

/** base64 字串解碼後的位元組數，用來檢查總大小，不用真的解碼出來 */
function base64ByteLength(b64) {
  const len = b64.length;
  const padding = b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0;
  return Math.floor((len * 3) / 4) - padding;
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

/**
 * 用 Git Data API（blob → tree → commit → ref）一次新增多個檔案。
 * 每個檔案各自的 blob 建立可以平行做（互不影響），
 * 但 tree → commit → ref 一定要照順序，才是「一次 commit」。
 * @param {{filename: string, content: string}[]} items content 是 base64
 * @returns {Promise<string[]>} 依輸入順序回傳每個檔案最終的路徑
 */
async function pushFiles(env, items) {
  const base = `/repos/${env.GITHUB_OWNER}/${env.GITHUB_REPO}`;
  const folder = (env.GITHUB_FOLDER || '').replace(/^\/+|\/+$/g, '');
  const stamp = Date.now().toString(36); // 避免不同次分享互相覆蓋
  const paths = items.map((it) => (folder ? `${folder}/${stamp}-${it.filename}` : `${stamp}-${it.filename}`));

  const [ref, blobs] = await Promise.all([
    gh(env, `${base}/git/ref/heads/${env.GITHUB_BRANCH}`),
    Promise.all(items.map((it) => gh(env, `${base}/git/blobs`, {
      method: 'POST',
      body: JSON.stringify({ content: it.content, encoding: 'base64' }),
    }))),
  ]);
  const commitSha = ref.object.sha;
  const baseCommit = await gh(env, `${base}/git/commits/${commitSha}`);

  const tree = await gh(env, `${base}/git/trees`, {
    method: 'POST',
    body: JSON.stringify({
      base_tree: baseCommit.tree.sha,
      tree: paths.map((path, i) => ({ path, mode: '100644', type: 'blob', sha: blobs[i].sha })),
    }),
  });

  const newCommit = await gh(env, `${base}/git/commits`, {
    method: 'POST',
    body: JSON.stringify({
      message: items.length === 1 ? `分享：新增 ${paths[0]}` : `分享：新增 ${items.length} 個檔案`,
      tree: tree.sha,
      parents: [commitSha],
    }),
  });

  await gh(env, `${base}/git/refs/heads/${env.GITHUB_BRANCH}`, {
    method: 'PATCH',
    body: JSON.stringify({ sha: newCommit.sha }),
  });

  return paths;
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
      const body = await request.json();
      const files = Array.isArray(body?.files) ? body.files : [];
      if (!files.length) throw new Error('沒有收到檔案內容');
      if (files.length > MAX_FILES) throw new Error(`一次最多分享 ${MAX_FILES} 個檔案`);

      let totalBytes = 0;
      const items = files.map((f) => {
        if (typeof f.content !== 'string' || !f.content) throw new Error('檔案內容格式錯誤');
        totalBytes += base64ByteLength(f.content);
        return { filename: safeFilename(f.filename), content: f.content };
      });
      if (totalBytes > MAX_TOTAL_BYTES) {
        throw new Error(`檔案太大（上限 ${Math.floor(MAX_TOTAL_BYTES / 1024 / 1024)}MB）`);
      }

      const paths = await pushFiles(env, items);
      const urls = paths.map((path) => pagesUrl(env, path));

      return new Response(JSON.stringify({ urls }), {
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
