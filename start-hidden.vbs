' Launch the bridge(s) with no visible console window, logging to the config dir.
' Resolves its own folder, so it works regardless of the (possibly non-ASCII) path.
' Starts the default config (config.json) and, if present, config.codex.json.
Dim fso, sh, dir, cfgDir, codexCfg
Set fso = CreateObject("Scripting.FileSystemObject")
Set sh = CreateObject("WScript.Shell")
dir = fso.GetParentFolderName(WScript.ScriptFullName)
sh.CurrentDirectory = dir
cfgDir = sh.ExpandEnvironmentStrings("%USERPROFILE%") & "\.feishu-claude-bridge"

' default instance (Claude). Output -> claude.log (in the ASCII config dir).
If fso.FileExists(cfgDir & "\config.json") Then
  sh.Run "cmd /c node index.mjs > """ & cfgDir & "\claude.log"" 2>&1", 0, False
End If

' codex instance, if a codex config exists. Output -> codex.log.
codexCfg = cfgDir & "\config.codex.json"
If fso.FileExists(codexCfg) Then
  sh.Run "cmd /c node index.mjs --config """ & codexCfg & """ > """ & cfgDir & "\codex.log"" 2>&1", 0, False
End If
