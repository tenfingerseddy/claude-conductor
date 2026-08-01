# S5 throwaway: report whether a running process owns a VISIBLE top-level window,
# and whether it has a conhost.exe child (the thing that flashes at logon).
param([string]$ProcName = "node")

Add-Type @'
using System;
using System.Runtime.InteropServices;
using System.Collections.Generic;
public class WinEnum {
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumWindowsProc cb, IntPtr l);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  delegate bool EnumWindowsProc(IntPtr h, IntPtr l);
  public static List<string> VisibleFor(uint target) {
    var found = new List<string>();
    EnumWindows((h, l) => {
      uint pid; GetWindowThreadProcessId(h, out pid);
      if (pid == target && IsWindowVisible(h)) found.Add(h.ToString());
      return true;
    }, IntPtr.Zero);
    return found;
  }
}
'@

$procs = Get-CimInstance Win32_Process -Filter "Name='$ProcName.exe'" | Where-Object { $_.CommandLine -match 'hello-sleep' }
if (-not $procs) { "no matching $ProcName process running"; return }
foreach ($p in $procs) {
  $vis = [WinEnum]::VisibleFor([uint32]$p.ProcessId)
  $conhost = Get-CimInstance Win32_Process -Filter "ParentProcessId=$($p.ProcessId) AND Name='conhost.exe'"
  "pid=$($p.ProcessId) visibleWindows=$($vis.Count) conhostChild=$(if($conhost){'yes'}else{'no'})"
}
