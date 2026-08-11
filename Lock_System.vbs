' ============================================================
' Jomish Suite — Lock System
' Hides ALL files and folders except the launcher and unlock script.
' Run ONCE after deployment. Only technicians can unlock.
' ============================================================
Set WshShell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

strPath = fso.GetParentFolderName(WScript.ScriptFullName)

' ── 1. Hide ALL sub-folders ────────────────────────────────
Dim oFolder
Set oFolder = fso.GetFolder(strPath)
Dim subF
For Each subF In oFolder.SubFolders
    WshShell.Run "cmd /c attrib +h +s """ & subF.Path & """", 0, True
Next

' ── 2. Hide ALL files except the two visible ones ──────────
' Everything except Start_Jomish_Suite.vbs and Unlock_System.vbs gets hidden
Dim oFile
For Each oFile In oFolder.Files
    Dim fname
    fname = fso.GetFileName(oFile.Path)
    If fname <> "Start_Jomish_Suite.vbs" And fname <> "Unlock_System.vbs" Then
        WshShell.Run "cmd /c attrib +h +s """ & oFile.Path & """", 0, True
    End If
Next

WshShell.Popup "System locked." & vbCrLf & vbCrLf & _
    "All internal files and folders are now hidden." & vbCrLf & _
    "Only the launcher is visible to users." & vbCrLf & vbCrLf & _
    "Use Unlock_System.vbs (password required) for maintenance.", _
    10, "Jomish Security", 64
