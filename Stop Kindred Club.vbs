Option Explicit
Dim fso, folder, processes, process
Set fso = CreateObject("Scripting.FileSystemObject")
folder = LCase(fso.GetParentFolderName(WScript.ScriptFullName))
Set processes = GetObject("winmgmts:\\.\root\cimv2").ExecQuery("SELECT * FROM Win32_Process WHERE Name='node.exe'")
For Each process In processes
  If Not IsNull(process.CommandLine) Then
    If InStr(LCase(process.CommandLine), Chr(34) & folder & "\server.mjs" & Chr(34)) > 0 Then process.Terminate
  End If
Next
MsgBox "Kindred Club has stopped. Your saved data is kept in the data folder.", 64, "Kindred Club"
