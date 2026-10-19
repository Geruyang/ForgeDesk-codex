using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;

internal static class ProcessHost
{
    private const uint CREATE_SUSPENDED = 0x00000004;
    private const uint CREATE_NO_WINDOW = 0x08000000;
    private const uint STARTF_USESHOWWINDOW = 0x00000001;
    private const uint STARTF_USESTDHANDLES = 0x00000100;
    private const ushort SW_HIDE = 0;
    private const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000;
    private const int JobObjectExtendedLimitInformation = 9;
    private const uint SYNCHRONIZE = 0x00100000;
    private const uint DUPLICATE_SAME_ACCESS = 0x00000002;
    private const uint INFINITE = 0xffffffff;
    private const uint WAIT_OBJECT_0 = 0;
    private const uint STD_INPUT_HANDLE = unchecked((uint)-10);
    private const uint STD_OUTPUT_HANDLE = unchecked((uint)-11);
    private const uint STD_ERROR_HANDLE = unchecked((uint)-12);

    [StructLayout(LayoutKind.Sequential)]
    private struct PROCESS_BASIC_INFORMATION
    {
        public IntPtr ExitStatus;
        public IntPtr PebBaseAddress;
        public IntPtr AffinityMask;
        public IntPtr BasePriority;
        public IntPtr UniqueProcessId;
        public IntPtr InheritedFromUniqueProcessId;
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct STARTUPINFO
    {
        public int cb;
        public string lpReserved;
        public string lpDesktop;
        public string lpTitle;
        public int dwX;
        public int dwY;
        public int dwXSize;
        public int dwYSize;
        public int dwXCountChars;
        public int dwYCountChars;
        public int dwFillAttribute;
        public uint dwFlags;
        public ushort wShowWindow;
        public ushort cbReserved2;
        public IntPtr lpReserved2;
        public IntPtr hStdInput;
        public IntPtr hStdOutput;
        public IntPtr hStdError;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct PROCESS_INFORMATION
    {
        public IntPtr hProcess;
        public IntPtr hThread;
        public uint dwProcessId;
        public uint dwThreadId;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct JOBOBJECT_BASIC_LIMIT_INFORMATION
    {
        public long PerProcessUserTimeLimit;
        public long PerJobUserTimeLimit;
        public uint LimitFlags;
        public UIntPtr MinimumWorkingSetSize;
        public UIntPtr MaximumWorkingSetSize;
        public uint ActiveProcessLimit;
        public UIntPtr Affinity;
        public uint PriorityClass;
        public uint SchedulingClass;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct IO_COUNTERS
    {
        public ulong ReadOperationCount;
        public ulong WriteOperationCount;
        public ulong OtherOperationCount;
        public ulong ReadTransferCount;
        public ulong WriteTransferCount;
        public ulong OtherTransferCount;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION
    {
        public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation;
        public IO_COUNTERS IoInfo;
        public UIntPtr ProcessMemoryLimit;
        public UIntPtr JobMemoryLimit;
        public UIntPtr PeakProcessMemoryUsed;
        public UIntPtr PeakJobMemoryUsed;
    }

    [DllImport("ntdll.dll")]
    private static extern int NtQueryInformationProcess(IntPtr process, int informationClass, out PROCESS_BASIC_INFORMATION information, int informationLength, out int returnLength);

    [DllImport("kernel32.dll")]
    private static extern IntPtr GetCurrentProcess();

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr OpenProcess(uint desiredAccess, bool inheritHandle, uint processId);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr GetStdHandle(uint handle);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool DuplicateHandle(IntPtr sourceProcess, IntPtr sourceHandle, IntPtr targetProcess, out IntPtr targetHandle, uint desiredAccess, bool inheritHandle, uint options);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr CreateJobObject(IntPtr attributes, string name);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool SetInformationJobObject(IntPtr job, int informationClass, ref JOBOBJECT_EXTENDED_LIMIT_INFORMATION information, int informationLength);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool CreateProcess(string applicationName, StringBuilder commandLine, IntPtr processAttributes, IntPtr threadAttributes, bool inheritHandles, uint creationFlags, IntPtr environment, string currentDirectory, ref STARTUPINFO startupInfo, out PROCESS_INFORMATION processInformation);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern uint ResumeThread(IntPtr thread);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool TerminateProcess(IntPtr process, uint exitCode);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern uint WaitForMultipleObjects(uint count, IntPtr[] handles, bool waitAll, uint milliseconds);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool GetExitCodeProcess(IntPtr process, out uint exitCode);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool CloseHandle(IntPtr handle);

    private static bool Invalid(IntPtr handle)
    {
        return handle == IntPtr.Zero || handle == new IntPtr(-1);
    }

    private static IntPtr InheritableStdHandle(uint kind)
    {
        IntPtr original = GetStdHandle(kind);
        IntPtr duplicate;
        if (Invalid(original) || !DuplicateHandle(GetCurrentProcess(), original, GetCurrentProcess(), out duplicate, 0, true, DUPLICATE_SAME_ACCESS))
            throw new InvalidOperationException("Standard handle unavailable");
        return duplicate;
    }

    private static string Quote(string argument)
    {
        if (argument.Length > 0 && argument.IndexOfAny(new char[] { ' ', '\t', '\n', '\v', '"' }) < 0)
            return argument;
        StringBuilder result = new StringBuilder("\"");
        int slashes = 0;
        foreach (char character in argument)
        {
            if (character == '\\')
            {
                slashes++;
            }
            else if (character == '"')
            {
                result.Append('\\', slashes * 2 + 1);
                result.Append('"');
                slashes = 0;
            }
            else
            {
                result.Append('\\', slashes);
                result.Append(character);
                slashes = 0;
            }
        }
        result.Append('\\', slashes * 2);
        result.Append('"');
        return result.ToString();
    }

    private static int Run(string[] args)
    {
        if (args.Length < 2 || args[0] != "--" || !Path.IsPathRooted(args[1]) || !File.Exists(args[1]))
        {
            Console.Error.WriteLine("process-host: expected -- <absolute executable> [args]");
            return 64;
        }

        PROCESS_BASIC_INFORMATION basic;
        int returned;
        if (NtQueryInformationProcess(GetCurrentProcess(), 0, out basic, Marshal.SizeOf(typeof(PROCESS_BASIC_INFORMATION)), out returned) != 0)
        {
            Console.Error.WriteLine("process-host: parent query failed");
            return 70;
        }
        IntPtr parent = OpenProcess(SYNCHRONIZE, false, unchecked((uint)basic.InheritedFromUniqueProcessId.ToInt64()));
        if (Invalid(parent))
        {
            Console.Error.WriteLine("process-host: parent unavailable");
            return 70;
        }

        IntPtr job = IntPtr.Zero;
        IntPtr stdin = IntPtr.Zero;
        IntPtr stdout = IntPtr.Zero;
        IntPtr stderr = IntPtr.Zero;
        PROCESS_INFORMATION child = new PROCESS_INFORMATION();
        bool resumed = false;
        try
        {
            job = CreateJobObject(IntPtr.Zero, null);
            if (Invalid(job)) throw new InvalidOperationException("Job creation failed");
            JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
            limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            if (!SetInformationJobObject(job, JobObjectExtendedLimitInformation, ref limits, Marshal.SizeOf(typeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION))))
                throw new InvalidOperationException("Job setup failed");

            stdin = InheritableStdHandle(STD_INPUT_HANDLE);
            stdout = InheritableStdHandle(STD_OUTPUT_HANDLE);
            stderr = InheritableStdHandle(STD_ERROR_HANDLE);
            STARTUPINFO startup = new STARTUPINFO();
            startup.cb = Marshal.SizeOf(typeof(STARTUPINFO));
            startup.dwFlags = STARTF_USESHOWWINDOW | STARTF_USESTDHANDLES;
            startup.wShowWindow = SW_HIDE;
            startup.hStdInput = stdin;
            startup.hStdOutput = stdout;
            startup.hStdError = stderr;

            StringBuilder command = new StringBuilder(Quote(args[1]));
            for (int i = 2; i < args.Length; i++) command.Append(' ').Append(Quote(args[i]));
            if (!CreateProcess(args[1], command, IntPtr.Zero, IntPtr.Zero, true, CREATE_SUSPENDED | CREATE_NO_WINDOW, IntPtr.Zero, null, ref startup, out child))
                throw new InvalidOperationException("Child creation failed");
            if (!AssignProcessToJobObject(job, child.hProcess)) throw new InvalidOperationException("Job assignment failed");
            if (ResumeThread(child.hThread) == 0xffffffff) throw new InvalidOperationException("Child resume failed");
            resumed = true;

            uint wait = WaitForMultipleObjects(2, new IntPtr[] { child.hProcess, parent }, false, INFINITE);
            if (wait == WAIT_OBJECT_0)
            {
                uint code;
                if (!GetExitCodeProcess(child.hProcess, out code)) throw new InvalidOperationException("Child exit query failed");
                return unchecked((int)code);
            }
            if (wait == WAIT_OBJECT_0 + 1)
            {
                CloseHandle(job);
                job = IntPtr.Zero;
                WaitForSingleObject(child.hProcess, INFINITE);
                return 125;
            }
            throw new InvalidOperationException("Wait failed");
        }
        catch (Exception)
        {
            Console.Error.WriteLine("process-host: setup or wait failed");
            return 70;
        }
        finally
        {
            if (!resumed && !Invalid(child.hProcess))
            {
                TerminateProcess(child.hProcess, 70);
                WaitForSingleObject(child.hProcess, INFINITE);
            }
            if (!Invalid(job)) CloseHandle(job);
            if (!Invalid(child.hThread)) CloseHandle(child.hThread);
            if (!Invalid(child.hProcess)) CloseHandle(child.hProcess);
            if (!Invalid(stdin)) CloseHandle(stdin);
            if (!Invalid(stdout)) CloseHandle(stdout);
            if (!Invalid(stderr)) CloseHandle(stderr);
            CloseHandle(parent);
        }
    }

    private static int Main(string[] args)
    {
        return Run(args);
    }
}
