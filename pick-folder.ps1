# pick-folder.ps1 — modern native folder picker for pi-web-ui.
#
# Uses IFileOpenDialog with FOS_PICKFOLDERS: the same dialog family as the
# Windows file-open dialog (the one shown by "Allega file"), but in folder
# mode. The dialog is owned by the current foreground window — when the user
# clicks "Sfoglia…" in the browser, the browser IS the foreground window — so
# it opens in front and modal instead of hidden behind everything.
#
# Usage: powershell -NoProfile -STA -ExecutionPolicy Bypass -File pick-folder.ps1 [-Initial "C:\path"]
# Output: the chosen path on stdout, nothing if cancelled.

param([string]$Initial = "")

Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;

[ComImport, Guid("43826d1e-e718-42ee-bc55-a1e261c37bfe"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
internal interface IShellItem {
    void BindToHandler(IntPtr pbc, [MarshalAs(UnmanagedType.LPStruct)] Guid bhid, [MarshalAs(UnmanagedType.LPStruct)] Guid riid, out IntPtr ppv);
    void GetParent(out IShellItem ppsi);
    void GetDisplayName(uint sigdnName, [MarshalAs(UnmanagedType.LPWStr)] out string ppszName);
    void GetAttributes(uint sfgaoMask, out uint psfgaoAttribs);
    void Compare(IShellItem psi, uint hint, out int piOrder);
}

// vtable order must match exactly: IModalWindow.Show, then IFileDialog, then IFileOpenDialog
[ComImport, Guid("d57c7288-d4ad-4768-be02-9d969532d960"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
internal interface IFileOpenDialog {
    [PreserveSig] int Show(IntPtr parent);
    void SetFileTypes(uint cFileTypes, IntPtr rgFilterSpec);
    void SetFileTypeIndex(uint iFileType);
    void GetFileTypeIndex(out uint piFileType);
    void Advise(IntPtr pfde, out uint pdwCookie);
    void Unadvise(uint dwCookie);
    void SetOptions(uint fos);
    void GetOptions(out uint pfos);
    void SetDefaultFolder(IShellItem psi);
    void SetFolder(IShellItem psi);
    void GetFolder(out IShellItem ppsi);
    void GetCurrentSelection(out IShellItem ppsi);
    void SetFileName([MarshalAs(UnmanagedType.LPWStr)] string pszName);
    void GetFileName([MarshalAs(UnmanagedType.LPWStr)] out string pszName);
    void SetTitle([MarshalAs(UnmanagedType.LPWStr)] string pszTitle);
    void SetOkButtonLabel([MarshalAs(UnmanagedType.LPWStr)] string pszText);
    void SetFileNameLabel([MarshalAs(UnmanagedType.LPWStr)] string pszLabel);
    void GetResult(out IShellItem ppsi);
    void AddPlace(IShellItem psi, int fdap);
    void SetDefaultExtension([MarshalAs(UnmanagedType.LPWStr)] string pszDefaultExtension);
    void Close(int hr);
    void SetClientGuid([MarshalAs(UnmanagedType.LPStruct)] Guid guid);
    void ClearClientData();
    void SetFilter(IntPtr pFilter);
    void GetResults(out IntPtr ppenum);
    void GetSelectedItems(out IntPtr ppsai);
}

public static class FolderPicker {
    [DllImport("user32.dll")] private static extern IntPtr GetForegroundWindow();
    [DllImport("shell32.dll", CharSet = CharSet.Unicode, PreserveSig = true)]
    private static extern int SHCreateItemFromParsingName(string pszPath, IntPtr pbc, [MarshalAs(UnmanagedType.LPStruct)] Guid riid, out IShellItem ppv);

    const uint FOS_PICKFOLDERS = 0x20;
    const uint FOS_FORCEFILESYSTEM = 0x40;
    const uint SIGDN_FILESYSPATH = 0x80058000;

    public static string Pick(string title, string initial) {
        IFileOpenDialog dlg = null;
        try {
            dlg = (IFileOpenDialog)Activator.CreateInstance(Type.GetTypeFromCLSID(new Guid("DC1C5A9C-E88A-4dde-A5A1-60F82A20AEF7")));
            uint opts;
            dlg.GetOptions(out opts);
            dlg.SetOptions(opts | FOS_PICKFOLDERS | FOS_FORCEFILESYSTEM);
            dlg.SetTitle(title);
            if (!string.IsNullOrEmpty(initial)) {
                IShellItem item;
                if (SHCreateItemFromParsingName(initial, IntPtr.Zero, typeof(IShellItem).GUID, out item) == 0) {
                    dlg.SetFolder(item);
                    dlg.SetDefaultFolder(item);
                }
            }
            // owned by whatever is foreground now (= the browser tab that asked)
            if (dlg.Show(GetForegroundWindow()) != 0) return null; // 0x800704C7 = cancelled
            IShellItem result;
            dlg.GetResult(out result);
            string picked;
            result.GetDisplayName(SIGDN_FILESYSPATH, out picked);
            return picked;
        } finally {
            if (dlg != null) Marshal.FinalReleaseComObject(dlg);
        }
    }
}
"@

$r = [FolderPicker]::Pick("Scegli la cartella di lavoro", $Initial)
if ($r) { [Console]::Out.Write($r) }
