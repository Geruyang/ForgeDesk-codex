using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.IO;
using System.Linq;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Cryptography;
using System.Security.Principal;
using System.Text;
using System.Text.RegularExpressions;
using System.Web.Script.Serialization;
using System.Windows.Forms;
using Microsoft.Win32.SafeHandles;

// Output-only prototype. Production must pin this executable and its protocol in main.
internal static class FailedEmptyIntentHelper {
    const string Protocol = "fz3b-failed-empty-intent-v1";
    const string Purpose = "isolate-failed-empty-intent-only";
    const string Failed = "fz3b-host-failed-transactions-v1";
    const string Origin = "unproven-origin-zero-byte-orphan";
    const uint ReadControl = 0x20000, Delete = 0x10000, ReadAttributes = 0x80;
    const uint Backup = 0x02000000, OpenReparse = 0x00200000;
    static readonly JavaScriptSerializer Json = new JavaScriptSerializer { MaxJsonLength = 131072, RecursionLimit = 32 };
    static readonly byte[] Entropy = Encoding.UTF8.GetBytes(Protocol + "|native-dialog-isolation-audit");
    static readonly byte[] CloseEntropy = Encoding.UTF8.GetBytes(Protocol + "|main-observed-primary-close");
    static readonly string Sid = WindowsIdentity.GetCurrent().User.Value;
    static readonly string[] AuditNames = { "authorization.json", "completed.json", "consumed.json", "observation.json", "prepared.json" };
    static readonly List<SafeFileHandle> Anchors = new List<SafeFileHandle>();
    static string Root;
    static SafeFileHandle RootHandle;
    static string[] ApprovedSources;

    [StructLayout(LayoutKind.Sequential)] struct Info {
        public uint Attributes; public System.Runtime.InteropServices.ComTypes.FILETIME Creation, Access, Write;
        public uint Volume, SizeHigh, SizeLow, Links, IndexHigh, IndexLow;
    }
    [StructLayout(LayoutKind.Sequential)] struct Basic { public long Creation, Access, Write, Change; public uint Attributes; }
    [StructLayout(LayoutKind.Sequential)] struct IoStatus { public IntPtr Status, Information; }
    [StructLayout(LayoutKind.Sequential)] struct SecurityAttributes { public int Length; public IntPtr Descriptor; public int Inherit; }
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern SafeFileHandle CreateFile(string name, uint access, uint share, IntPtr security, uint creation, uint flags, IntPtr template);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetFileInformationByHandle(SafeFileHandle handle, out Info info);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetFileInformationByHandleEx(SafeFileHandle handle, int kind, IntPtr buffer, uint size);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern uint GetFinalPathNameByHandle(SafeFileHandle handle, StringBuilder path, uint size, uint flags);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern uint GetFileAttributes(string name);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool CreateDirectory(string name, ref SecurityAttributes security);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool GetVolumeInformationByHandleW(SafeFileHandle handle, StringBuilder volume, uint volumeLength, out uint serial, out uint componentLength, out uint flags, StringBuilder fs, uint fsLength);
    [DllImport("advapi32.dll", SetLastError=true)] static extern bool GetKernelObjectSecurity(SafeFileHandle handle, uint security, byte[] buffer, uint length, out uint needed);
    [DllImport("ntdll.dll")] static extern int NtSetInformationFile(SafeFileHandle handle, out IoStatus io, IntPtr info, uint size, int kind);

    static Exception Error(string code) { return new InvalidOperationException("FZ3B_FAILED_EMPTY_INTENT_" + code); }
    static void Require(bool test, string code) { if (!test) throw Error(code); }
    static void Win(bool test, string code) { if (!test) throw new Win32Exception(Marshal.GetLastWin32Error(), "FZ3B_FAILED_EMPTY_INTENT_" + code); }
    static bool Digest(string value) { return value != null && Regex.IsMatch(value, "^[a-f0-9]{64}$"); }
    static string Sha(byte[] bytes) { using (var hash = SHA256.Create()) return BitConverter.ToString(hash.ComputeHash(bytes)).Replace("-", "").ToLowerInvariant(); }
    static byte[] Bytes(object value) { return Encoding.UTF8.GetBytes(Json.Serialize(value)); }
    static string Hash(object value) { return Sha(Bytes(value)); }
    static SortedDictionary<string, object> Obj(params object[] fields) {
        var result = new SortedDictionary<string, object>(StringComparer.Ordinal);
        for (int i = 0; i < fields.Length; i += 2) result.Add((string)fields[i], fields[i + 1]);
        return result;
    }
    static Dictionary<string, object> ReadObject(string line) {
        Require(line != null && line.Length > 0 && line.Length <= 131072, "INPUT_BUDGET");
        var value = Json.DeserializeObject(line) as Dictionary<string, object>; Require(value != null, "INPUT_OBJECT"); return value;
    }
    static string Str(IDictionary<string, object> value, string key) { object result; Require(value.TryGetValue(key, out result) && result is string, "FIELD_" + key); return (string)result; }
    static void Keys(IDictionary<string, object> value, params string[] keys) { Require(value.Keys.OrderBy(x => x, StringComparer.Ordinal).SequenceEqual(keys.OrderBy(x => x, StringComparer.Ordinal)), "FIELDS"); }
    static void Emit(object value) { Console.WriteLine(Json.Serialize(value)); Console.Out.Flush(); }
    static string Normalize(string file) {
        Require(file != null && !file.StartsWith("\\\\", StringComparison.Ordinal) && !file.Contains(":" + Path.DirectorySeparatorChar + ":"), "LOCAL_PATH");
        string full = Path.GetFullPath(file); if (full.Length > 3) full = full.TrimEnd('\\');
        Require(Regex.IsMatch(full, "^[A-Za-z]:\\\\") && !full.Substring(2).Contains(":"), "LOCAL_PATH"); return full;
    }
    static string NativePath(string file) { return "\\\\?\\" + Normalize(file); }
    static string PathRole(string file, bool directory) {
        string name = Path.GetFileName(file.TrimEnd('\\'));
        if (Regex.IsMatch(name, "^fz3b-host-empty-[a-f0-9]{64}\\.intent\\.json$")) return "SOURCE";
        if (name == "fz3b-host-finalization-v1") return "HOME";
        if (name == "source.intent.json") return "PRESERVED";
        return directory ? "DIRECTORY" : "AUDIT";
    }
    static SafeFileHandle Open(string file, bool directory, bool remove, bool privateOwner, bool shareExistingDelete = false) {
        var handle = CreateFile(NativePath(file), ReadControl | ReadAttributes | (directory ? 0x20u : 0) | (remove ? Delete : 0), directory ? 3u : shareExistingDelete ? 5u : 1u, IntPtr.Zero, 3, Backup | OpenReparse, IntPtr.Zero);
        int openError = Marshal.GetLastWin32Error();
        if (handle.IsInvalid) { handle.Dispose(); throw new Win32Exception(openError, "FZ3B_FAILED_EMPTY_INTENT_OPEN_" + PathRole(file, directory)); }
        try {
            Info info; Win(GetFileInformationByHandle(handle, out info), "INFO");
            Require((info.Attributes & 0x400) == 0 && ((info.Attributes & 0x10) != 0) == directory, "REPARSE_OR_TYPE");
            var final = new StringBuilder(32768); uint length = GetFinalPathNameByHandle(handle, final, (uint)final.Capacity, 0);
            Win(length > 0 && length < final.Capacity, "FINAL_PATH");
            Require(String.Equals(final.ToString().Replace("\\\\?\\", "").TrimEnd('\\'), Normalize(file).TrimEnd('\\'), StringComparison.OrdinalIgnoreCase), "FINAL_PATH_CHANGED");
            if (privateOwner) Security(handle, false);
            return handle;
        } catch { handle.Dispose(); throw; }
    }
    static void AnchorRoot(string root) {
        Root = Normalize(root); string current = Path.GetPathRoot(Root);
        Anchors.Add(Open(current, true, false, false));
        foreach (string part in Root.Substring(current.Length).Split(new [] {'\\'}, StringSplitOptions.RemoveEmptyEntries)) {
            current = Path.Combine(current, part); Anchors.Add(Open(current, true, false, false));
        }
        RootHandle = Anchors[Anchors.Count - 1]; Security(RootHandle, false);
        uint serial, component, flags; var fs = new StringBuilder(64);
        Win(GetVolumeInformationByHandleW(RootHandle, null, 0, out serial, out component, out flags, fs, (uint)fs.Capacity), "VOLUME");
        Require(fs.ToString() == "NTFS", "NTFS_REQUIRED");
    }
    static byte[] Security(SafeFileHandle handle, bool privateAcl) {
        uint needed; GetKernelObjectSecurity(handle, 7, null, 0, out needed);
        Require(needed > 0 && needed <= 65536, "SECURITY_UNKNOWN"); var raw = new byte[needed];
        Win(GetKernelObjectSecurity(handle, 7, raw, needed, out needed), "SECURITY");
        var descriptor = new RawSecurityDescriptor(raw, 0);
        Require(descriptor.Owner != null && descriptor.Owner.Value == Sid && descriptor.DiscretionaryAcl != null, "OWNER_OR_DACL");
        bool ownerAllow = false;
        foreach (GenericAce entry in descriptor.DiscretionaryAcl) {
            var ace = entry as CommonAce;
            Require(ace != null && !ace.IsCallback && ace.AceQualifier == AceQualifier.AccessAllowed &&
                (ace.SecurityIdentifier.Value == Sid || ace.SecurityIdentifier.Value == "S-1-5-18" || !privateAcl && ace.SecurityIdentifier.Value == "S-1-5-32-544"), "UNKNOWN_ACE");
            if (ace.SecurityIdentifier.Value == Sid && (ace.AccessMask & 0x1f01ff) == 0x1f01ff) ownerAllow = true;
        }
        if (privateAcl) Require(ownerAllow && (descriptor.ControlFlags & ControlFlags.DiscretionaryAclProtected) != 0, "PRIVATE_ACL");
        return raw;
    }
    static SortedDictionary<string, object> Metadata(SafeFileHandle handle, bool directory) {
        Info info; Win(GetFileInformationByHandle(handle, out info), "INFO");
        Require((info.Attributes & 0x400) == 0 && ((info.Attributes & 0x10) != 0) == directory, "METADATA_TYPE");
        uint allowed = directory ? 0x2030u : 0x20a0u;
        Require((info.Attributes & ~allowed) == 0, "UNKNOWN_ATTRIBUTES");
        if (!directory) { Require(info.SizeHigh == 0 && info.SizeLow == 0 && info.Links == 1, "NOT_ZERO_SINGLE_LINK"); OnlyDefaultStream(handle, 0); }
        IntPtr buffer = Marshal.AllocHGlobal(24); byte[] id = new byte[24];
        try { Win(GetFileInformationByHandleEx(handle, 18, buffer, 24), "FILE_ID"); Marshal.Copy(buffer, id, 0, id.Length); }
        finally { Marshal.FreeHGlobal(buffer); }
        Require(id.Skip(8).Any(x => x != 0), "UNKNOWN_FILE_ID");
        byte[] descriptor = Security(handle, false);
        return Obj("attributes", info.Attributes, "creation", (((long)info.Creation.dwHighDateTime << 32) | (uint)info.Creation.dwLowDateTime).ToString("x16"), "dataStreams", directory ? "directory-metadata" : "unnamed-data-only",
            "fileId", BitConverter.ToString(id.Skip(8).ToArray()).Replace("-", "").ToLowerInvariant(), "links", info.Links,
            "securityDescriptorBase64", Convert.ToBase64String(descriptor), "securitySha256", Sha(descriptor), "size", ((ulong)info.SizeHigh << 32) | info.SizeLow,
            "volumeId", BitConverter.ToString(id.Take(8).ToArray()).Replace("-", "").ToLowerInvariant(),
            "write", (((long)info.Write.dwHighDateTime << 32) | (uint)info.Write.dwLowDateTime).ToString("x16"));
    }
    static void OnlyDefaultStream(SafeFileHandle handle, long expectedSize) {
        IntPtr buffer = Marshal.AllocHGlobal(65536);
        try {
            Win(GetFileInformationByHandleEx(handle, 7, buffer, 65536), "STREAM_METADATA");
            int next = Marshal.ReadInt32(buffer, 0), nameLength = Marshal.ReadInt32(buffer, 4);
            Require(next == 0 && nameLength == 14 && Marshal.ReadInt64(buffer, 8) == expectedSize &&
                (expectedSize != 0 || Marshal.ReadInt64(buffer, 16) == 0) && Marshal.PtrToStringUni(IntPtr.Add(buffer, 24), nameLength / 2) == "::$DATA", "NAMED_OR_UNKNOWN_STREAM");
        } finally { Marshal.FreeHGlobal(buffer); }
    }
    static object RootIdentity() {
        var value = Metadata(RootHandle, true); value.Remove("links"); value.Remove("size"); value.Remove("write"); return value;
    }
    static string ChangeTime(SafeFileHandle handle) {
        int size = Marshal.SizeOf(typeof(Basic)); IntPtr buffer = Marshal.AllocHGlobal(size);
        try { Win(GetFileInformationByHandleEx(handle, 0, buffer, (uint)size), "BASIC_INFO"); return ((Basic)Marshal.PtrToStructure(buffer, typeof(Basic))).Change.ToString("x16"); }
        finally { Marshal.FreeHGlobal(buffer); }
    }
    static void Absent(string file) {
        uint attributes = GetFileAttributes(NativePath(file)); int error = Marshal.GetLastWin32Error();
        Require(attributes == UInt32.MaxValue && (error == 2 || error == 3), "NOT_ABSENT");
    }
    static string[] Entries(string directory, int max) {
        var result = new List<string>(); foreach (string entry in Directory.EnumerateFileSystemEntries(NativePath(directory))) {
            Require(result.Count < max, "INVENTORY_BUDGET"); result.Add(Path.GetFileName(entry));
        } return result.OrderBy(x => x, StringComparer.Ordinal).ToArray();
    }
    static string[] PrefixInventory() { return Entries(Root, 256).Where(x => x.StartsWith("fz3b-host-empty-", StringComparison.Ordinal) || x.StartsWith("fz3b-host-quarantine-", StringComparison.Ordinal)).ToArray(); }
    static void EmptyHome(string home) { Require(Entries(home, 1).Length == 0, "HOME_NOT_EMPTY"); }
    static DirectorySecurity PrivateDirectorySecurity() {
        var security = new DirectorySecurity(); security.SetOwner(new SecurityIdentifier(Sid)); security.SetAccessRuleProtection(true, false);
        foreach (string sid in new [] { Sid, "S-1-5-18" }) security.AddAccessRule(new FileSystemAccessRule(new SecurityIdentifier(sid), FileSystemRights.FullControl, InheritanceFlags.ContainerInherit | InheritanceFlags.ObjectInherit, PropagationFlags.None, AccessControlType.Allow));
        return security;
    }
    static void CreatePrivateDirectory(string directory) {
        byte[] descriptor = PrivateDirectorySecurity().GetSecurityDescriptorBinaryForm(); GCHandle pinned = GCHandle.Alloc(descriptor, GCHandleType.Pinned);
        try { var attr = new SecurityAttributes { Length = Marshal.SizeOf(typeof(SecurityAttributes)), Descriptor = pinned.AddrOfPinnedObject(), Inherit = 0 }; Win(CreateDirectory(NativePath(directory), ref attr), "CREATE_EXCLUSIVE_DIRECTORY"); }
        finally { pinned.Free(); }
    }
    static void WriteNew(string directory, string name, byte[] bytes) {
        var security = new FileSecurity(); security.SetOwner(new SecurityIdentifier(Sid)); security.SetAccessRuleProtection(true, false);
        foreach (string sid in new [] { Sid, "S-1-5-18" }) security.AddAccessRule(new FileSystemAccessRule(new SecurityIdentifier(sid), FileSystemRights.FullControl, AccessControlType.Allow));
        string file = Path.Combine(directory, name);
        using (var stream = new FileStream(NativePath(file), FileMode.CreateNew, FileSystemRights.FullControl, FileShare.Read, 4096, FileOptions.WriteThrough, security)) {
            stream.Write(bytes, 0, bytes.Length); stream.Flush(true); stream.Position = 0; var check = new byte[bytes.Length + 1]; int count = 0, read;
            while ((read = stream.Read(check, count, check.Length - count)) > 0) count += read;
            Require(count == bytes.Length && check.Take(count).SequenceEqual(bytes), "AUDIT_READBACK");
            Security(stream.SafeFileHandle, true);
        }
    }
    static byte[] ReadAudit(string directory, string name, int max) {
        using (var anchor = Open(Path.Combine(directory, name), false, false, true)) {
            Info info; Win(GetFileInformationByHandle(anchor, out info), "AUDIT_INFO"); Require(info.Links == 1 && info.SizeHigh == 0 && info.SizeLow > 0 && info.SizeLow <= max, "AUDIT_BUDGET_LINK"); Security(anchor, true); OnlyDefaultStream(anchor, info.SizeLow);
            using (var stream = new FileStream(NativePath(Path.Combine(directory, name)), FileMode.Open, FileAccess.Read, FileShare.Read)) {
                Info second; Win(GetFileInformationByHandle(stream.SafeFileHandle, out second), "AUDIT_INFO");
                Require(info.Volume == second.Volume && info.IndexHigh == second.IndexHigh && info.IndexLow == second.IndexLow && info.SizeLow == second.SizeLow, "AUDIT_CHANGED");
                byte[] bytes = new byte[info.SizeLow]; int offset = 0, read;
                while (offset < bytes.Length && (read = stream.Read(bytes, offset, bytes.Length - offset)) > 0) offset += read;
                Require(offset == bytes.Length && stream.ReadByte() == -1, "AUDIT_CHANGED"); return bytes;
            }
        }
    }
    static bool Confirm(string details, DateTime created, DateTime expires) {
        bool accepted = false;
        using (var form = new Form()) using (var timer = new Timer()) {
            form.Text = "ForgeDesk - isolate failed empty intent only"; form.Width = 820; form.Height = 660; form.StartPosition = FormStartPosition.CenterScreen;
            form.Shown += delegate {
                form.WindowState = FormWindowState.Normal;
                form.BringToFront(); form.Activate();
            };
            form.FormBorderStyle = FormBorderStyle.FixedDialog; form.MaximizeBox = false; form.MinimizeBox = false; form.TopMost = true;
            var text = new TextBox { Left = 16, Top = 16, Width = 770, Height = 510, Multiline = true, ReadOnly = true, ScrollBars = ScrollBars.Vertical, Text = details };
            var check = new CheckBox { Left = 16, Top = 535, Width = 770, Height = 32, Text = "I understand the origin is unproven; isolate and preserve this zero-byte file only." };
            var cancel = new Button { Left = 560, Top = 576, Width = 100, Text = "Cancel", DialogResult = DialogResult.Cancel };
            var accept = new Button { Left = 670, Top = 576, Width = 116, Text = "Isolate only", Enabled = false };
            check.CheckedChanged += delegate { accept.Enabled = check.Checked; };
            accept.Click += delegate { if (check.Checked && DateTime.UtcNow >= created && DateTime.UtcNow < expires) { accepted = true; form.Close(); } };
            form.CancelButton = cancel; form.Controls.AddRange(new Control[] { text, check, cancel, accept });
            timer.Interval = 200; timer.Tick += delegate { if (DateTime.UtcNow < created || DateTime.UtcNow >= expires) form.Close(); }; timer.Start(); form.ShowDialog();
        } return accepted && DateTime.UtcNow >= created && DateTime.UtcNow < expires;
    }
    static void RenameRelative(SafeFileHandle source, SafeFileHandle destinationDirectory) {
        byte[] name = Encoding.Unicode.GetBytes("source.intent.json"); int rootOffset = IntPtr.Size == 8 ? 8 : 4, lengthOffset = rootOffset + IntPtr.Size, nameOffset = lengthOffset + 4;
        int size = nameOffset + name.Length; IntPtr buffer = Marshal.AllocHGlobal(size);
        try {
            Marshal.Copy(new byte[size], 0, buffer, size); // ReplaceIfExists remains FALSE.
            Marshal.WriteIntPtr(buffer, rootOffset, destinationDirectory.DangerousGetHandle()); Marshal.WriteInt32(buffer, lengthOffset, name.Length); Marshal.Copy(name, 0, IntPtr.Add(buffer, nameOffset), name.Length);
            IoStatus io; int status = NtSetInformationFile(source, out io, buffer, (uint)size, 10);
            Require(status == 0, "ANCHORED_NOREPLACE_RENAME_" + status.ToString("x8"));
        } finally { Marshal.FreeHGlobal(buffer); }
    }
    static object ValidateOne(string directory, bool sourceDeleteOpen = false, bool requirePrimaryClose = true) {
        string[] expected = AuditNames.Concat(requirePrimaryClose ? new [] { "source.intent.json", "native-seal.bin", "primary-close.bin" } : new [] { "source.intent.json", "native-seal.bin" }).OrderBy(x => x, StringComparer.Ordinal).ToArray();
        Require(Entries(directory, 9).SequenceEqual(expected), "AUDIT_INCOMPLETE_OR_EXTRA");
        var auditBytes = new SortedDictionary<string, byte[]>(StringComparer.Ordinal);
        foreach (string name in AuditNames) auditBytes.Add(name, ReadAudit(directory, name, 131072));
        byte[] sealBytes = ReadAudit(directory, "native-seal.bin", 131072);
        byte[] seal = ProtectedData.Unprotect(sealBytes, Entropy, DataProtectionScope.CurrentUser);
        var sealRecord = ReadObject(Encoding.UTF8.GetString(seal)); Keys(sealRecord, "auditSha256", "closeTokenSha256", "protocol", "sid");
        Require(Digest(Str(sealRecord, "closeTokenSha256")), "CLOSE_TOKEN_SEAL");
        var hashes = new SortedDictionary<string, object>(StringComparer.Ordinal); foreach (var entry in auditBytes) hashes.Add(entry.Key, Sha(entry.Value));
        Require(seal.SequenceEqual(Bytes(Obj("auditSha256", hashes, "closeTokenSha256", Str(sealRecord, "closeTokenSha256"), "protocol", Protocol, "sid", Sid))), "NATIVE_AUDIT_AUTHENTICATION");
        var observation = ReadObject(Encoding.UTF8.GetString(auditBytes["observation.json"]));
        var authorization = ReadObject(Encoding.UTF8.GetString(auditBytes["authorization.json"]));
        var prepared = ReadObject(Encoding.UTF8.GetString(auditBytes["prepared.json"]));
        var consumed = ReadObject(Encoding.UTF8.GetString(auditBytes["consumed.json"]));
        var completed = ReadObject(Encoding.UTF8.GetString(auditBytes["completed.json"]));
        Keys(observation, "candidateSourceSha256", "challenge", "currentOwnedOperationsSha256", "completeChainSha256", "expiresAt", "failureEvidenceSha256", "homeMetadataSha256", "origin", "primaryExecutableSha256", "primaryNativePid", "proofSha256", "protocol", "purpose", "recoveryId", "root", "rootIdentitySha256", "runId", "sid", "sourceChangeTime", "sourceMetadata", "sourceMetadataSha256", "sourceName", "targetSha256");
        Keys(authorization, "acceptedAt", "decision", "observationSha256", "origin", "purpose");
        Keys(consumed, "authorizationSha256", "consumedAt", "purpose");
        Keys(prepared, "consumedSha256", "destination", "observationSha256", "purpose");
        Keys(completed, "completedAt", "homeMetadataSha256", "observationSha256", "preparedSha256", "preservedChangeTime", "preservedMetadataSha256", "purpose", "recoveryId", "sourceNameAbsent");
        Require(Str(observation, "protocol") == Protocol && Str(observation, "purpose") == Purpose && Str(observation, "origin") == Origin && Str(observation, "sid") == Sid && Str(observation, "root") == Root && Str(observation, "rootIdentitySha256") == Hash(RootIdentity()), "AUDIT_BINDING");
        Require(ApprovedSources != null && ApprovedSources.Contains(Str(observation, "candidateSourceSha256")), "AUDIT_SOURCE_POLICY");
        string sourceName = Str(observation, "sourceName"); Require(Regex.IsMatch(sourceName, "^fz3b-host-empty-[a-f0-9]{64}\\.intent\\.json$"), "AUDIT_SOURCE_NAME");
        string observationHash = Sha(auditBytes["observation.json"]), recoveryId = Path.GetFileName(directory);
        Require(Str(observation, "recoveryId") == recoveryId && Str(consumed, "purpose") == Purpose && Str(prepared, "purpose") == Purpose && Str(completed, "purpose") == Purpose && Str(prepared, "observationSha256") == observationHash && Str(prepared, "destination") == Failed + "/" + recoveryId + "/source.intent.json" && Str(completed, "homeMetadataSha256") == Str(observation, "homeMetadataSha256"), "AUDIT_CLOSED_BINDING");
        Require(Str(authorization, "observationSha256") == observationHash && Str(authorization, "purpose") == Purpose && Str(authorization, "decision") == "native-checkbox-accepted" && Str(authorization, "origin") == Origin && Str(consumed, "authorizationSha256") == Sha(auditBytes["authorization.json"]) && Str(prepared, "consumedSha256") == Sha(auditBytes["consumed.json"]) && Str(completed, "preparedSha256") == Sha(auditBytes["prepared.json"]) && Str(completed, "recoveryId") == recoveryId && Str(completed, "observationSha256") == observationHash && Str(completed, "sourceNameAbsent") == sourceName, "AUDIT_CHAIN");
        Absent(Path.Combine(Root, sourceName));
        using (var preserved = Open(Path.Combine(directory, "source.intent.json"), false, false, false, sourceDeleteOpen)) Require(Hash(Metadata(preserved, false)) == Str(observation, "sourceMetadataSha256") && Hash(Metadata(preserved, false)) == Str(completed, "preservedMetadataSha256") && ChangeTime(preserved) == Str(completed, "preservedChangeTime"), "PRESERVED_CHANGED");
        var audit = Obj("candidateSourceSha256", Str(observation, "candidateSourceSha256"), "completeChainSha256", Str(observation, "completeChainSha256"), "failureEvidenceSha256", Str(observation, "failureEvidenceSha256"), "nativeSealSha256", Sha(sealBytes), "observationSha256", observationHash, "proofSha256", Str(observation, "proofSha256"), "recoveryId", recoveryId, "runId", Str(observation, "runId"), "sourceName", sourceName, "targetSha256", Str(observation, "targetSha256"));
        if (requirePrimaryClose) {
            byte[] closeBytes = ProtectedData.Unprotect(ReadAudit(directory, "primary-close.bin", 131072), CloseEntropy, DataProtectionScope.CurrentUser);
            var closeRecord = ReadObject(Encoding.UTF8.GetString(closeBytes)); Keys(closeRecord, "audit", "method", "primary", "rootIdentitySha256", "schemaVersion", "sid");
            var primary = closeRecord["primary"] as Dictionary<string, object>; Require(primary != null, "PRIMARY_CLOSE_RECORD");
            AssertPrimaryClose(primary, observation, audit);
            Require(closeBytes.SequenceEqual(Bytes(Obj("audit", audit, "method", "main-observed-primary-close-only", "primary", Sorted(primary), "rootIdentitySha256", Str(observation, "rootIdentitySha256"), "schemaVersion", 1, "sid", Sid))), "PRIMARY_CLOSE_AUTHENTICATION");
        }
        return audit;
    }
    static SortedDictionary<string, object> Sorted(Dictionary<string, object> value) { return new SortedDictionary<string, object>(value, StringComparer.Ordinal); }
    static void AssertPrimaryClose(Dictionary<string, object> primary, IDictionary<string, object> observation, IDictionary<string, object> audit) {
        Keys(primary, "candidateSourceSha256", "closeObservedAt", "executableSha256", "exitCode", "mainPid", "nativeSealSha256", "observationSha256", "primaryPid", "primaryTerminalSha256", "recoveryId", "runId", "signal", "sourceName", "spawnObservedAt");
        foreach (string key in new [] { "candidateSourceSha256", "nativeSealSha256", "observationSha256", "recoveryId", "runId", "sourceName" }) Require(Str(primary, key) == (string)audit[key], "PRIMARY_CLOSE_BINDING");
        Require(primary["exitCode"] is int && (int)primary["exitCode"] == 0 && primary["signal"] == null && primary["primaryPid"] is int && (int)primary["primaryPid"] == Convert.ToInt32(observation["primaryNativePid"]) && primary["mainPid"] is int && (int)primary["mainPid"] > 0 && Str(primary, "executableSha256") == Str(observation, "primaryExecutableSha256") && Digest(Str(primary, "primaryTerminalSha256")), "PRIMARY_CLOSE_FACTS");
        DateTime spawn = DateTime.Parse(Str(primary, "spawnObservedAt"), null, System.Globalization.DateTimeStyles.RoundtripKind), closed = DateTime.Parse(Str(primary, "closeObservedAt"), null, System.Globalization.DateTimeStyles.RoundtripKind);
        Require(spawn.Kind == DateTimeKind.Utc && closed.Kind == DateTimeKind.Utc && spawn <= closed, "PRIMARY_CLOSE_TIME");
    }
    static void AppendPrimaryClose(Dictionary<string, object> request) {
        Keys(request, "protocol", "purpose", "root", "recoveryId", "closeToken", "primary");
        string recoveryId = Str(request, "recoveryId"), token = Str(request, "closeToken"); Guid parsed;
        Require(Guid.TryParseExact(recoveryId, "D", out parsed) && Digest(token), "PRIMARY_CLOSE_INPUT");
        var primary = request["primary"] as Dictionary<string, object>; Require(primary != null, "PRIMARY_CLOSE_INPUT");
        ApprovedSources = new [] { Str(primary, "candidateSourceSha256") };
        string failed = Path.Combine(Root, Failed), directory = Path.Combine(failed, recoveryId), home = Path.Combine(Root, "fz3b-host-finalization-v1");
        using (var parent = Open(failed, true, false, true)) using (var anchor = Open(directory, true, false, true)) using (var homeHandle = Open(home, true, false, true)) using (var source = Open(Path.Combine(directory, "source.intent.json"), false, false, true)) {
            Security(parent, true); Security(anchor, true); var audit = (SortedDictionary<string, object>)ValidateOne(directory, false, false);
            var observation = ReadObject(Encoding.UTF8.GetString(ReadAudit(directory, "observation.json", 131072)));
            byte[] sealBytes = ReadAudit(directory, "native-seal.bin", 131072);
            var seal = ReadObject(Encoding.UTF8.GetString(ProtectedData.Unprotect(sealBytes, Entropy, DataProtectionScope.CurrentUser)));
            Require(Str(seal, "closeTokenSha256") == Sha(Encoding.UTF8.GetBytes(token)), "PRIMARY_CLOSE_CAPABILITY");
            AssertPrimaryClose(primary, observation, audit);
            Require(Str(primary, "primaryTerminalSha256") == Hash(Obj("audit", audit, "closeToken", token, "protocol", Protocol, "status", "isolated")), "PRIMARY_TERMINAL_BINDING");
            Require(PrefixInventory().Length == 0 && Hash(Metadata(homeHandle, true)) == Str(observation, "homeMetadataSha256") && Hash(Metadata(source, false)) == Str(observation, "sourceMetadataSha256"), "PRIMARY_CLOSE_LIVE_STATE"); EmptyHome(home);
            byte[] payload = Bytes(Obj("audit", audit, "method", "main-observed-primary-close-only", "primary", Sorted(primary), "rootIdentitySha256", Str(observation, "rootIdentitySha256"), "schemaVersion", 1, "sid", Sid));
            WriteNew(directory, "primary-close.bin", ProtectedData.Protect(payload, CloseEntropy, DataProtectionScope.CurrentUser));
            Emit(Obj("audit", ValidateOne(directory), "protocol", Protocol, "status", "primary-close-recorded"));
        }
    }
    static object ValidateAll() {
        string failed = Path.Combine(Root, Failed); var results = new List<object>();
        Require(Entries(Root, 256).Where(x => x.StartsWith("fz3b-host-failed-", StringComparison.Ordinal)).All(x => x == Failed), "UNKNOWN_FAILED_NAMESPACE");
        uint attrs = GetFileAttributes(NativePath(failed)); int error = Marshal.GetLastWin32Error();
        if (attrs == UInt32.MaxValue) { Require(error == 2 || error == 3, "FAILED_CONTAINER_ACCESS"); return results; }
        using (var parent = Open(failed, true, false, true)) {
            Security(parent, true);
            foreach (string name in Entries(failed, 8)) {
                Guid parsed; Require(Guid.TryParseExact(name, "D", out parsed) && parsed.ToString("D") == name, "RECOVERY_NAME");
                using (var child = Open(Path.Combine(failed, name), true, false, true)) { Security(child, true); results.Add(ValidateOne(Path.Combine(failed, name))); }
            }
        } return results;
    }
    static void Isolate(Dictionary<string, object> request) {
        Keys(request, "protocol", "purpose", "root", "runId", "proofSha256", "targetSha256", "completeChainSha256", "failureEvidenceSha256", "candidateSourceSha256", "currentOwnedOperationsSha256", "primaryExecutableSha256", "expiresAt");
        Require(Str(request, "protocol") == Protocol && Str(request, "purpose") == Purpose, "PURPOSE");
        foreach (string field in new [] { "proofSha256", "targetSha256", "completeChainSha256", "failureEvidenceSha256", "candidateSourceSha256", "currentOwnedOperationsSha256", "primaryExecutableSha256" }) Require(Digest(Str(request, field)), "DIGEST");
        ApprovedSources = new [] { Str(request, "candidateSourceSha256") };
        Guid run; Require(Guid.TryParseExact(Str(request, "runId"), "D", out run), "RUN");
        DateTime created = DateTime.UtcNow, expires = DateTime.Parse(Str(request, "expiresAt"), null, System.Globalization.DateTimeStyles.RoundtripKind).ToUniversalTime();
        Require(expires > created && expires <= created.AddMinutes(5), "EXPIRY");
        ValidateAll(); string[] inventory = PrefixInventory();
        Require(inventory.Length == 1 && Regex.IsMatch(inventory[0], "^fz3b-host-empty-[a-f0-9]{64}\\.intent\\.json$"), "EXACT_SINGLE_ORPHAN_REQUIRED");
        string sourceName = inventory[0], nonce = sourceName.Substring(16, 64), sourcePath = Path.Combine(Root, sourceName), home = Path.Combine(Root, "fz3b-host-finalization-v1");
        Action absentCompanions = delegate { Absent(Path.Combine(Root, "fz3b-host-empty-" + nonce + ".verified.json")); Absent(Path.Combine(Root, "fz3b-host-quarantine-" + nonce)); };
        using (var source = Open(sourcePath, false, true, true)) using (var homeHandle = Open(home, true, false, true)) {
            absentCompanions(); EmptyHome(home);
            string sourceMetadata = Hash(Metadata(source, false)), homeMetadata = Hash(Metadata(homeHandle, true)), rootIdentity = Hash(RootIdentity());
            // Root metadata excludes directory times/size; its identity and security stay stable as audit children are created.
            string challenge = Guid.NewGuid().ToString("D"), recoveryId = Guid.NewGuid().ToString("D");
            var observation = Obj("candidateSourceSha256", Str(request, "candidateSourceSha256"), "challenge", challenge, "currentOwnedOperationsSha256", Str(request, "currentOwnedOperationsSha256"),
                "completeChainSha256", Str(request, "completeChainSha256"), "expiresAt", Str(request, "expiresAt"), "failureEvidenceSha256", Str(request, "failureEvidenceSha256"),
                "homeMetadataSha256", homeMetadata, "origin", Origin, "primaryExecutableSha256", Str(request, "primaryExecutableSha256"), "primaryNativePid", System.Diagnostics.Process.GetCurrentProcess().Id, "proofSha256", Str(request, "proofSha256"), "protocol", Protocol, "purpose", Purpose,
                "recoveryId", recoveryId, "root", Root, "rootIdentitySha256", rootIdentity, "runId", Str(request, "runId"), "sid", Sid,
                "sourceChangeTime", ChangeTime(source), "sourceMetadata", Metadata(source, false), "sourceMetadataSha256", sourceMetadata, "sourceName", sourceName, "targetSha256", Str(request, "targetSha256"));
            byte[] observationBytes = Bytes(observation); string observationHash = Sha(observationBytes);
            Emit(Obj("challenge", challenge, "observation", observation, "observationSha256", observationHash, "protocol", Protocol, "status", "observed"));
            var commit = ReadObject(Console.ReadLine()); Keys(commit, "protocol", "purpose", "challenge", "observationSha256", "proofSha256", "currentOwnedOperationsSha256");
            Require(Str(commit, "protocol") == Protocol && Str(commit, "purpose") == Purpose && Str(commit, "challenge") == challenge && Str(commit, "observationSha256") == observationHash && Str(commit, "proofSha256") == Str(request, "proofSha256") && Str(commit, "currentOwnedOperationsSha256") == Str(request, "currentOwnedOperationsSha256") && DateTime.UtcNow >= created && DateTime.UtcNow < expires, "FRESH_MAIN_PROOF");
            string detail = "Purpose: " + Purpose + "\r\nOrigin: " + Origin + "\r\nRun: " + run + "\r\nRoot: " + Root + "\r\nSource: " + sourceName + "\r\nSource metadata SHA256: " + sourceMetadata + "\r\nHome identity SHA256: " + homeMetadata + "\r\nProof SHA256: " + Str(request, "proofSha256") + "\r\nFailure evidence SHA256: " + Str(request, "failureEvidenceSha256") + "\r\nCandidate source SHA256: " + Str(request, "candidateSourceSha256") + "\r\nExpires: " + expires.ToString("O") + "\r\nDestination: " + Failed + "\\" + recoveryId + "\\source.intent.json\r\n\r\nPreserve this exact zero-byte object. Its original creator is unproved. Do not interpret the filename, matching timeout report, or empty hash as provenance.\r\nNo canonical-home move, lock removal, certificate, finish, retry, SSH, device operation, Boot adoption or old authorization replay. Unknown history remains held. This authorization is consumed for one move only.";
            if (!Confirm(detail, created, expires)) { Emit(Obj("protocol", Protocol, "status", "declined")); return; }
            var authorization = Obj("acceptedAt", DateTime.UtcNow.ToString("O"), "decision", "native-checkbox-accepted", "observationSha256", observationHash, "origin", Origin, "purpose", Purpose);
            byte[] tokenBytes = new byte[32]; using (var rng = RandomNumberGenerator.Create()) rng.GetBytes(tokenBytes);
            string closeToken = BitConverter.ToString(tokenBytes).Replace("-", "").ToLowerInvariant();
            // Revalidate real proof/owner and current owned-operation exclusion; no old child-close history is invented.
            Emit(Obj("challenge", challenge, "observationSha256", observationHash, "protocol", Protocol, "status", "consent-captured"));
            var after = ReadObject(Console.ReadLine()); Keys(after, "protocol", "purpose", "challenge", "observationSha256", "proofSha256", "currentOwnedOperationsSha256");
            Require(Str(after, "protocol") == Protocol && Str(after, "purpose") == Purpose && Str(after, "challenge") == challenge && Str(after, "observationSha256") == observationHash && Str(after, "proofSha256") == Str(request, "proofSha256") && Str(after, "currentOwnedOperationsSha256") == Str(request, "currentOwnedOperationsSha256") && DateTime.UtcNow >= created && DateTime.UtcNow < expires, "FRESH_POST_DIALOG_PROOF");
            Action recheck = delegate {
                Require(DateTime.UtcNow >= created && DateTime.UtcNow < expires && PrefixInventory().SequenceEqual(inventory) && Hash(Metadata(source, false)) == sourceMetadata && Hash(Metadata(homeHandle, true)) == homeMetadata && Hash(RootIdentity()) == rootIdentity && ChangeTime(source) == (string)observation["sourceChangeTime"], "OBSERVATION_CHANGED_OR_EXPIRED");
                using (var named = Open(sourcePath, false, false, true, true)) Require(Hash(Metadata(named, false)) == sourceMetadata, "NAMED_SOURCE_CHANGED");
                absentCompanions(); EmptyHome(home);
            };
            recheck(); string failed = Path.Combine(Root, Failed);
            uint attrs = GetFileAttributes(NativePath(failed)); int missing = Marshal.GetLastWin32Error();
            if (attrs == UInt32.MaxValue) { Require(missing == 2 || missing == 3, "FAILED_CONTAINER_ACCESS"); CreatePrivateDirectory(failed); }
            using (var failedHandle = Open(failed, true, false, true)) {
                Security(failedHandle, true); string directory = Path.Combine(failed, recoveryId); CreatePrivateDirectory(directory);
                using (var destination = Open(directory, true, false, true)) {
                    Security(destination, true); Require((string)Metadata(destination, true)["volumeId"] == (string)Metadata(source, false)["volumeId"], "CROSS_VOLUME");
                    WriteNew(directory, "observation.json", observationBytes); byte[] authBytes = Bytes(authorization); WriteNew(directory, "authorization.json", authBytes);
                    byte[] consumed = Bytes(Obj("authorizationSha256", Sha(authBytes), "consumedAt", DateTime.UtcNow.ToString("O"), "purpose", Purpose)); WriteNew(directory, "consumed.json", consumed);
                    byte[] prepared = Bytes(Obj("consumedSha256", Sha(consumed), "destination", Failed + "/" + recoveryId + "/source.intent.json", "observationSha256", observationHash, "purpose", Purpose)); WriteNew(directory, "prepared.json", prepared);
                    recheck(); Absent(Path.Combine(directory, "source.intent.json")); RenameRelative(source, destination);
                    Absent(sourcePath); absentCompanions(); EmptyHome(home);
                    Require(PrefixInventory().Length == 0 && Hash(Metadata(source, false)) == sourceMetadata && Hash(Metadata(homeHandle, true)) == homeMetadata, "POSTCHECK");
                    using (var preserved = Open(Path.Combine(directory, "source.intent.json"), false, false, true, true)) Require(Hash(Metadata(preserved, false)) == sourceMetadata, "POSTCHECK_NAMED_IDENTITY");
                    string preservedChangeTime = ChangeTime(source);
                    WriteNew(directory, "completed.json", Bytes(Obj("completedAt", DateTime.UtcNow.ToString("O"), "homeMetadataSha256", homeMetadata, "observationSha256", observationHash, "preparedSha256", Sha(prepared), "preservedChangeTime", preservedChangeTime, "preservedMetadataSha256", sourceMetadata, "purpose", Purpose, "recoveryId", recoveryId, "sourceNameAbsent", sourceName)));
                    var hashes = new SortedDictionary<string, object>(StringComparer.Ordinal); foreach (string name in AuditNames) hashes.Add(name, Sha(ReadAudit(directory, name, 131072)));
                    WriteNew(directory, "native-seal.bin", ProtectedData.Protect(Bytes(Obj("auditSha256", hashes, "closeTokenSha256", Sha(Encoding.UTF8.GetBytes(closeToken)), "protocol", Protocol, "sid", Sid)), Entropy, DataProtectionScope.CurrentUser));
                    object validated = ValidateOne(directory, true, false);
                    // No audit I/O follows these final live checks before publishing this transaction's result.
                    FailedEmptyIntentFinalLiveChecks.Assert(delegate { Absent(sourcePath); }, absentCompanions, delegate { EmptyHome(home); }, delegate {
                        return PrefixInventory().Length == 0 && Hash(RootIdentity()) == rootIdentity && Hash(Metadata(homeHandle, true)) == homeMetadata && Hash(Metadata(source, false)) == sourceMetadata && ChangeTime(source) == preservedChangeTime && DateTime.UtcNow >= created && DateTime.UtcNow < expires;
                    });
                    Emit(Obj("audit", validated, "closeToken", closeToken, "protocol", Protocol, "status", "isolated"));
                }
            }
        }
    }
    [STAThread] static int Main(string[] args) {
        try {
            AppContext.SetSwitch("Switch.System.IO.UseLegacyPathHandling", false);
            AppContext.SetSwitch("Switch.System.IO.BlockLongPaths", false);
            Require(args.Length == 0, "NO_ARGUMENTS"); var request = ReadObject(Console.ReadLine());
            Require(Str(request, "protocol") == Protocol, "PROTOCOL"); AnchorRoot(Str(request, "root"));
            if (Str(request, "purpose") == "validate-failed-empty-intent-isolation-only") {
                Keys(request, "protocol", "purpose", "root", "approvedIsolationSourceSha256s");
                object rawSources; Require(request.TryGetValue("approvedIsolationSourceSha256s", out rawSources) && rawSources is object[], "SOURCE_POLICY_REQUIRED");
                object[] values = (object[])rawSources; Require(values.Length > 0 && values.Length <= 8 && values.All(value => value is string && Digest((string)value)), "SOURCE_POLICY_REQUIRED");
                ApprovedSources = values.Cast<string>().ToArray(); Require(ApprovedSources.Distinct().Count() == ApprovedSources.Length, "SOURCE_POLICY_DUPLICATE");
                Emit(Obj("audits", ValidateAll(), "protocol", Protocol, "status", "validated"));
            } else if (Str(request, "purpose") == "append-main-observed-primary-close-only") AppendPrimaryClose(request);
            else Isolate(request);
            return 0;
        } catch (Exception error) {
            var native = error as Win32Exception;
            Emit(Obj("error", error.GetType().Name, "message", error.Message.StartsWith("FZ3B_FAILED_EMPTY_INTENT_", StringComparison.Ordinal) ? error.Message : "FZ3B_FAILED_EMPTY_INTENT_NATIVE_FAILED", "nativeCode", native == null ? 0 : native.NativeErrorCode, "protocol", Protocol, "status", "held")); return 2;
        }
        finally { for (int i = Anchors.Count - 1; i >= 0; i--) Anchors[i].Dispose(); }
    }
}
