' S5 throwaway: launch a command with no visible console window.
' wscript.exe is not a console app, so nothing flashes at logon.
' Run(cmd, 0 = hidden window, False = do not wait)
Dim sh, cmd
Set sh = CreateObject("WScript.Shell")
cmd = """C:\Program Files\nodejs\node.exe"" ""c:\Users\KaneSnyder(nexwave)\repos\conductor\spikes\s5\hello-sleep.js"""
sh.Run cmd, 0, False
