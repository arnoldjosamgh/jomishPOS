' ============================================================
' Jomish Business Suite — Launcher (Final)
' ============================================================
Set WshShell  = CreateObject("WScript.Shell")
Set fso       = CreateObject("Scripting.FileSystemObject")
Set oEnv      = WshShell.Environment("PROCESS")

strPath = fso.GetParentFolderName(WScript.ScriptFullName)

' 1. Kill any stale node / electron processes silently
WshShell.Run "cmd /c taskkill /F /IM node.exe >nul 2>&1",     0, True
WshShell.Run "cmd /c taskkill /F /IM electron.exe >nul 2>&1", 0, True
WScript.Sleep 1500

' 2. Delete Electron disk cache so the app always loads fresh JS/HTML
Dim cacheRoot
cacheRoot = oEnv("APPDATA") & "\Electron"
Dim subFolders : subFolders = Array("Cache", "Code Cache", "GPUCache")
Dim sf
For Each sf In subFolders
    Dim fullPath : fullPath = cacheRoot & "\" & sf
    If fso.FolderExists(fullPath) Then
        On Error Resume Next
        fso.DeleteFolder fullPath, True
        On Error GoTo 0
    End If
Next

' 3. First-time install: if node_modules missing, run npm install
If Not fso.FolderExists(strPath & "\node_modules") Then
    WshShell.Popup "First-time setup — installing. Please wait ~1 min...", 5, "Jomish Suite", 64
    WshShell.Run "cmd /c cd /d """ & strPath & """ && npm install --omit=dev", 1, True
End If

' 4. Start the backend server (hidden, in its own window)
WshShell.Run "cmd /c cd /d """ & strPath & """ && node """ & strPath & "\backend\server.js""", 0, False

' 5. Wait up to 20 seconds for the server to answer
Dim ready : ready = False
Dim i
For i = 1 To 40
    WScript.Sleep 500
    On Error Resume Next
    Dim http : Set http = CreateObject("MSXML2.XMLHTTP")
    http.Open "GET", "http://localhost:3005/api/discover", False
    http.Send
    If http.Status = 200 Then
        ready = True
        Set http = Nothing
        On Error GoTo 0
        Exit For
    End If
    Set http = Nothing
    On Error GoTo 0
Next

If Not ready Then
    WshShell.Popup "Server did not start in time. Check data\server.log.", 10, "Jomish Error", 16
    WScript.Quit
End If

' 6. Launch Electron UI
Dim electronExe : electronExe = strPath & "\node_modules\electron\dist\electron.exe"
If fso.FileExists(electronExe) Then
    WshShell.Run """" & electronExe & """ """ & strPath & "\electron-main.js""", 0, False
Else
    WshShell.Run "cmd /c start http://localhost:3005/login.html", 0, False
End If
