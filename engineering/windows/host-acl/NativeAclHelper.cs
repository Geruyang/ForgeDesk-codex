using System;
using System.Collections.Generic;
using System.IO;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Text;
using System.Text.RegularExpressions;

// Output-only prototype. No shell, child process, owner mutation, or resident mode.
internal static class NativeAclHelper
{
    private const int MaxFrame = 32768;
    private const int MaxBatch = 51;
    private const int MaxBatchJson = 24576;
    private const int MaxOutput = 4096;
    private static readonly byte[] Magic = Encoding.ASCII.GetBytes("FZ3B-ACL-v1\0");
    private static readonly UTF8Encoding Utf8 = new UTF8Encoding(false, true);
    private static readonly Regex SidPattern = new Regex(@"\AS-1-5-(?:[0-9]+-)*[0-9]+\z", RegexOptions.CultureInvariant);

    private sealed class InputError : Exception { }
    private sealed class PolicyError : Exception { }
    private sealed class Request
    {
        internal byte Operation;
        internal string Sid;
        internal string[] Paths;
    }

    private sealed class Cursor
    {
        private readonly byte[] bytes;
        private int position;
        internal Cursor(byte[] value) { bytes = value; }
        internal byte Byte() { if (position >= bytes.Length) throw new InputError(); return bytes[position++]; }
        internal int U16() { return (Byte() << 8) | Byte(); }
        internal int U32()
        {
            uint value = ((uint)Byte() << 24) | ((uint)Byte() << 16) | ((uint)Byte() << 8) | Byte();
            if (value > MaxFrame) throw new InputError();
            return (int)value;
        }
        internal string Text(int count)
        {
            if (count < 0 || count > bytes.Length - position) throw new InputError();
            string value;
            try { value = Utf8.GetString(bytes, position, count); }
            catch (DecoderFallbackException) { throw new InputError(); }
            position += count;
            return value;
        }
        internal void End() { if (position != bytes.Length) throw new InputError(); }
    }

    private static Request ReadRequest(Stream input)
    {
        // Read through actual EOF before any file/ACL operation; extra bytes fail closed.
        byte[] buffer = new byte[MaxFrame + 1];
        int used = 0;
        while (used < buffer.Length)
        {
            int count = input.Read(buffer, used, buffer.Length - used);
            if (count == 0) break;
            used += count;
        }
        if (used > MaxFrame) throw new InputError();
        byte[] bytes = new byte[used];
        Buffer.BlockCopy(buffer, 0, bytes, 0, used);
        Cursor cursor = new Cursor(bytes);
        foreach (byte expected in Magic) if (cursor.Byte() != expected) throw new InputError();
        Request request = new Request();
        request.Operation = cursor.Byte();
        if (request.Operation > 4) throw new InputError();
        int sidLength = cursor.U16();
        if (sidLength > 256) throw new InputError();
        request.Sid = cursor.Text(sidLength);
        int countPaths = cursor.U16();
        if (request.Operation == 0)
        {
            if (sidLength != 0 || countPaths != 0) throw new InputError();
        }
        else
        {
            if (!SidPattern.IsMatch(request.Sid) || countPaths < 1 || countPaths > MaxBatch ||
                (request.Operation != 3 && countPaths != 1)) throw new InputError();
        }
        request.Paths = new string[countPaths];
        HashSet<string> unique = new HashSet<string>(StringComparer.Ordinal);
        for (int i = 0; i < countPaths; i++)
        {
            string path = cursor.Text(cursor.U32());
            if (!AbsoluteWindowsPath(path) || !unique.Add(path)) throw new InputError();
            request.Paths[i] = path;
        }
        cursor.End();
        if (request.Operation == 3 && Utf8.GetByteCount(PathArrayJson(request.Paths)) > MaxBatchJson) throw new InputError();
        return request;
    }

    private static bool AbsoluteWindowsPath(string path)
    {
        if (String.IsNullOrEmpty(path) || path.IndexOf('\0') >= 0) return false;
        // Matches node:path.win32.isAbsolute; rejects drive-relative C:foo.
        if (path[0] == '/' || path[0] == '\\') return true;
        return path.Length >= 3 && ((path[0] >= 'A' && path[0] <= 'Z') || (path[0] >= 'a' && path[0] <= 'z')) &&
            path[1] == ':' && (path[2] == '/' || path[2] == '\\');
    }

    private static string Quote(string value)
    {
        StringBuilder result = new StringBuilder("\"");
        foreach (char c in value)
        {
            switch (c)
            {
                case '"': result.Append("\\\""); break;
                case '\\': result.Append("\\\\"); break;
                case '\b': result.Append("\\b"); break;
                case '\f': result.Append("\\f"); break;
                case '\n': result.Append("\\n"); break;
                case '\r': result.Append("\\r"); break;
                case '\t': result.Append("\\t"); break;
                default:
                    if (c < 32) result.Append("\\u" + ((int)c).ToString("x4"));
                    else result.Append(c);
                    break;
            }
        }
        return result.Append('"').ToString();
    }

    private static string PathArrayJson(string[] paths)
    {
        StringBuilder result = new StringBuilder("[");
        for (int i = 0; i < paths.Length; i++) { if (i != 0) result.Append(','); result.Append(Quote(paths[i])); }
        return result.Append(']').ToString();
    }

    private static FileSystemSecurity ReadAcl(string path)
    {
        FileAttributes attributes = File.GetAttributes(path);
        if ((attributes & FileAttributes.ReparsePoint) != 0) throw new PolicyError();
        AccessControlSections sections = AccessControlSections.Owner | AccessControlSections.Access;
        if ((attributes & FileAttributes.Directory) != 0) return Directory.GetAccessControl(path, sections);
        return File.GetAccessControl(path, sections);
    }

    private static void AssertPrivate(FileSystemSecurity acl, SecurityIdentifier sid)
    {
        if (!acl.AreAccessRulesProtected || acl.GetOwner(typeof(SecurityIdentifier)).Value != sid.Value) throw new PolicyError();
        AuthorizationRuleCollection rules = acl.GetAccessRules(true, true, typeof(SecurityIdentifier));
        if (rules.Count != 1) throw new PolicyError();
        foreach (FileSystemAccessRule rule in rules)
        {
            if (rule.IdentityReference.Value != sid.Value || rule.AccessControlType != AccessControlType.Allow ||
                rule.IsInherited || rule.FileSystemRights != FileSystemRights.FullControl) throw new PolicyError();
        }
    }

    private static void PrivateAcl(string path, SecurityIdentifier sid, bool update)
    {
        FileSystemSecurity acl = ReadAcl(path);
        if (update)
        {
            // Refuse foreign ownership. No SetOwner/take-ownership operation is available.
            if (acl.GetOwner(typeof(SecurityIdentifier)).Value != sid.Value) throw new PolicyError();
            bool directory = acl is DirectorySecurity;
            FileSystemSecurity replacement = directory ? (FileSystemSecurity)new DirectorySecurity() : new FileSecurity();
            replacement.SetAccessRuleProtection(true, false);
            replacement.AddAccessRule(new FileSystemAccessRule(sid, FileSystemRights.FullControl, AccessControlType.Allow));
            if (directory) Directory.SetAccessControl(path, (DirectorySecurity)replacement);
            else File.SetAccessControl(path, (FileSecurity)replacement);
            acl = ReadAcl(path);
        }
        AssertPrivate(acl, sid);
    }

    private static string DependencyAcl(string root, string expectedSid)
    {
        string[] paths = { root, Path.Combine(root, "fz3b-agent"), Path.Combine(root, "fz3b-agent", "binding.key") };
        HashSet<string> allowed = new HashSet<string>(StringComparer.Ordinal) { expectedSid, "S-1-5-18", "S-1-5-32-544" };
        StringBuilder json = new StringBuilder("[");
        for (int i = 0; i < paths.Length; i++)
        {
            FileSystemSecurity acl = ReadAcl(paths[i]);
            string owner = acl.GetOwner(typeof(SecurityIdentifier)).Value;
            AuthorizationRuleCollection rules = acl.GetAccessRules(true, true, typeof(SecurityIdentifier));
            if (owner != expectedSid || (i == 0 && !acl.AreAccessRulesProtected) || rules.Count < 1 || rules.Count > 32) throw new PolicyError();
            if (i != 0) json.Append(',');
            json.Append("{\"owner\":").Append(Quote(owner)).Append(",\"protected\":").Append(Bool(acl.AreAccessRulesProtected)).Append(",\"rules\":[");
            bool fullEffectiveOwner = false;
            bool first = true;
            foreach (FileSystemAccessRule rule in rules)
            {
                string principal = rule.IdentityReference.Value;
                bool allow = rule.AccessControlType == AccessControlType.Allow;
                bool full = (rule.FileSystemRights & FileSystemRights.FullControl) == FileSystemRights.FullControl;
                bool effective = (rule.PropagationFlags & PropagationFlags.InheritOnly) == 0;
                if (!allowed.Contains(principal) || !allow) throw new PolicyError();
                if (principal == expectedSid && full && effective) fullEffectiveOwner = true;
                if (!first) json.Append(',');
                first = false;
                json.Append("{\"sid\":").Append(Quote(principal)).Append(",\"allow\":").Append(Bool(allow))
                    .Append(",\"fullControl\":").Append(Bool(full)).Append(",\"effective\":").Append(Bool(effective)).Append('}');
            }
            if (!fullEffectiveOwner) throw new PolicyError();
            json.Append("]}");
        }
        return json.Append(']').ToString();
    }

    private static string Bool(bool value) { return value ? "true" : "false"; }

    private static void Output(string value)
    {
        byte[] bytes = Utf8.GetBytes(value + "\n");
        if (bytes.Length > MaxOutput) throw new PolicyError();
        Stream output = Console.OpenStandardOutput();
        output.Write(bytes, 0, bytes.Length);
        output.Flush();
    }

    private static int Main(string[] args)
    {
        try
        {
            if (args.Length != 0) throw new InputError();
            Request request = ReadRequest(Console.OpenStandardInput());
            if (request.Operation == 0) { Output("FZ3B_ACL_HELPER_READY"); return 0; }
            if (Environment.OSVersion.Platform != PlatformID.Win32NT || IntPtr.Size != 8) throw new PolicyError();
            SecurityIdentifier sid;
            try { sid = new SecurityIdentifier(request.Sid); }
            catch (ArgumentException) { throw new InputError(); }
            if (request.Operation == 1 || request.Operation == 2)
            {
                PrivateAcl(request.Paths[0], sid, request.Operation == 2);
                Output("FZ3B_PRIVATE_ACL_OK");
            }
            else if (request.Operation == 3)
            {
                foreach (string path in request.Paths) PrivateAcl(path, sid, false);
                Output("FZ3B_PRIVATE_ACL_BATCH_OK");
            }
            else Output(DependencyAcl(request.Paths[0], request.Sid));
            return 0;
        }
        catch (InputError) { Console.Error.WriteLine("FZ3B_ACL_INPUT_REJECTED"); return 64; }
        catch (PolicyError) { Console.Error.WriteLine("FZ3B_ACL_POLICY_REJECTED"); return 77; }
        catch (Exception) { Console.Error.WriteLine("FZ3B_ACL_OPERATION_FAILED"); return 74; }
    }
}
