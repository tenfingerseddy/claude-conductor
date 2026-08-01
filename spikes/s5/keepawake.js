// S5 throwaway: prove a keep-awake hold can be taken and released from Node, without admin.
//
// SetThreadExecutionState returns the PREVIOUS execution state of the calling thread.
// That return value is the non-admin proof: powercfg /requests needs elevation to view,
// but the API itself tells us what Windows had recorded a moment earlier.
//
// Expected chain on a clean thread:
//   set(CONTINUOUS|SYSTEM|DISPLAY) -> returns 0x80000000   (baseline was plain CONTINUOUS)
//   set(CONTINUOUS)                -> returns 0x80000003   (Windows HAD our hold)
//   set(CONTINUOUS)                -> returns 0x80000000   (hold is gone)
//
// The hold lives on the thread, so the child must hold and sleep on that same thread.
// Killing the child process releases the hold implicitly, which is the crash-safety we want.
const { spawn } = require("child_process");

const holdSeconds = Number(process.argv[2] || 12);

const ps = `
$sig = @'
[DllImport("kernel32.dll", SetLastError=true)]
public static extern uint SetThreadExecutionState(uint esFlags);
'@
$k = Add-Type -MemberDefinition $sig -Name PowerHold -Namespace ConductorS5 -PassThru
# NOTE: Windows PowerShell 5.1 parses the literal 0x80000000 as a signed Int32 and the
# [uint32] cast then throws. Write it as a decimal that fits UInt32.
$CONT = [uint32]2147483648   # ES_CONTINUOUS
$SYS  = [uint32]1            # ES_SYSTEM_REQUIRED
$DISP = [uint32]2            # ES_DISPLAY_REQUIRED
function Hex([uint32]$v) { '0x{0:X8}' -f $v }

$r1 = $k::SetThreadExecutionState($CONT -bor $SYS -bor $DISP)
Write-Output "ACQUIRE  returned_prev=$(Hex $r1)  (nonzero means the call succeeded)"
Write-Output "HOLDING  pid=$PID for ${holdSeconds}s"
Start-Sleep -Seconds ${holdSeconds}

$r2 = $k::SetThreadExecutionState($CONT)
Write-Output "RELEASE  returned_prev=$(Hex $r2)  (expect 0x80000003 = CONTINUOUS|SYSTEM|DISPLAY was held)"

$r3 = $k::SetThreadExecutionState($CONT)
Write-Output "VERIFY   returned_prev=$(Hex $r3)  (expect 0x80000000 = hold is gone)"
`;

const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", ps], {
  stdio: ["ignore", "pipe", "pipe"],
  windowsHide: true,
});

console.log(`node pid=${process.pid} powershell child pid=${child.pid}`);
child.stdout.on("data", (d) => String(d).trimEnd().split(/\r?\n/).forEach((l) => console.log(`[hold] ${l}`)));
child.stderr.on("data", (d) => process.stderr.write(`[hold-err] ${d}`));
child.on("exit", (code) => console.log(`child exited code=${code}`));
