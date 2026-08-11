' ============================================================
' Jomish Business Suite — Docker Kiosk Launcher
' Starts Docker containers in background, waits for port 3005,
' and opens locked fullscreen kiosk browser.
' ============================================================
Set WshShell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

strPath = fso.GetParentFolderName(WScript.ScriptFullName)

' 1. Start Docker containers (docker-compose up -d)
' Running in hidden cmd window
WshShell.Run "cmd /c cd /d """ & strPath & """ && docker-compose -f docker\docker-compose.yml up -d", 0, True

' 2. Wait until server responds
Dim ready, attempts
ready = False
For attempts = 1 To 20
    On Error Resume Next
    Dim http
    Set http = CreateObject("MSXML2.XMLHTTP")
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
    WScript.Sleep 500
Next

If Not ready Then
    WshShell.Popup "Docker server failed to start. Ensure Docker Desktop is running and containers built successfully.", 10, "Error", 16
    WScript.Quit
End If

' 3. Open in kiosk mode (locked fullscreen)
Dim url, launched
url = "http://localhost:3005/login.html"
launched = False

' Try Brave
Dim bravePath
bravePath = ""
If fso.FileExists("C:\Program Files\BraveSoftware\Brave-Browser\Application\brave.exe") Then
    bravePath = "C:\Program Files\BraveSoftware\Brave-Browser\Application\brave.exe"
ElseIf fso.FileExists("C:\Program Files (x86)\BraveSoftware\Brave-Browser\Application\brave.exe") Then
    bravePath = "C:\Program Files (x86)\BraveSoftware\Brave-Browser\Application\brave.exe"
End If

If bravePath <> "" Then
    WshShell.Run """" & bravePath & """ --kiosk --disable-pinch --overscroll-history-navigation=0 --disable-web-security --user-data-dir=""C:\JomishBraveProfile"" --user-agent=""Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"" --app=" & url, 1, False
    launched = True
End If

' Try Chrome
If Not launched Then
    Dim chromePath
    chromePath = ""
    If fso.FileExists("C:\Program Files\Google\Chrome\Application\chrome.exe") Then
        chromePath = "C:\Program Files\Google\Chrome\Application\chrome.exe"
    ElseIf fso.FileExists("C:\Program Files (x86)\Google\Chrome\Application\chrome.exe") Then
        chromePath = "C:\Program Files (x86)\Google\Chrome\Application\chrome.exe"
    End If

    If chromePath <> "" Then
        WshShell.Run """" & chromePath & """ --kiosk --disable-pinch --overscroll-history-navigation=0 --disable-web-security --user-data-dir=""C:\JomishChromeProfile"" --user-agent=""Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"" --app=" & url, 1, False
        launched = True
    End If
End If

' Try Edge
If Not launched Then
    Dim edgePath
    edgePath = "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
    If fso.FileExists(edgePath) Then
        WshShell.Run """" & edgePath & """ --kiosk --disable-pinch --overscroll-history-navigation=0 --disable-web-security --user-data-dir=""C:\JomishEdgeProfile"" --user-agent=""Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"" --app=" & url, 1, False
        launched = True
    End If
End If

' Fallback
If Not launched Then
    WshShell.Run "cmd /c start " & url, 0, False
End If
