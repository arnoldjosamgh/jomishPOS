' ============================================================
' Enable Jomish Suite to start with Windows
' ============================================================
Set WshShell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

strPath = fso.GetParentFolderName(fso.GetParentFolderName(WScript.ScriptFullName))
Dim launcherPath
launcherPath = strPath & "\Start_Jomish_Suite.vbs"

Set oLink = WshShell.CreateShortcut(WshShell.SpecialFolders("Startup") & "\Jomish Suite.lnk")
oLink.TargetPath = "wscript.exe"
oLink.Arguments = """" & launcherPath & """"
oLink.WorkingDirectory = strPath
oLink.Description = "Jomish Business Suite"
oLink.Save

WshShell.Popup "Jomish Suite will now start automatically when your computer turns on." & vbCrLf & vbCrLf & "To disable, run Disable_Startup.vbs", 8, "Startup Enabled", 64
