' ============================================================
' Jomish Suite — Restore from Backup
' Password protected — technician access only.
' ============================================================
Dim pwd
pwd = InputBox("Enter technician password to restore backup:", "Jomish Security")
If pwd <> "Jomish9!!" Then
    If pwd <> "" Then MsgBox "Incorrect password.", vbCritical, "Access Denied"
    WScript.Quit
End If

Set WshShell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

strPath = fso.GetParentFolderName(fso.GetParentFolderName(WScript.ScriptFullName))

WshShell.Run "cmd /c taskkill /F /IM node.exe >nul 2>&1", 0, True
WScript.Sleep 2000

Dim objExec, backupFile
backupFile = ""
Set objExec = WshShell.Exec("powershell -Command ""Add-Type -AssemblyName System.Windows.Forms; $f = New-Object System.Windows.Forms.OpenFileDialog; $f.Filter = 'Jomish Backup (*.db)|*.db'; $f.Title = 'Select Jomish Backup File'; $f.InitialDirectory = 'E:\'; if($f.ShowDialog() -eq 'OK'){$f.FileName}""")

Do While Not objExec.StdOut.AtEndOfStream
    backupFile = objExec.StdOut.ReadLine()
Loop

If backupFile = "" Then
    WshShell.Popup "Restore cancelled.", 3, "Jomish Suite", 64
    WScript.Quit
End If

Dim answer
answer = MsgBox("Restore from:" & vbCrLf & vbCrLf & backupFile & vbCrLf & vbCrLf & "WARNING: Data after this backup will be LOST!", vbYesNo + vbExclamation, "Confirm Restore")
If answer <> vbYes Then WScript.Quit

WshShell.Run "cmd /c cd /d """ & strPath & """ && node tools/restore.js """ & backupFile & """ && pause", 1, True

WshShell.Popup "Restore complete! Starting server...", 3, "Jomish Suite", 64
WshShell.Run "cmd /c cd /d """ & strPath & """ && node backend/server.js", 0, False
WScript.Sleep 4000
WshShell.Run "cmd /c start http://localhost:3005/login.html", 0, False
