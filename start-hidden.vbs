' Launch the bridge with no visible console window.
' Resolves its own folder, so it works regardless of the (possibly non-ASCII) path.
Dim fso, sh, dir
Set fso = CreateObject("Scripting.FileSystemObject")
Set sh = CreateObject("WScript.Shell")
dir = fso.GetParentFolderName(WScript.ScriptFullName)
sh.CurrentDirectory = dir
' 0 = hidden window, False = don't wait
sh.Run "node index.mjs", 0, False
