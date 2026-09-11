using System;
using System.Diagnostics;
using System.IO;

// Настоящий Windows-исполняемый файл (EXE), заменяющий START_APP.cmd.
// Запускает приложение из исходников для разработки/проверки (npm start),
// а не является основным пользовательским запуском (для этого — установленное приложение и ярлык).
class Program
{
    static int Main()
    {
        string dir = AppDomain.CurrentDomain.BaseDirectory;
        string electronExe = Path.Combine(dir, "node_modules", "electron", "dist", "electron.exe");

        if (!File.Exists(electronExe))
        {
            int installCode = RunCommand("npm install", dir);
            if (installCode != 0)
            {
                return installCode;
            }
        }

        return RunCommand("npm start", dir);
    }

    static int RunCommand(string command, string workingDirectory)
    {
        var psi = new ProcessStartInfo("cmd.exe", "/c " + command)
        {
            WorkingDirectory = workingDirectory,
            UseShellExecute = false,
            CreateNoWindow = true,
            WindowStyle = ProcessWindowStyle.Hidden,
        };
        using (var process = Process.Start(psi))
        {
            process.WaitForExit();
            return process.ExitCode;
        }
    }
}
