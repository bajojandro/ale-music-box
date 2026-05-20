# Copia portada.jpg de un disco a covers\ (para ver la carátula en local sin bloqueos)
# Uso: .\copy-portada.ps1 -AlbumFolder "D:\Musica\Iron Maiden - The Number Of The Beast"
param(
  [Parameter(Mandatory = $true)]
  [string]$AlbumFolder
)

$folderName = Split-Path -Leaf $AlbumFolder
$portada = Get-ChildItem -LiteralPath $AlbumFolder -File |
  Where-Object { $_.Name -match '^portada\.(jpg|jpeg|png|webp)$' } |
  Select-Object -First 1

if (-not $portada) {
  Write-Host "No hay portada.jpg en: $AlbumFolder" -ForegroundColor Red
  exit 1
}

$dest = Join-Path $PSScriptRoot "covers\$folderName"
New-Item -ItemType Directory -Force -Path $dest | Out-Null
Copy-Item -LiteralPath $portada.FullName -Destination (Join-Path $dest 'portada.jpg') -Force
Write-Host "OK: covers\$folderName\portada.jpg" -ForegroundColor Green
