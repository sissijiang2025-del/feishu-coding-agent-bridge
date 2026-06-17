' Launch the bridge(s) with no visible console window.
' Resolves its own folder, so it works regardless of the (possibly non-ASCII) path.
' Starts the default config (config.json) and, if present, config.codex.json.
' Each instance writes its own log to %USERPROFILE%\.feishu-claude-bridge\bridge-<agent>.log
Dim fso, sh, dir, cfgDir, codexCfg
Set fso = CreateObject("Scripting.FileSystemObject")
Set sh = CreateObject("WScript.Shell")
dir = fso.GetParentFolderName(WScript.ScriptFullName)
sh.CurrentDirectory = dir
cfgDir = sh.ExpandEnvironmentStrings("%USERPROFILE%") & "\.feishu-claude-bridge"

' default instance (Claude) — launched directly (no cmd wrapper) so it survives detached
If fso.FileExists(cfgDir & "\config.json") Then
  sh.Run "node index.mjs", 0, False
End If

' codex instance, if a codex config exists
codexCfg = cfgDir & "\config.codex.json"
If fso.FileExists(codexCfg) Then
  sh.Run "node index.mjs --config """ & codexCfg & """", 0, False
End If
