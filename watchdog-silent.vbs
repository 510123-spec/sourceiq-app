Set objShell = CreateObject("WScript.Shell")
objShell.Run "powershell.exe -NoProfile -ExecutionPolicy Bypass -File ""D:\search-engine-app\watchdog.ps1""", 0, True
