Set WshShell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

strSuitePath = fso.GetParentFolderName(WScript.ScriptFullName)
strVbsPath = strSuitePath & "\Start_Jomish_Suite.vbs"

If Not fso.FileExists(strVbsPath) Then
    WScript.Echo "Error: Cannot find Start_Jomish_Suite.vbs in " & strSuitePath
    WScript.Quit
End If

strStartup = WshShell.SpecialFolders("Startup")
strShortcutPath = strStartup & "\Jomish_Suite.lnk"

Set oShortcut = WshShell.CreateShortcut(strShortcutPath)
oShortcut.TargetPath = "wscript.exe"
oShortcut.Arguments = """" & strVbsPath & """"
oShortcut.WorkingDirectory = strSuitePath
oShortcut.IconLocation = strSuitePath & "\public\favicon.ico"
oShortcut.WindowStyle = 1
oShortcut.Description = "Start Jomish Suite"
oShortcut.Save

WScript.Echo "Success! Jomish Suite will now start automatically when you log in."
