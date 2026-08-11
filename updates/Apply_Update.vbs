' ============================================================
' Jomish Suite — Apply Updates
' Password protected — technician access only.
' ============================================================
Dim pwd
pwd = InputBox("Enter technician password to apply updates:", "Jomish Security")
If pwd <> "Jomish9!!" Then
    If pwd <> "" Then MsgBox "Incorrect password.", vbCritical, "Access Denied"
    WScript.Quit
End If

Set WshShell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

strPath = fso.GetParentFolderName(fso.GetParentFolderName(WScript.ScriptFullName))

WshShell.Run "cmd /c taskkill /F /IM node.exe >nul 2>&1", 0, True
WScript.Sleep 2000

WshShell.Run "cmd /c cd /d """ & strPath & """ && node tools/apply-update.js && pause", 1, True

WshShell.Popup "Updates applied! Starting server...", 3, "Jomish Suite", 64
WshShell.Run "cmd /c cd /d """ & strPath & """ && node backend/server.js", 0, False
WScript.Sleep 4000
WshShell.Run "cmd /c start http://localhost:3005/login.html", 0, False
