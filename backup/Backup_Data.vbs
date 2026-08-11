' ============================================================
' Jomish Suite — Backup to Flash Drive
' Password protected — technician access only.
' ============================================================
Dim pwd
pwd = InputBox("Enter technician password to create backup:", "Jomish Security")
If pwd <> "Jomish9!!" Then
    If pwd <> "" Then MsgBox "Incorrect password.", vbCritical, "Access Denied"
    WScript.Quit
End If

Set WshShell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
Set objShell = CreateObject("Shell.Application")

strPath = fso.GetParentFolderName(fso.GetParentFolderName(WScript.ScriptFullName))

WshShell.Run "cmd /c taskkill /F /IM node.exe >nul 2>&1", 0, True
WScript.Sleep 1500

Set folder = objShell.BrowseForFolder(0, "Select your flash drive or backup folder:", &H0010, "")
If folder Is Nothing Then
    WshShell.Popup "Backup cancelled.", 3, "Jomish Suite", 64
    WScript.Quit
End If

Dim destPath
destPath = folder.Self.Path

WshShell.Run "cmd /c cd /d """ & strPath & """ && node tools/backup.js """ & destPath & """ && pause", 1, True

WshShell.Run "cmd /c cd /d """ & strPath & """ && node backend/server.js", 0, False

WshShell.Popup "Backup saved to:" & vbCrLf & destPath & vbCrLf & vbCrLf & "Server restarted.", 8, "Backup Complete", 64
