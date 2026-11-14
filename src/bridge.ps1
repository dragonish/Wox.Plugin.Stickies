# Stickies WM_COPYDATA bridge.
#
# Stickies exposes no HTTP / socket / file API. Its only API is Win32
# WM_COPYDATA sent to the main Stickies window ("ZhornSoftwareStickiesMain"),
# see https://www.zhornsoftware.co.uk/stickies/api.html
#
# This script is the one place that touches Win32: it creates a hidden
# WinForms window (only so Stickies has somewhere to send its WM_COPYDATA
# reply to), sends each command from -InputFile with SendMessageTimeout, and
# prints one JSON array to stdout:
#   [{"code":"000","text":"OK pong","raw":"000 OK pong"}, ...]
#
# Reply codes follow the Stickies API docs: 000 = ok, 001 = data,
# 99x = error. code "ERR_NO_STICKIES" means Stickies is not running,
# "ERR_TIMEOUT" means Stickies did not reply within -TimeoutSec.
# The script exits 0 whenever it produced JSON; non-zero only when the
# bridge itself failed (missing input file, Add-Type failure, ...).
#
# One command is handled locally instead of being sent to Stickies:
#   focus <note id>
# resolves the note window handle via the API and activates that window
# with Win32, because the API has no "focus note" command.
#
# Run under powershell.exe (Windows PowerShell 5.1, STA by default).
# All commands sent are pure ASCII: note bodies/titles go through the
# Stickies "utext"/"utitle" hex encoding (4 hex chars per UTF-16 code unit),
# so no code-page loss for Chinese text.

param(
  [Parameter(Mandatory = $true)][string]$InputFile,
  [int]$TimeoutSec = 5
)

$ErrorActionPreference = "Stop"

$code = @"
using System;
using System.Runtime.InteropServices;
using System.Text;
using System.Windows.Forms;

public static class StickiesNative
{
    public const int WM_COPYDATA = 0x4A;
    public const int DW_DATA = 12345;
    public const int SMTO_ABORTIFHUNG = 0x0002;

    [StructLayout(LayoutKind.Sequential)]
    public struct COPYDATASTRUCT
    {
        public IntPtr dwData;
        public int cbData;
        public IntPtr lpData;
    }

    [DllImport("user32.dll", EntryPoint = "FindWindowA", CharSet = CharSet.Ansi, SetLastError = true)]
    public static extern IntPtr FindWindow(string lpClassName, string lpWindowName);

    [DllImport("user32.dll", EntryPoint = "FindWindowExA", CharSet = CharSet.Ansi, SetLastError = true)]
    public static extern IntPtr FindWindowEx(IntPtr hWndParent, IntPtr hWndChildAfter, string lpClassName, string lpWindowName);

    [DllImport("user32.dll", EntryPoint = "SendMessageTimeoutA", CharSet = CharSet.Ansi, SetLastError = true)]
    public static extern IntPtr SendMessageTimeout(IntPtr hWnd, int Msg, IntPtr wParam, ref COPYDATASTRUCT lParam, int fuFlags, int uTimeout, out IntPtr lpdwResult);

    // The lookup must happen here: PowerShell converts a $null argument to ""
    // when binding to a string parameter, and an empty class name matches no
    // window at all, so calling FindWindow($null, ...) from PowerShell never
    // finds Stickies. Passing null from C# keeps the class filter unset.
    public static IntPtr FindStickies()
    {
        IntPtr hWnd = FindWindow(null, "ZhornSoftwareStickiesMain");
        if (hWnd == IntPtr.Zero)
        {
            hWnd = FindWindowEx(IntPtr.Zero, IntPtr.Zero, null, "ZhornSoftwareStickiesMain");
        }
        return hWnd;
    }

    [DllImport("user32.dll")]
    public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);

    [DllImport("user32.dll")]
    public static extern bool BringWindowToTop(IntPtr hWnd);

    [DllImport("user32.dll")]
    public static extern bool SetForegroundWindow(IntPtr hWnd);

    [DllImport("user32.dll")]
    public static extern IntPtr GetForegroundWindow();

    [DllImport("user32.dll")]
    public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);

    [DllImport("kernel32.dll")]
    public static extern uint GetCurrentThreadId();

    [DllImport("user32.dll")]
    public static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool fAttach);

    [DllImport("user32.dll")]
    public static extern void SwitchToThisWindow(IntPtr hWnd, bool fAltTab);

    // Bring a desktop note to the front and give it keyboard focus.
    // A background process may only call SetForegroundWindow while attached
    // to the current foreground thread's input queue, so attach around it.
    public static bool FocusNote(IntPtr hWnd)
    {
        if (hWnd == IntPtr.Zero)
        {
            return false;
        }
        ShowWindow(hWnd, 5); // SW_SHOW

        IntPtr foreground = GetForegroundWindow();
        uint foregroundThread = 0;
        if (foreground != IntPtr.Zero)
        {
            uint foregroundProcessId;
            foregroundThread = GetWindowThreadProcessId(foreground, out foregroundProcessId);
        }
        uint targetProcessId;
        uint targetThread = GetWindowThreadProcessId(hWnd, out targetProcessId);
        uint currentThread = GetCurrentThreadId();

        bool attachedForeground = foregroundThread != 0 && foregroundThread != currentThread
            && AttachThreadInput(currentThread, foregroundThread, true);
        bool attachedTarget = targetThread != 0 && targetThread != currentThread && targetThread != foregroundThread
            && AttachThreadInput(currentThread, targetThread, true);
        try
        {
            BringWindowToTop(hWnd);
            SetForegroundWindow(hWnd);
            // Do not call SetFocus here: Stickies selects the whole note body
            // when its top-level window receives focus directly. Activating
            // the note is enough; Stickies moves focus into its RichEdit child.
        }
        finally
        {
            if (attachedTarget)
            {
                AttachThreadInput(currentThread, targetThread, false);
            }
            if (attachedForeground)
            {
                AttachThreadInput(currentThread, foregroundThread, false);
            }
        }
        if (GetForegroundWindow() == hWnd)
        {
            return true;
        }
        SwitchToThisWindow(hWnd, true);
        return GetForegroundWindow() == hWnd;
    }
}

// Hidden window whose only job is to receive the WM_COPYDATA reply.
// While the UI thread waits inside SendMessageTimeout, Windows dispatches
// incoming sent messages to it, so WndProc runs and stores the reply
// before SendMessageTimeout returns. No message loop is needed.
public class StickiesReplyForm : Form
{
    public string Reply;
    public bool GotReply;

    protected override void WndProc(ref Message m)
    {
        if (m.Msg == StickiesNative.WM_COPYDATA)
        {
            StickiesNative.COPYDATASTRUCT cds = (StickiesNative.COPYDATASTRUCT)Marshal.PtrToStructure(
                m.LParam, typeof(StickiesNative.COPYDATASTRUCT));
            if (cds.dwData.ToInt32() == StickiesNative.DW_DATA)
            {
                // Stickies does not NUL-terminate the reply: cbData is the
                // exact byte count. PtrToStringAnsi would keep reading past
                // the buffer and append garbage, so copy exactly cbData bytes
                // and stop at the first NUL if there is one.
                byte[] bytes = new byte[cds.cbData];
                Marshal.Copy(cds.lpData, bytes, 0, cds.cbData);
                int length = Array.IndexOf(bytes, (byte)0);
                if (length < 0)
                {
                    length = bytes.Length;
                }
                Reply = Encoding.Default.GetString(bytes, 0, length);
                GotReply = true;
            }
        }
        base.WndProc(ref m);
    }
}
"@

Add-Type -TypeDefinition $code -ReferencedAssemblies @("System.Windows.Forms") | Out-Null

function ConvertTo-ReplyObject([string]$raw) {
  $raw = if ($null -eq $raw) { "" } else { $raw.Trim() }
  if ($raw -match "^(\d{3})\s?(.*)$") {
    return [pscustomobject]@{ code = $Matches[1]; text = $Matches[2].Trim(); raw = $raw }
  }
  return [pscustomobject]@{ code = "ERR"; text = $raw; raw = $raw }
}

$commands = @([System.IO.File]::ReadAllLines($InputFile, [System.Text.Encoding]::UTF8) | Where-Object { $_.Trim() -ne "" })

$stickiesHwnd = [StickiesNative]::FindStickies()
if ($stickiesHwnd -eq [IntPtr]::Zero) {
  $results = @([pscustomobject]@{ code = "ERR_NO_STICKIES"; text = "Stickies is not running"; raw = "" })
  [Console]::Out.WriteLine((ConvertTo-Json -InputObject $results -Compress -Depth 3))
  exit 0
}

$form = New-Object StickiesReplyForm
$form.ShowInTaskbar = $false
$form.Visible = $false
# Force the window handle to be created on this (STA) thread.
$null = $form.Handle

# Send one command to Stickies and return its reply object.
function Send-StickiesCommand([string]$command) {
  $form.Reply = $null
  $form.GotReply = $false
  $bytes = [System.Text.Encoding]::Default.GetBytes($command)
  $ptr = [System.Runtime.InteropServices.Marshal]::AllocHGlobal($bytes.Length + 1)
  try {
    [System.Runtime.InteropServices.Marshal]::Copy($bytes, 0, $ptr, $bytes.Length)
    [System.Runtime.InteropServices.Marshal]::WriteByte($ptr, $bytes.Length, 0)
    $cds = [StickiesNative+COPYDATASTRUCT]::new()
    $cds.dwData = [IntPtr]::new([StickiesNative]::DW_DATA)
    $cds.cbData = $bytes.Length + 1
    $cds.lpData = $ptr
    $unused = [IntPtr]::Zero
    [void][StickiesNative]::SendMessageTimeout(
      $stickiesHwnd,
      [StickiesNative]::WM_COPYDATA,
      $form.Handle,
      [ref]$cds,
      [StickiesNative]::SMTO_ABORTIFHUNG,
      $TimeoutSec * 1000,
      [ref]$unused)
  }
  finally {
    [System.Runtime.InteropServices.Marshal]::FreeHGlobal($ptr)
  }
  if ($form.GotReply) {
    return ConvertTo-ReplyObject $form.Reply
  }
  return [pscustomobject]@{ code = "ERR_TIMEOUT"; text = "Stickies did not reply within ${TimeoutSec}s"; raw = "" }
}

$results = @()
try {
  foreach ($command in $commands) {
    # Local command: focus <note id>. Stickies has no focus API, so resolve
    # the note window handle through the API and activate it with Win32.
    if ($command -match '^focus\s+(\S+)\s*$') {
      $noteId = $Matches[1]
      $handleReply = Send-StickiesCommand ("api get desktop " + $noteId + " handle")
      if ($handleReply.code -ne "001") {
        $results += $handleReply
        continue
      }
      $handle = [long]0
      if (-not [long]::TryParse($handleReply.text, [ref]$handle) -or $handle -le 0) {
        $results += [pscustomobject]@{ code = "997"; text = "invalid note handle"; raw = "997 invalid note handle" }
        continue
      }
      if ([StickiesNative]::FocusNote([IntPtr]::new($handle))) {
        $results += [pscustomobject]@{ code = "000"; text = "focused"; raw = "000 focused" }
      }
      else {
        $results += [pscustomobject]@{ code = "997"; text = "unable to focus note"; raw = "997 unable to focus note" }
      }
      continue
    }
    $results += Send-StickiesCommand $command
  }
}
finally {
  $form.Dispose()
}

if ($results.Count -eq 0) {
  [Console]::Out.WriteLine("[]")
}
else {
  [Console]::Out.WriteLine((ConvertTo-Json -InputObject $results -Compress -Depth 3))
}
