' pi-web-ui launcher: starts the server hidden (if not already up) and opens the browser
Option Explicit
Dim fso, sh, baseDir, i
Set fso = CreateObject("Scripting.FileSystemObject")
Set sh  = CreateObject("WScript.Shell")
baseDir = fso.GetParentFolderName(WScript.ScriptFullName)

' Returns True only if the server actually answers with HTTP 200.
Function IsUp()
  Dim http, code
  IsUp = False
  code = 0
  On Error Resume Next
  Set http = CreateObject("MSXML2.ServerXMLHTTP.6.0")
  http.setTimeouts 1000, 1000, 2000, 2000
  http.open "GET", "http://127.0.0.1:3777/api/state", False
  http.send
  If Err.Number = 0 Then code = http.status
  Err.Clear
  On Error GoTo 0
  If code = 200 Then IsUp = True
End Function

' Determine the machine's LAN IP so the server can be reached from phones/other devices
Function GetLanIp()
  Dim exec, line, ip
  GetLanIp = ""
  On Error Resume Next
  Set exec = sh.Exec("cmd /c ipconfig")
  Do While Not exec.StdOut.AtEndOfStream
    line = exec.StdOut.ReadLine()
    If InStr(line, "IPv4") > 0 Then
      ip = Trim(Mid(line, InStr(line, ":") + 1))
      If Left(ip, 8) = "192.168." Or Left(ip, 3) = "10." Then
        GetLanIp = ip
        Exit Do
      End If
    End If
  Loop
  On Error GoTo 0
End Function

If Not IsUp() Then
  sh.CurrentDirectory = baseDir
  ' launch through cmd so PATH/PATHEXT are resolved and output is logged
  ' HOST=0.0.0.0 (default in server.mjs) makes the server reachable from other devices on the LAN
  sh.Run "cmd /c node """ & baseDir & "\server.mjs"" > """ & baseDir & "\server.log"" 2>&1", 0, False
  ' wait until the server answers (max ~20s) instead of a fixed sleep
  For i = 1 To 40
    WScript.Sleep 500
    If IsUp() Then Exit For
  Next
  If Not IsUp() Then
    MsgBox "pi-web-ui non si e' avviato." & vbCrLf & "Controlla il log:" & vbCrLf & baseDir & "\server.log", 16, "pi-web-ui"
    WScript.Quit 1
  End If
End If

Dim lanIp
lanIp = GetLanIp()
If lanIp <> "" Then
  MsgBox "Per accedere da telefono/altri dispositivi sulla stessa rete Wi-Fi, apri:" & vbCrLf & "http://" & lanIp & ":3777", 64, "pi-web-ui"
End If

sh.Run "http://localhost:3777", 1, False
