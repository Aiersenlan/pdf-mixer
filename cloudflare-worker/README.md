# 分享連結 Worker — 部署步驟

這個 Worker 是「完成」匯出視窗裡「產生分享連結」功能的後端。它把你的
GitHub token 放在 Cloudflare 這一端，前端完全不用填任何帳號或 token，
點一下就能拿到公開連結。全程只需要瀏覽器，不用裝 Node、不用裝 wrangler。

## 0. 分享用的 repo

這裡直接沿用 `pdf-mixer` 這個工具本身的 repo（已經開好 GitHub Pages，
不用再另外建），分享的 PDF 會放進 `shared/` 資料夾，
網址長得像 `https://aiersenlan.github.io/pdf-mixer/shared/xxxxx-檔名.pdf`。

> 這個選擇的取捨：token 的權限範圍會涵蓋工具本身的原始碼，
> 而且如果你之後手動 `git push` 程式碼跟有人按分享的時間點剛好卡在一起，
> Worker 那次寫入偶爾會失敗（GitHub 會拒絕過期的 commit ref，重新分享一次就好）。
> 都是已經評估過、可以接受的取捨，不是預設推薦的設定。

## 1. 建一個 fine-grained Personal Access Token

到 GitHub **Settings → Developer settings → Personal access tokens →
Fine-grained tokens → Generate new token**：

- Repository access：選「Only select repositories」，只勾 `pdf-mixer`
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
| `GITHUB_OWNER` | Text | `Aiersenlan` |
| `GITHUB_REPO` | Text | `pdf-mixer` |
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
- **`pdf-mixer` 這個 repo 會因為分享功能一直長大**：每次分享都是一次新的
  commit，Git 歷史不會自動清掉舊檔案，之後 `git clone` 這個工具的原始碼
  也會連同歷史上所有分享過的 PDF 一起抓下來。如果之後想清乾淨，
  可以把 `shared/` 資料夾裡的舊檔案整批刪掉重新 commit（歷史紀錄本身還是會留著，
  真的要徹底清掉需要改寫 git history）。
