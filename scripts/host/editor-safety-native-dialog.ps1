param(
    [Parameter(Mandatory = $true)]
    [int]$OwnerProcessId,

    [Parameter(Mandatory = $true)]
    [ValidateSet('Cancel')]
    [string]$Action
)

$ErrorActionPreference = 'Stop'

Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;

public sealed class EditorSafetyWindowInfo
{
    public long Handle { get; set; }
    public uint ProcessId { get; set; }
    public string Title { get; set; }
    public string ClassName { get; set; }
    public bool Visible { get; set; }
}

public static class EditorSafetyNativeWindows
{
    private delegate bool EnumWindowsProc(IntPtr handle, IntPtr parameter);

    [DllImport("user32.dll")]
    private static extern bool EnumWindows(EnumWindowsProc callback, IntPtr parameter);

    [DllImport("user32.dll")]
    private static extern uint GetWindowThreadProcessId(IntPtr handle, out uint processId);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern int GetWindowText(IntPtr handle, StringBuilder text, int maxCount);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern int GetClassName(IntPtr handle, StringBuilder text, int maxCount);

    [DllImport("user32.dll")]
    private static extern bool IsWindowVisible(IntPtr handle);

    [DllImport("user32.dll", SetLastError = true)]
    public static extern bool PostMessage(
        IntPtr handle,
        uint message,
        IntPtr wParam,
        IntPtr lParam
    );

    public static IList<EditorSafetyWindowInfo> GetAll()
    {
        var result = new List<EditorSafetyWindowInfo>();
        EnumWindows((handle, parameter) =>
        {
            uint processId;
            GetWindowThreadProcessId(handle, out processId);
            var title = new StringBuilder(1024);
            var className = new StringBuilder(256);
            GetWindowText(handle, title, title.Capacity);
            GetClassName(handle, className, className.Capacity);
            result.Add(new EditorSafetyWindowInfo
            {
                Handle = handle.ToInt64(),
                ProcessId = processId,
                Title = title.ToString(),
                ClassName = className.ToString(),
                Visible = IsWindowVisible(handle)
            });
            return true;
        }, IntPtr.Zero);
        return result;
    }
}
'@

function Find-NativeDialog {
    [EditorSafetyNativeWindows]::GetAll() |
        Where-Object {
            $_.ProcessId -eq $OwnerProcessId -and
            $_.ClassName -eq '#32770' -and
            $_.Visible
        } |
        Select-Object -First 1
}

$deadline = [DateTime]::UtcNow.AddSeconds(5)
$dialog = $null
while ([DateTime]::UtcNow -lt $deadline -and -not $dialog) {
    $dialog = Find-NativeDialog
    if (-not $dialog) {
        Start-Sleep -Milliseconds 25
    }
}
if (-not $dialog) {
    throw "No visible native #32770 dialog owned by process $OwnerProcessId"
}

$root = [System.Windows.Automation.AutomationElement]::FromHandle(
    [System.IntPtr]$dialog.Handle
)
if (-not $root) {
    throw "No UI Automation element for dialog $($dialog.Handle)"
}

$elements = $root.FindAll(
    [System.Windows.Automation.TreeScope]::Descendants,
    [System.Windows.Automation.Condition]::TrueCondition
)
$controls = @(
    for ($index = 0; $index -lt $elements.Count; $index++) {
        $element = $elements.Item($index)
        [pscustomobject]@{
            Name = $element.Current.Name
            AutomationId = $element.Current.AutomationId
            ControlType = $element.Current.ControlType.ProgrammaticName
            IsEnabled = $element.Current.IsEnabled
        }
    }
)

$instruction = $controls | Where-Object {
    $_.AutomationId -eq 'MainInstruction'
} | Select-Object -First 1
$buttons = @(
    $controls | Where-Object {
        $_.AutomationId -match '^CommandButton_\d+$' -and $_.IsEnabled
    }
)
$requiredButtonIds = @('CommandButton_100', 'CommandButton_101', 'CommandButton_102')
foreach ($requiredId in $requiredButtonIds) {
    if ($buttons.AutomationId -notcontains $requiredId) {
        throw "Native dirty-close dialog is missing '$requiredId'"
    }
}
if (-not $instruction -or -not $instruction.Name) {
    throw "Unexpected native dirty-close instruction: $($instruction.Name)"
}

if ($Action -eq 'Cancel') {
    $posted = [EditorSafetyNativeWindows]::PostMessage(
        [System.IntPtr]$dialog.Handle,
        0x0010,
        [System.IntPtr]::Zero,
        [System.IntPtr]::Zero
    )
    if (-not $posted) {
        throw "WM_CLOSE failed for native dialog $($dialog.Handle)"
    }
}

$closeDeadline = [DateTime]::UtcNow.AddSeconds(3)
do {
    Start-Sleep -Milliseconds 25
    $remaining = Find-NativeDialog
} while ([DateTime]::UtcNow -lt $closeDeadline -and $remaining)
if ($remaining) {
    throw "Native dirty-close dialog remained visible after $Action"
}

[pscustomobject]@{
    ProcessId = $OwnerProcessId
    Handle = $dialog.Handle
    Title = $dialog.Title
    ClassName = $dialog.ClassName
    Instruction = $instruction.Name
    Buttons = @(
        $buttons | Select-Object Name, AutomationId
    )
    Action = $Action
    Dispatch = 'WM_CLOSE'
    Closed = $true
} | ConvertTo-Json -Depth 4
