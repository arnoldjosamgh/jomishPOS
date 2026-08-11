' ============================================================
' Disable Jomish Suite from starting with Windows
' ============================================================
Set WshShell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

Dim shortcutPath
shortcutPath = WshShell.SpecialFolders("Startup") & "\Jomish Suite.lnk"

If fso.FileExists(shortcutPath) Then
    fso.DeleteFile shortcutPath
    WshShell.Popup "Auto-start disabled.", 5, "Startup Disabled", 64
Else
    WshShell.Popup "Auto-start was not enabled.", 5, "Info", 64
End If
