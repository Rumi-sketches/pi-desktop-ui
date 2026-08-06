' pi-web-ui stopper: asks the server to shut down, falls back to killing the node process
Option Explicit
Dim sh, stopped, http, code, wmi, procs, p
Set sh = CreateObject("WScript.Shell")
stopped = False
code = 0

On Error Resume Next
Set http = CreateObject("MSXML2.ServerXMLHTTP.6.0")
http.setTimeouts 1000, 1000, 3000, 5000
http.open "POST", "http://127.0.0.1:3777/api/shutdown", False
http.send ""
If Err.Number = 0 Then code = http.status
Err.Clear
On Error GoTo 0
If code = 200 Then stopped = True

' fallback / cleanup: kill any node process still running server.mjs of this folder
On Error Resume Next
Set wmi = GetObject("winmgmts:\\.\root\cimv2")
Set procs = wmi.ExecQuery("SELECT ProcessId, CommandLine FROM Win32_Process WHERE Name='node.exe'")
For Each p In procs
  If Not IsNull(p.CommandLine) Then
    If InStr(LCase(p.CommandLine), "pi-web-ui\server.mjs") > 0 Then
      p.Terminate()
      stopped = True
    End If
  End If
Next
Err.Clear
On Error GoTo 0

' auto-closing message (3s), so the shortcut never leaves a dialog behind
If stopped Then
  sh.Popup "pi-web-ui: server arrestato.", 3, "pi-web-ui", 64
Else
  sh.Popup "pi-web-ui: nessun server in esecuzione.", 3, "pi-web-ui", 64
End If
