' Run once. Creates a shortcut in the user's Startup folder that launches
' start-hidden.vbs at every login (hidden). Paths come from the filesystem,
' so non-ASCII folder names are handled correctly by COM.
Dim fso, sh, dir, startup, lnk
Set fso = CreateObject("Scripting.FileSystemObject")
Set sh = CreateObject("WScript.Shell")
dir = fso.GetParentFolderName(WScript.ScriptFullName)
startup = sh.SpecialFolders("Startup")
Set lnk = sh.CreateShortcut(startup & "\FeishuClaudeBridge.lnk")
lnk.TargetPath = "wscript.exe"
lnk.Arguments = """" & dir & "\start-hidden.vbs"""
lnk.WorkingDirectory = dir
lnk.Save
' Also start it now, so you don't have to reboot.
sh.CurrentDirectory = dir
sh.Run "node index.mjs", 0, False
MsgBox "Done. The bridge will auto-start (hidden) on every login, and it has been started now too." & vbCrLf & "To disable: delete 'FeishuClaudeBridge' from the Startup folder (Win+R -> shell:startup).", 64, "feishu-claude-bridge"
