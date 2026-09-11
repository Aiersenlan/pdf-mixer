# 分享連結 Worker — 部署步驟

這個 Worker 是「完成」匯出視窗裡「產生分享連結」功能的後端。它把你的
GitHub token 放在 Cloudflare 這一端，前端完全不用填任何帳號或 token，
點一下就能拿到公開連結。全程只需要瀏覽器，不用裝 Node、不用裝 wrangler。

## 0. 準備一個「分享用」的 repo

建議跟 `pdf-mixer` 這個工具本身的 repo 分開，避免每次分享都在工具的 repo
裡多一個 commit：

1. 到 <https://github.com/new> 建一個新的 public repo，例如 `pdf-share`
   （不用勾 README / .gitignore，留空即可）
2. 進這個新 repo 的 **Settings → Pages**：Source 選 `Deploy from a branch`，
   Branch 選 `main`、資料夾選 `/ (root)`，Save
3. 記下 repo 網址對應的 GitHub Pages 網址，通常是
   `https://<你的帳號>.github.io/pdf-share/`

## 1. 建一個 fine-grained Personal Access Token

到 GitHub **Settings → Developer settings → Personal access tokens →
Fine-grained tokens → Generate new token**：

- Repository access：選「Only select repositories」，只勾剛剛那個分享用 repo
- Permissions：只開 **Contents → Read and write**，其他都不要動
- 存好這個 token，下一步要貼到 Cloudflare（**不要貼到別的地方，包括貼給我**）

## 2. 在 Cloudflare 建立 Worker

1. 到 <https://dash.cloudflare.com/> 註冊／登入（免費帳號即可）
2. 左側選單 **Workers & Pages → Create → Create Worker**，取個名字
   （例如 `pdf-mixer-share`），Deploy 一次產生預設內容
3. 進這個 Worker 的頁面，點 **Edit code**（Quick Edit），把整個編輯器裡的內容
   換成同目錄下 [`worker.js`](worker.js) 的內容，右上角 **Deploy**
4. 部署完成後，Worker 頁面上方會顯示一個網址，長得像：
   `https://pdf-mixer-share.<你的子網域>.workers.dev`
   把這個網址記下來，最後一步要用

## 3. 設定環境變數與 Secret

回到 Worker 的 **Settings → Variables and Secrets**：

| 名稱 | 類型 | 值 |
| --- | --- | --- |
| `GITHUB_TOKEN` | **Secret**（一定要選 Secret，不要選 Text） | 步驟 1 產生的 token |
| `GITHUB_OWNER` | Text | 你的 GitHub 帳號，例如 `Aiersenlan` |
| `GITHUB_REPO` | Text | 步驟 0 建的 repo 名稱，例如 `pdf-share` |
| `GITHUB_BRANCH` | Text | `main` |
| `GITHUB_FOLDER` | Text | `shared`（可留空，代表放在 repo 根目錄） |
| `ALLOWED_ORIGIN` | Text | `https://aiersenlan.github.io`（限制只有這個網站能呼叫這個 Worker） |

存檔後 Worker 會自動重新部署一次。

## 4. 把 Worker 網址接回前端

把步驟 2 拿到的網址告訴我（或自己編輯
[`../js/ghupload.js`](../js/ghupload.js) 裡的 `SHARE_ENDPOINT` 常數），
換上你實際部署出來的網址，存檔、`git push` 上去就完成了。

## 之後要注意的事

- **這個 repo 是公開的**：任何人拿到分享連結都能打開，不會過期、不會加密。
  不要拿來放機密或客戶資料。
- **這個 Worker 沒有身分驗證，也沒有嚴格的流量限制**：只要有人知道它的網址
  就能一直呼叫（`ALLOWED_ORIGIN` 只擋一般瀏覽器的 CORS，擋不住用程式直接打）。
  如果之後發現被濫用，去 Cloudflare 的 Worker 設定裡可以直接暫停它，
  或到 GitHub 上把那個 fine-grained token 撤銷掉。
- **分享用的 repo 會一直長大**：每次分享都是一次新的 commit，Git 歷史不會自動
  清掉舊檔案。如果之後想清乾淨，直接在 GitHub 上重建這個 repo 最簡單。
