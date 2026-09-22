Option Explicit
Dim shell, fso, folder, node, http, ready, i, command
Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
folder = fso.GetParentFolderName(WScript.ScriptFullName)
node = shell.ExpandEnvironmentStrings("%ProgramFiles%") & "\nodejs\node.exe"
If Not fso.FileExists(node) Then
  node = shell.ExpandEnvironmentStrings("%LOCALAPPDATA%") & "\Programs\nodejs\node.exe"
End If
If Not fso.FileExists(node) Then
  MsgBox "Install Node.js version 24 or newer from nodejs.org, then open this launcher again.", 48, "Kindred Club"
  WScript.Quit 1
End If
If Not fso.FolderExists(fso.BuildPath(folder, "node_modules\stripe")) Then
  MsgBox "Open a terminal in this folder and run npm ci once to install dependencies, then open this launcher again.", 48, "Kindred Club"
  WScript.Quit 1
End If
shell.CurrentDirectory = folder
Set http = CreateObject("MSXML2.ServerXMLHTTP.6.0")
ready = False
On Error Resume Next
http.setTimeouts 1000, 1000, 1000, 1000
http.open "GET", "http://127.0.0.1:4173/api/state", False
http.send
If Err.Number = 0 Then
  If http.status = 200 And InStr(http.responseText, "charities") > 0 Then ready = True
End If
Err.Clear
On Error GoTo 0
If Not ready Then
  command = Chr(34) & node & Chr(34) & " " & Chr(34) & folder & "\server.mjs" & Chr(34)
  shell.Run command, 0, False
  For i = 1 To 30
    WScript.Sleep 300
    On Error Resume Next
    http.open "GET", "http://127.0.0.1:4173/api/state", False
    http.send
    If Err.Number = 0 Then
      If http.status = 200 And InStr(http.responseText, "charities") > 0 Then ready = True
    End If
    Err.Clear
    On Error GoTo 0
    If ready Then Exit For
  Next
End If
If ready Then
  shell.Run "http://127.0.0.1:4173/", 1, False
Else
  MsgBox "The website could not start. Check that Node.js 24 or newer is installed and port 4173 is free. See README.md for manual startup.", 48, "Kindred Club"
End If
