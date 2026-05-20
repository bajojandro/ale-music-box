# Genera entradas para MUSIC_LIBRARY en app.js desde carpetas locales (nombres EXACTOS de B2)
# Uso: .\sync-library.ps1 -Root "D:\Musica\alemusic-1" -Account 1
param(
  [Parameter(Mandatory = $true)]
  [string]$Root,
  [string]$Account = '1'
)

$audioExt = @('.flac', '.mp3', '.m4a', '.aac', '.ogg', '.wav')

function Get-DisplayTitle([string]$filename) {
  $name = [IO.Path]::GetFileNameWithoutExtension($filename)
  if ($name -match '^\d+\.-\s*(.+)$') { return $matches[1].Trim() }
  return $name.Trim()
}

Write-Host ""
Write-Host "Copia cada bloque en MUSIC_LIBRARY (app.js):" -ForegroundColor Cyan
Write-Host ""

Get-ChildItem -LiteralPath $Root -Directory | Sort-Object Name | ForEach-Object {
  $folder = $_.Name
  $parts = $folder -split ' - ', 2
  $artist = if ($parts.Length -ge 2) { $parts[0] } else { 'Artista' }
  $album = if ($parts.Length -ge 2) { $parts[1] } else { $folder }

  $tracks = Get-ChildItem -LiteralPath $_.FullName -File |
    Where-Object { $audioExt -contains $_.Extension.ToLower() } |
    Sort-Object { [int]($_.BaseName -replace '^(\d+).*', '$1') }, Name

  if ($tracks.Count -eq 0) { return }

  Write-Host "  // --- $folder ---" -ForegroundColor DarkGray
  Write-Host "  {"
  Write-Host "    account: '$Account',"
  Write-Host "    artist: '$($artist -replace "'", "\'")',"
  Write-Host "    album: '$($album -replace "'", "\'")',"
  Write-Host "    folder: '$($folder -replace "'", "\'")',"
  Write-Host "    tracks: ["

  $n = 0
  foreach ($t in $tracks) {
    $n++
    $title = Get-DisplayTitle $t.Name
    $file = $t.Name -replace "'", "\'"
    $titleEsc = $title -replace "'", "\'"
    Write-Host "      { number: $n, title: '$titleEsc', file: '$file' },"
  }

  Write-Host "    ]"
  Write-Host "  },"
  Write-Host ""
}

Write-Host "Portadas: copia portada.jpg a covers\<carpeta>\ con copy-portada.ps1" -ForegroundColor DarkGray
