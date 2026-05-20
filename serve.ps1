# Servidor local — estáticos + proxy /api/media con Range (FLAC grandes)
$port = 8080
$root = $PSScriptRoot
$workerOrigin = 'https://api-musica.a-cambon.workers.dev'

$listener = New-Object System.Net.HttpListener
$listener.Prefixes.Add("http://127.0.0.1:${port}/")
$listener.Start()

Write-Host ""
Write-Host "  Ale Music Box" -ForegroundColor Cyan
Write-Host "  http://127.0.0.1:${port}/" -ForegroundColor Green
Write-Host "  Proxy: /api/media (con Range) | /api/library" -ForegroundColor DarkGray
Write-Host "  Pulsa Ctrl+C para detener." -ForegroundColor DarkGray
Write-Host ""

$mimes = @{
  '.html' = 'text/html; charset=utf-8'
  '.css'  = 'text/css; charset=utf-8'
  '.js'   = 'application/javascript; charset=utf-8'
  '.json' = 'application/json; charset=utf-8'
  '.jpg'  = 'image/jpeg'
  '.jpeg' = 'image/jpeg'
  '.png'  = 'image/png'
  '.webp' = 'image/webp'
  '.flac' = 'audio/flac'
  '.mp3'  = 'audio/mpeg'
}

function Send-Bytes($response, [byte[]]$bytes, [int]$status, [string]$contentType) {
  $response.StatusCode = $status
  $response.ContentType = $contentType
  $response.ContentLength64 = $bytes.Length
  $response.AddHeader('Access-Control-Allow-Origin', '*')
  $response.OutputStream.Write($bytes, 0, $bytes.Length)
}

function Proxy-WorkerStream($request, $response, [string]$workerPath) {
  $account = $request.QueryString['account']
  $file = $request.QueryString['file']
  if (-not $account -or -not $file) {
    Send-Bytes $response ([Text.Encoding]::UTF8.GetBytes('Faltan account o file')) 400 'text/plain; charset=utf-8'
    return
  }

  $q = "account=$([uri]::EscapeDataString($account))&file=$([uri]::EscapeDataString($file))"
  $url = "$workerOrigin/$workerPath`?$q"

  try {
    $http = [System.Net.HttpWebRequest]::Create($url)
    $http.Method = $request.HttpMethod
    $http.UserAgent = 'AleMusicBox-LocalProxy/1.0'
    $http.AllowAutoRedirect = $true
    $http.Timeout = 300000

    $rangeHeader = $request.Headers['Range']
    if ($rangeHeader -match 'bytes=(\d+)-(\d*)') {
      $from = [int64]$Matches[1]
      $toPart = $Matches[2]
      if ($toPart -ne '') {
        $http.AddRange($from, [int64]$toPart)
      } else {
        $http.AddRange($from)
      }
    }

    $remote = $http.GetResponse()
    $response.StatusCode = [int]$remote.StatusCode
    $response.AddHeader('Access-Control-Allow-Origin', '*')

    $contentLen = $remote.Headers['Content-Length']
    if ($contentLen) {
      $response.ContentLength64 = [int64]$contentLen
    }

    $passHeaders = @('Content-Type', 'Content-Range', 'Accept-Ranges')
    foreach ($h in $passHeaders) {
      $val = $remote.Headers[$h]
      if ($val) { $response.AddHeader($h, $val) }
    }

    $ct = $remote.Headers['Content-Type']
    if ($ct) {
      $response.ContentType = $ct
    } elseif (-not $response.ContentType) {
      $ext = [IO.Path]::GetExtension($file).ToLower()
      if ($mimes[$ext]) { $response.ContentType = $mimes[$ext] }
    }

    $in = $remote.GetResponseStream()
    $out = $response.OutputStream
    $buf = New-Object byte[] 65536
    try {
      while (($n = $in.Read($buf, 0, $buf.Length)) -gt 0) {
        try {
          $out.Write($buf, 0, $n)
        } catch {
          break
        }
      }
    } finally {
      $in.Close()
      $remote.Close()
    }
  } catch [System.Net.WebException] {
    $status = 502
    $body = $_.Exception.Message
    if ($_.Exception.Response) {
      $status = [int]$_.Exception.Response.StatusCode
      try {
        $sr = New-Object System.IO.StreamReader($_.Exception.Response.GetResponseStream())
        $body = $sr.ReadToEnd()
        $sr.Close()
      } catch { }
    }
    Send-Bytes $response ([Text.Encoding]::UTF8.GetBytes("Proxy error ($status): $body")) $status 'text/plain; charset=utf-8'
  }
}

try {
  while ($listener.IsListening) {
    $context = $listener.GetContext()
    $request = $context.Request
    $response = $context.Response
    $path = [System.Uri]::UnescapeDataString($request.Url.LocalPath)

    if ($path -eq '/api/media' -or $path.StartsWith('/api/media/')) {
      Proxy-WorkerStream $request $response 'get-song'
      $response.Close()
      continue
    }

    if ($path -eq '/api/library') {
      $account = $request.QueryString['account']
      if (-not $account) { $account = '1' }
      $url = "$workerOrigin/list-library?account=$([uri]::EscapeDataString($account))"
      try {
        $wc = New-Object System.Net.WebClient
        $json = $wc.DownloadString($url)
        Send-Bytes $response ([Text.Encoding]::UTF8.GetBytes($json)) 200 'application/json; charset=utf-8'
      } catch {
        $msg = [Text.Encoding]::UTF8.GetBytes("Proxy library: $($_.Exception.Message)")
        Send-Bytes $response $msg 502 'text/plain; charset=utf-8'
      }
      $response.Close()
      continue
    }

    if ($path -eq '/') { $path = '/index.html' }
    $relative = $path.TrimStart('/').Replace('/', [IO.Path]::DirectorySeparatorChar)
    $filePath = Join-Path $root $relative

    if (Test-Path -LiteralPath $filePath -PathType Leaf) {
      $ext = [IO.Path]::GetExtension($filePath).ToLower()
      $bytes = [IO.File]::ReadAllBytes($filePath)
      $ct = $mimes[$ext]
      if (-not $ct) { $ct = 'application/octet-stream' }
      Send-Bytes $response $bytes 200 $ct
    } else {
      Send-Bytes $response ([Text.Encoding]::UTF8.GetBytes('404')) 404 'text/plain; charset=utf-8'
    }
    $response.Close()
  }
} finally {
  try {
    if ($listener.IsListening) { $listener.Stop() }
  } catch { }
  try { $listener.Close() } catch { }
}
