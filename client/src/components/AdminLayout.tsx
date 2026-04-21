import { type ReactNode } from "react";
import { useLocation, Link } from "wouter";
import {
  Cpu, Activity, Database, ArrowLeft, Terminal,
  DollarSign, Zap, Network, Brain, HeartPulse, Route as RouteIcon, ListTodo, Webhook, Share2,
} from "lucide-react";

const adminNav = [
  { path: "/admin", label: "Cortex", icon: Cpu, group: "AI Layer" },
  { path: "/admin/costs", label: "Costs", icon: DollarSign, group: "AI Layer" },
  { path: "/admin/performance", label: "Performance", icon: Zap, group: "AI Layer" },
  { path: "/admin/logs", label: "Logs", icon: Activity, group: "AI Layer" },
  { path: "/admin/runs", label: "Run Traces", icon: RouteIcon, group: "AI Layer" },
  { path: "/admin/jobs", label: "Jobs", icon: ListTodo, group: "AI Layer" },
  { path: "/admin/missions", label: "Missions", icon: Share2, group: "AI Layer" },
  { path: "/admin/hooks", label: "Hooks", icon: Webhook, group: "AI Layer" },
  { path: "/admin/bridges-advanced", label: "Hand Bridge", icon: Zap, group: "AI Layer" },
  { path: "/admin/health", label: "System Health", icon: HeartPulse, group: "AI Layer" },
  { path: "/admin/graph", label: "Human Graph", icon: Network, group: "Data Layer" },
  { path: "/admin/memory", label: "Memory & Twin", icon: Brain, group: "Data Layer" },
  { path: "/admin/data", label: "Tables", icon: Database, group: "Data Layer" },
];

export default function AdminLayout({ children }: { children: ReactNode }) {
  const [location] = useLocation();

  // Group nav items
  const grouped = adminNav.reduce((acc, item) => {
    if (!acc[item.group]) acc[item.group] = [];
    acc[item.group].push(item);
    return acc;
  }, {} as Record<string, typeof adminNav>);

  return (
    <div className="flex h-screen overflow-hidden bg-background">
      <aside className="w-60 flex flex-col border-r border-border/50 bg-sidebar">
        <div className="flex items-center gap-3 h-16 px-4 border-b border-border/50">
          <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-amber-500/10">
            <Terminal className="h-3.5 w-3.5 text-amber-400" />
          </div>
          <div>
            <span className="text-sm font-semibold text-foreground">Admin</span>
            <span className="block text-[9px] text-amber-400 font-mono uppercase tracking-widest">Dev Console</span>
          </div>
        </div>

        <nav className="flex-1 py-4 px-3 space-y-4 overflow-y-auto custom-scrollbar">
          {Object.entries(grouped).map(([group, items]) => (
            <div key={group}>
              <div className="text-[9px] font-semibold text-muted-foreground/60 tracking-widest uppercase px-3 mb-1.5">{group}</div>
              <div className="space-y-0.5">
                {items.map(item => {
                  const isActive = item.path === "/admin"
                    ? location === "/admin"
                    : location === item.path;
                  const Icon = item.icon;
                  return (
                    <Link key={item.path} href={item.path}>
                      <div className={`flex items-center gap-2.5 rounded-md px-3 py-2 text-xs font-medium transition-colors
                        ${isActive ? "bg-amber-500/10 text-amber-400" : "text-muted-foreground hover:bg-accent hover:text-foreground"}`}>
                        <Icon className={`h-3.5 w-3.5 shrink-0 ${isActive ? "text-amber-400" : ""}`} />
                        <span>{item.label}</span>
                      </div>
                    </Link>
                  );
                })}
              </div>
            </div>
          ))}
        </nav>

        <div className="px-3 pb-4 border-t border-border/30 pt-3">
          <Link href="/dashboard">
            <div className="flex items-center gap-2 rounded-md px-3 py-2 text-xs text-muted-foreground hover:text-foreground hover:bg-accent transition-colors">
              <ArrowLeft className="h-3 w-3" />
              Back to Anchor
            </div>
          </Link>
        </div>
      </aside>

      <main className="flex-1 overflow-y-auto custom-scrollbar">
        {children}
      </main>
    </div>
  );
}
