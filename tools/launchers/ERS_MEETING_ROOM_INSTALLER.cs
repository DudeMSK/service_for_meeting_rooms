using System;
using System.Diagnostics;

// Настоящий Windows-исполняемый файл (EXE), заменяющий BUILD_INSTALLER.cmd.
// Прогоняет проверки и собирает NSIS-установщик (release\ERS_MEETING_ROOM_INSTALLER.exe).
class Program
{
    static int Main()
    {
        string dir = AppDomain.CurrentDomain.BaseDirectory;

        int code = RunCommand("npm install", dir);
        if (code != 0) return code;

        code = RunCommand("npm run check", dir);
        if (code != 0) return code;

        code = RunCommand("npm test", dir);
        if (code != 0) return code;

        return RunCommand("npm run dist", dir);
    }

    static int RunCommand(string command, string workingDirectory)
    {
        var psi = new ProcessStartInfo("cmd.exe", "/c " + command)
        {
            WorkingDirectory = workingDirectory,
            UseShellExecute = false,
        };
        using (var process = Process.Start(psi))
        {
            process.WaitForExit();
            return process.ExitCode;
        }
    }
}
