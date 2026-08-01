# S5, Windows service ergonomics

Verdict: **amber**. All three have a working path with no admin rights. Two carry caveats that
need a named fallback, and one part could not be verified end to end because Tailscale is not
currently connected on this machine.

Run 2026-08-01 on Windows 11 Pro 10.0.26200, Node v24.11.1, Tailscale 1.94.2 installed.
Session ran as a standard user, `Admin: False`, on an Azure AD joined and workplace joined
device. No elevation was used at any point.

## The question

1. Can a Node daemon auto-start at login without admin rights?
2. Can it keep the laptop awake while sessions run, and release the hold when they stop?
3. Can a server bind to the Tailscale interface only, with proof nothing listens elsewhere?

## Item 1, auto-start at login

### What was run

Four registration routes were tried with a trivial Node payload that appends a line to a log
file in `%TEMP%`.

`schtasks.exe /Create` with a logon trigger, three variants (bare, `/RU` full Azure AD name,
`/RU` short name, plus a subfolder task name):

```
=== A: /RU full AzureAD name  TN=ConductorS5Test ===
ERROR: Access is denied.
exit=1
=== B: /RU short username     TN=ConductorS5Test ===
ERROR: Access is denied.
exit=1
=== C: subfolder + /RU full   TN=Conductor\S5Test ===
ERROR: Access is denied.
exit=1
```

Raw Task Scheduler COM (`Schedule.Service`, `RegisterTaskDefinition`):

```
COM register FAILED: Access is denied. (0x80070005 (E_ACCESSDENIED))
```

PowerShell `Register-ScheduledTask` with an interactive principal:

```
REGISTERED ok
```

That is the surprise worth recording: on this machine `schtasks.exe` and raw COM are both denied
to a standard user, but `Register-ScheduledTask` succeeds. The registered task:

```
TaskName : ConductorS5Test
TaskPath : \
State    : Ready

UserId    : KaneSnyder(nexwave)
LogonType : Interactive
RunLevel  : Limited

Execute   : C:\Program Files\nodejs\node.exe
Arguments : "...\spikes\s5\hello-sleep.js"

CimClass  : Root/Microsoft/Windows/TaskScheduler:MSFT_TaskLogonTrigger
Enabled   : True
```

Running it on demand, the payload actually executed:

```
LastRunTime        : 1/08/2026 5:32:14 PM
LastTaskResult     : 0
NumberOfMissedRuns : 0
--- payload log ---
2026-08-01T07:32:14.976Z started pid=37508
```

The HKCU Run key route was also written and read back as a standard user with no error:

```
=== write HKCU Run entry (no admin) ===
exit=True
=== read it back ===
"C:\Windows\System32\wscript.exe" "...\spikes\s5\run-hidden.vbs"
```

### Hidden window behaviour

This matters: a console window flashing at every login is unacceptable. It was measured, not
assumed. A helper enumerated top-level windows owned by the payload process and checked
`IsWindowVisible`.

Task runs `node.exe` directly:

```
pid=37916 visibleWindows=1 conhostChild=yes
```

Task runs `wscript.exe` with a one-line `.vbs` wrapper that calls `WScript.Shell.Run cmd, 0, False`:

```
pid=33756 visibleWindows=0 conhostChild=yes
LastTaskResult : 0
```

Same wrapper invoked the way the shell invokes a Run key value:

```
pid=37540 visibleWindows=0 conhostChild=yes
```

So the direct route shows a real visible window. The `wscript` wrapper gives zero visible
windows. A conhost is still allocated in both cases, but it is hidden, which is what matters.

### Recommendation

Primary: a logon scheduled task registered through PowerShell, pointing at a `wscript` wrapper.
The scheduled task is preferred over the Run key because it also gives a start delay and
restart-on-failure, which a daemon wants.

```powershell
$vbs = "$env:USERPROFILE\.conductor\start-conductor.vbs"
$action  = New-ScheduledTaskAction -Execute "$env:WINDIR\System32\wscript.exe" -Argument "`"$vbs`""
$trigger = New-ScheduledTaskTrigger -AtLogOn -User ([Security.Principal.WindowsIdentity]::GetCurrent().Name)
$principal = New-ScheduledTaskPrincipal -UserId ([Security.Principal.WindowsIdentity]::GetCurrent().Name) -LogonType Interactive
$settings  = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
             -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)
Register-ScheduledTask -TaskName "Conductor" -Action $action -Trigger $trigger `
             -Principal $principal -Settings $settings -Force
```

The wrapper, which is the piece that kills the flash:

```vbs
Set sh = CreateObject("WScript.Shell")
sh.Run """C:\Program Files\nodejs\node.exe"" ""<path to conductor entry point>""", 0, False
```

Fallback, if `Register-ScheduledTask` is ever denied too: the HKCU Run key, same wrapper, one
line and no elevation.

```powershell
Set-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run' -Name 'Conductor' `
  -Value "`"$env:WINDIR\System32\wscript.exe`" `"$vbs`"" -Type String
```

Caveat to carry: the installer must not shell out to `schtasks.exe`. On this managed machine that
path is denied to a standard user. Use the PowerShell cmdlet, and fall back to the Run key if the
cmdlet throws.

## Item 2, keep-awake

### What was run

`powercfg /requests`, the obvious way to see a wake hold, is not readable without elevation:

```
=== powercfg /requests as non-admin ===
This command requires administrator privileges and must be executed from an elevated command prompt.
exit=1
```

So the hold was proven a different way, using the API's own contract.
`SetThreadExecutionState` returns the **previous** execution state of the calling thread, so
calling it a second time reports what Windows had recorded a moment earlier. Node spawns a
PowerShell child that P/Invokes the call and holds on that thread.

Expected chain, then the measured result:

```
node pid=31048 powershell child pid=7800
[hold] ACQUIRE  returned_prev=0x80000000  (nonzero means the call succeeded)
[hold] HOLDING  pid=7800 for 8s
[hold] RELEASE  returned_prev=0x80000003  (expect 0x80000003 = CONTINUOUS|SYSTEM|DISPLAY was held)
[hold] VERIFY   returned_prev=0x80000000  (expect 0x80000000 = hold is gone)
```

`0x80000003` on release is the proof. Windows was holding
`ES_CONTINUOUS | ES_SYSTEM_REQUIRED | ES_DISPLAY_REQUIRED` at that moment, and the following
call reads back `0x80000000`, the bare baseline, so the hold is gone. Acquire and release both
verified, no admin.

One real trap found along the way. Windows PowerShell 5.1 parses the literal `0x80000000` as a
signed `Int32`, so `[uint32]0x80000000` throws and the flags silently come out wrong:

```
Cannot convert value "-2147483648" to type "System.UInt32". Error: "Value was either too large
or too small for a UInt32."
```

Write it as `[uint32]2147483648`. The first run of this spike produced a false negative because
of exactly this.

Orphan check, since a stuck hold would keep the laptop awake forever. Node was killed while the
child held the lock:

```
node pid=19004
ProcessId Name              MB
    26796 conhost.exe    10.10
    25696 powershell.exe 78.70
--- kill node only, then look for the orphan ---
child pid=26796 died with parent
child pid=25696 died with parent
```

The holder died with its parent. Treat that as incidental rather than guaranteed: it happens
because the child shares the parent's console. Conductor should still release explicitly on
shutdown.

### Caveats

Two, and both are amber rather than red.

The holder process costs about 79 MB of working set, plus about 10 MB of conhost, to hold a
single flag. That is a lot of memory for one boolean. The lighter option is an in-process FFI
binding such as `koffi`, which removes the child process entirely. That is one small dependency
against roughly 89 MB, and it should be decided at M1, not now.

This machine only supports Modern Standby, `Standby (S0 Low Power Idle) Network Connected`, which
`powercfg /a` reports without needing admin:

```
The following sleep states are available on this system:
    Standby (S0 Low Power Idle) Network Connected
    Hibernate
    Fast Startup
```

Execution state flags defeat the **idle timer**. They do not defeat a lid close or an explicit
sleep. So a keep-awake hold makes the laptop stay up while sessions run and the lid is open, but
it is not a guarantee against every path into standby. The phone door needs to tolerate the
daemon being suspended and reconnect on wake, rather than assume the laptop is always reachable.

### Recommendation

Take `ES_CONTINUOUS | ES_SYSTEM_REQUIRED | ES_DISPLAY_REQUIRED` while any session is running.
Release with `ES_CONTINUOUS` alone the moment the last session ends, and again on daemon
shutdown. Refcount it, so overlapping sessions do not release each other's hold.

For verification during development, `powercfg /requests` from an elevated prompt is the visual
confirmation, and elevation is needed only for that look, never to take the hold:

```
powercfg /requests
```

## Item 3, bind to one interface only

### What was run

Tailscale is installed and its service is Running, but it is **not connected** on this machine
right now, so there is no Tailscale IPv4 to bind to:

```
tailscale ip -4
no current Tailscale IPs; state: NoState
```

```
"BackendState": "NoState",
"HaveNodeKey": true,
"LoggedOut": false,
"WantRunning": true,
"Online": false
```

The Tailscale adapter is Up but only carries an automatic link-local address, and the control
plane is reachable from this network, so this is a local Tailscale login or backend issue rather
than a network block. It needs Kane to bring Tailscale up interactively; it is not something this
spike should force.

That gave the failure mode for free, which the daemon must handle. Binding to an address that is
not present on any interface:

```
{"ok":false,"code":"EADDRNOTAVAIL","errno":-4090,"syscall":"listen",
 "address":"<a CGNAT-range address>","port":8787,
 "message":"listen EADDRNOTAVAIL: address not available"}
```

The single-interface binding technique itself was then proven against the address that is
actually on the Tailscale adapter:

```
{"ok":true,"listening":{"address":"<the Tailscale adapter address>","family":"IPv4","port":8787},"pid":29772}
```

And this is the proof that nothing else listens. `netstat -ano` shows exactly one listening row,
no `0.0.0.0` and no `127.0.0.1`:

```
  TCP    <tailscale adapter addr>:8787    0.0.0.0:0    LISTENING    29772
```

Reachability from three different local addresses, same running server:

```
<tailscale adapter addr> -> HTTP 200 body=conductor s5
127.0.0.1                -> FAILED: No connection could be made because the target machine actively refused it.
<wifi addr>              -> FAILED: No connection could be made because the target machine actively refused it.
```

Loopback and the Wi-Fi address both actively refuse. That is the behaviour the Security section
asks for.

Tooling note: `Get-NetTCPListener` is **not available** in the PowerShell on this machine.

```
The term 'Get-NetTCPListener' is not recognized as a name of a cmdlet, function, script file, or
executable program.
```

Use `netstat -ano` for this check, in the spike and in any installer doctor command.

### Recommendation

Bind explicitly, never to `0.0.0.0`. `server.listen(port, address)` with a single address is
enough, and Node enforces it at the socket level.

For v1 this is `127.0.0.1` per D6, so item 3 is not on the critical path yet. At M5, resolve the
address at startup rather than hardcoding it, and handle `EADDRNOTAVAIL` as a first-class state:

```js
const addr = execSync("tailscale ip -4").toString().trim();  // fails while Tailscale is down
server.listen(port, addr);
server.on("error", (e) => {
  if (e.code === "EADDRNOTAVAIL") /* Tailscale not up: keep the loopback door, retry with backoff */;
});
```

The daemon must never fall back to `0.0.0.0` when the Tailscale bind fails. Keep the loopback
door alive, report the phone door as unavailable, and retry. Silently widening the bind would put
the phone door on the local network, which the Security section forbids.

Remaining gap, and the reason this item is amber rather than green: the bind has not been proven
against a live Tailscale CGNAT address, only against the Tailscale adapter's current address.
Re-run this one check once Tailscale is logged in. The technique is not in doubt; the end-to-end
path is simply untested.

## Item 4, sleep and wake

Cheap and unplanned evidence: the laptop actually slept during this spike and cut the session.
The event log confirms Modern Standby, and confirms the network stayed connected through it:

```
1/08/2026 5:29:07 PM  566  The system session has transitioned from 6 to 7.
1/08/2026 5:29:07 PM  507  The system is exiting Modern Standby
1/08/2026 5:29:07 PM  172  Connectivity state in standby: Connected, Reason: None
```

The Tailscale adapter survived the sleep and wake and stayed Up with the same address, so the
interface itself is stable across standby. Whether a live Tailscale session stays reachable
through Modern Standby is still unverified, because Tailscale is not connected here. Note that
`Connectivity state in standby: Connected` is promising but is about the network stack, not about
whether the daemon's own sockets keep serving while the CPU is parked.

Practical read: the keep-awake hold is what keeps this from happening during a session, and item
2 delivers that. Outside a session the laptop will sleep, so the phone door must expect to
reconnect rather than hold a socket open.

## Test artifacts, all removed

Everything created on the system during this spike was deleted, and the deletion was verified:

```
=== task gone? ===            no ConductorS5Test task
=== any Conductor task anywhere? ===  none
=== Run key entry gone? ===   no ConductorS5Test value
=== port 8787 ===             free
=== spike node/powershell processes ===  none
=== temp log ===              gone
```

Specifically removed: the `ConductorS5Test` scheduled task, the `ConductorS5Test` HKCU Run value,
the `%TEMP%\conductor-s5-autostart.log` payload log, the bind-test server on port 8787, and all
spike child processes. No system state was left changed. No elevation was used. Nothing was
committed.

Throwaway scripts remain in `spikes/s5/` as evidence: `hello.js`, `hello-sleep.js`,
`bind-test.js`, `keepawake.js`, `run-hidden.vbs`, `window-check.ps1`.

## Verdict

**Amber.** Every one of the three has a working non-admin path, so nothing here blocks the build.

- Auto-start: works, via `Register-ScheduledTask` plus a `wscript` wrapper. Caveat: `schtasks.exe`
  and raw COM are denied to a standard user on this managed machine. Fallback: HKCU Run key.
- Keep-awake: works, acquire and release both proven. Caveats: verifying it with
  `powercfg /requests` needs admin for the read only, the holder process costs about 89 MB, and
  Modern Standby means the flags beat the idle timer but not a lid close.
- Tailscale bind: the technique is proven, including proof that loopback and the Wi-Fi address
  both refuse, and the `EADDRNOTAVAIL` failure mode is characterised. Caveat: not yet proven
  against a live Tailscale IP, because Tailscale sits in `NoState` on this machine. Not on the
  v1 critical path, since D6 binds to `127.0.0.1` until M5.
