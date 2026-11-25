# 本地静态服务器：在 my_avatar 文件夹上开 http://localhost:8765/ ，打开后自动载入 ../vtuber_art.psd
# 用法：powershell -ExecutionPolicy Bypass -File serve.ps1
param([int]$Port = 8765)
$root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$mime = @{ '.html' = 'text/html; charset=utf-8'; '.js' = 'text/javascript; charset=utf-8'; '.css' = 'text/css; charset=utf-8';
  '.json' = 'application/json'; '.png' = 'image/png'; '.wav' = 'audio/wav'; '.mp3' = 'audio/mpeg'; '.mp4' = 'video/mp4'; '.psd' = 'application/octet-stream' }
$l = [System.Net.HttpListener]::new()
$l.Prefixes.Add("http://localhost:$Port/")
$l.Start()
Write-Host "serving $root at http://localhost:$Port/avatar_generator/"
while ($l.IsListening) {
  $c = $l.GetContext()
  try {
    $rel = [Uri]::UnescapeDataString($c.Request.Url.AbsolutePath).TrimStart('/')
    if ($rel -eq '') { $c.Response.Redirect('/avatar_generator/'); $c.Response.Close(); continue }
    if ($rel.EndsWith('/')) { $rel += 'index.html' }
    $full = [IO.Path]::GetFullPath((Join-Path $root $rel))
    if (-not $full.StartsWith($root) -or -not (Test-Path $full -PathType Leaf)) { $c.Response.StatusCode = 404; $c.Response.Close(); continue }
    $bytes = [IO.File]::ReadAllBytes($full)
    $ext = [IO.Path]::GetExtension($full).ToLower()
    $c.Response.ContentType = if ($mime[$ext]) { $mime[$ext] } else { 'application/octet-stream' }
    $c.Response.Headers.Add('Cache-Control', 'no-store')
    $c.Response.ContentLength64 = $bytes.Length
    $c.Response.OutputStream.Write($bytes, 0, $bytes.Length)
  } catch { } finally { $c.Response.Close() }
}
