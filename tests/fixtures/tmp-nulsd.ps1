Add-Type @"
using System; using System.Runtime.InteropServices;
public static class N {
 [DllImport("kernel32.dll",SetLastError=true,CharSet=CharSet.Unicode)] public static extern IntPtr CreateFileW(string n,uint a,uint s,IntPtr sa,uint c,uint f,IntPtr t);
 [DllImport("advapi32.dll")] public static extern uint GetSecurityInfo(IntPtr h,int t,uint i,IntPtr o,IntPtr g,IntPtr d,IntPtr s,out IntPtr sd);
 [DllImport("advapi32.dll",CharSet=CharSet.Unicode)] public static extern bool ConvertSecurityDescriptorToStringSecurityDescriptorW(IntPtr sd,uint r,uint i,out IntPtr s,IntPtr l);
 public static string Sd(){ IntPtr h=CreateFileW("\\\\.\\NUL",0x20000,7,IntPtr.Zero,3,0,IntPtr.Zero); IntPtr sd; uint e=GetSecurityInfo(h,6,0x14,IntPtr.Zero,IntPtr.Zero,IntPtr.Zero,IntPtr.Zero,out sd); if(e!=0) return "err "+e; IntPtr s; ConvertSecurityDescriptorToStringSecurityDescriptorW(sd,1,0x14,out s,IntPtr.Zero); return Marshal.PtrToStringUni(s);} }
"@
(Get-CimInstance Win32_OperatingSystem).Caption + " " + [Environment]::OSVersion.Version
"NUL SD: " + [N]::Sd()
