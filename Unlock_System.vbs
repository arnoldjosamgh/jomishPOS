' ============================================================
' Jomish Suite — Unlock System (Technician Only)
' Reveals ALL hidden files and folders for maintenance.
' Password: Jomish9!!
' ============================================================
Dim pwd
pwd = InputBox("Enter technician password to unlock system:", "Jomish Security")
If pwd <> "Jomish9!!" Then
    If pwd <> "" Then MsgBox "Incorrect password.", vbCritical, "Access Denied"
    WScript.Quit
End If

Set WshShell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

strPath = fso.GetParentFolderName(WScript.ScriptFullName)

' ── 1. Unhide ALL sub-folders ──────────────────────────────
' Use cmd /c attrib on the entire directory tree recursively
WshShell.Run "cmd /c attrib -h -s """ & strPath & "\*"" /S /D", 0, True

WshShell.Popup "System unlocked." & vbCrLf & vbCrLf & _
    "All files and folders are now visible for maintenance." & vbCrLf & _
    "Run Lock_System.vbs when done to re-hide everything.", _
    10, "Jomish Security", 64
