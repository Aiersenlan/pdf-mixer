# 純 PowerShell 的本機靜態伺服器 —— 給沒有安裝 Python 的電腦用。
# Windows 10/11 內建 PowerShell 5.1 即可執行，不需要另外安裝任何東西。
#
#   powershell -ExecutionPolicy Bypass -File serve.ps1        # 預設 http://localhost:9321
#   powershell -ExecutionPolicy Bypass -File serve.ps1 -Port 9500

param(
    [int]$Port = 9321
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path

$mime = @{
    '.html' = 'text/html; charset=utf-8'
    '.htm'  = 'text/html; charset=utf-8'
    '.js'   = 'text/javascript; charset=utf-8'
    '.mjs'  = 'text/javascript; charset=utf-8'
    '.css'  = 'text/css; charset=utf-8'
    '.json' = 'application/json'
    '.pdf'  = 'application/pdf'
    '.png'  = 'image/png'
    '.jpg'  = 'image/jpeg'
    '.jpeg' = 'image/jpeg'
    '.webp' = 'image/webp'
    '.gif'  = 'image/gif'
    '.bmp'  = 'image/bmp'
    '.svg'  = 'image/svg+xml'
    '.ico'  = 'image/x-icon'
}

# 依序嘗試連接埠，跟 serve.py 的行為一致：被占用就往後找下一個。
$listener = $null
for ($i = 0; $i -lt 20; $i++) {
    $candidate = $Port + $i
    $listener = New-Object System.Net.HttpListener
    $listener.Prefixes.Add("http://localhost:$candidate/")
    try {
        $listener.Start()
        $Port = $candidate
        break
    } catch {
        Write-Host "連接埠 $candidate 被占用，改試 $($candidate + 1)…"
        $listener = $null
    }
}
if (-not $listener) {
    throw "找不到可用的連接埠。"
}

$url = "http://localhost:$Port"
Write-Host "PDF 頁面編輯器已啟動： $url"
Write-Host "按 Ctrl+C 結束。`n"
Start-Process $url | Out-Null

try {
    while ($listener.IsListening) {
        $context = $listener.GetContext()
        $request = $context.Request
        $response = $context.Response
        # 單執行緒逐一處理，所以每次回應完就關閉連線，
        # 避免瀏覽器的 keep-alive 卡住下一個請求（等同 serve.py 用多執行緒解決的問題）。
        $response.KeepAlive = $false

        try {
            $relPath = [Uri]::UnescapeDataString($request.Url.AbsolutePath)
            if ($relPath -eq '/' -or $relPath -eq '') { $relPath = '/index.html' }
            $full = [System.IO.Path]::GetFullPath((Join-Path $root $relPath.TrimStart('/')))

            if ((-not $full.StartsWith($root, [StringComparison]::OrdinalIgnoreCase)) -or -not (Test-Path -LiteralPath $full -PathType Leaf)) {
                $response.StatusCode = 404
                $bytes = [Text.Encoding]::UTF8.GetBytes('404 Not Found')
                $response.ContentLength64 = $bytes.Length
                $response.OutputStream.Write($bytes, 0, $bytes.Length)
            } else {
                $ext = [System.IO.Path]::GetExtension($full).ToLowerInvariant()
                $ctype = $mime[$ext]
                if (-not $ctype) { $ctype = 'application/octet-stream' }
                $response.ContentType = $ctype
                $response.Headers.Add('Cache-Control', 'no-store')
                $bytes = [System.IO.File]::ReadAllBytes($full)
                $response.ContentLength64 = $bytes.Length
                $response.OutputStream.Write($bytes, 0, $bytes.Length)
            }
        } catch {
            try {
                $response.StatusCode = 500
            } catch {}
        } finally {
            $response.OutputStream.Close()
        }
    }
} finally {
    $listener.Stop()
    $listener.Close()
}
