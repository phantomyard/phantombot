using System;
using System.Diagnostics;
using System.ServiceProcess;
using System.Threading;
using System.Runtime.InteropServices;

public sealed class PhantombotServiceHost : ServiceBase
{
    private readonly string[] childArgs;
    private readonly object gate = new object();
    private Process child;
    private bool stopping;

    private PhantombotServiceHost(string[] args)
    {
        ServiceName = "Phantombot";
        CanStop = true;
        CanShutdown = true;
        childArgs = args;
    }

    protected override void OnStart(string[] args)
    {
        stopping = false;
        new Thread(Supervise) { IsBackground = true }.Start();
    }

    protected override void OnStop() { StopChild(); }
    protected override void OnShutdown() { StopChild(); }

    private void Supervise()
    {
        while (!stopping)
        {
            try
            {
                var psi = new ProcessStartInfo(childArgs[0], JoinArgs(childArgs, 1))
                {
                    UseShellExecute = false,
                    CreateNoWindow = true,
                    WorkingDirectory = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile)
                };
                var next = Process.Start(psi);
                lock (gate) child = next;
                next.WaitForExit();
                lock (gate) child = null;
            }
            catch { }
            if (!stopping) Thread.Sleep(1000);
        }
    }

    private void StopChild()
    {
        stopping = true;
        lock (gate)
        {
            if (child == null) return;
            try { Process.Start(new ProcessStartInfo("taskkill.exe", "/PID " + child.Id + " /T /F") { UseShellExecute = false, CreateNoWindow = true }).WaitForExit(5000); } catch { }
            try { child.Dispose(); } catch { }
            child = null;
        }
    }

    private static string JoinArgs(string[] args, int start)
    {
        string result = "";
        for (int i = start; i < args.Length; i++) result += (i == start ? "" : " ") + Quote(args[i]);
        return result;
    }
    private static string Quote(string value) { return "\"" + value.Replace("\\", "\\\\").Replace("\"", "\\\"") + "\""; }

    public static void Main(string[] args)
    {
        if (args.Length < 1) throw new ArgumentException("usage: phantombot-service.exe <phantombot.exe> run");
        ServiceBase.Run(new PhantombotServiceHost(args));
    }
}
