# Aufruf: powershell -ExecutionPolicy Bypass -File C:\mcp-test-server\restart.ps1
$port = 3000
$connections = netstat -ano | Select-String ":$port\s+" | ForEach-Object {
    if ($_ -match '\s(\d+)$') { $Matches[1] }
} | Select-Object -Unique

foreach ($procId in $connections) {
    Write-Host "Beende Prozess PID $procId auf Port $port..."
    taskkill /PID $procId /F
}

Start-Sleep -Seconds 2

Write-Host "Starte jetzt MCP-Test-Server im Scheduler neu"
