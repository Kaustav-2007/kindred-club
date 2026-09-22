Option Explicit
Dim shell, fso, source, desktop, target, item, stamp
Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
source = fso.GetParentFolderName(WScript.ScriptFullName)
desktop = shell.SpecialFolders("Desktop")
target = fso.BuildPath(desktop, "Kindred Club")
If LCase(source) = LCase(target) Then
  MsgBox "Kindred Club is already in your Desktop folder. Open Start Kindred Club.vbs to use it.", 64, "Kindred Club"
  WScript.Quit
End If
If fso.FolderExists(target) Then
  stamp = Year(Now) & Right("0" & Month(Now),2) & Right("0" & Day(Now),2) & "-" & Right("0" & Hour(Now),2) & Right("0" & Minute(Now),2) & Right("0" & Second(Now),2)
  target = target & " " & stamp
End If
On Error Resume Next
fso.CreateFolder target
If Err.Number <> 0 Then
  MsgBox "Windows could not create the project folder on your Desktop. You can copy this entire project folder there manually.", 48, "Kindred Club"
  WScript.Quit 1
End If
On Error GoTo 0
For Each item In fso.GetFolder(source).Files
  If LCase(item.Name) <> ".env" And (Left(LCase(item.Name),5) <> ".env." Or LCase(item.Name) = ".env.example") Then fso.CopyFile item.Path, fso.BuildPath(target,item.Name), False
Next
For Each item In fso.GetFolder(source).SubFolders
  If LCase(item.Name) <> "data" And LCase(item.Name) <> "data-live" And LCase(item.Name) <> "node_modules" And LCase(item.Name) <> "work" And LCase(item.Name) <> ".git" Then
    fso.CopyFolder item.Path, fso.BuildPath(target,item.Name), False
  End If
Next
shell.Run "explorer.exe " & Chr(34) & target & Chr(34), 1, False
MsgBox "Saved to " & target & vbCrLf & vbCrLf & "Run npm ci in this folder once, then open Start Kindred Club.vbs. Configure Stripe privately before accepting payments.", 64, "Kindred Club"
