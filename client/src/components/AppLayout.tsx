import { useState, type ReactNode } from "react";
import { useLocation, Link } from "wouter";
import { motion, AnimatePresence } from "framer-motion";
import {
  LayoutDashboard,
  MessageCircle,
  Users,
  Bot,
  Brain,
  FolderKanban,
  Settings,
  ChevronLeft,
  ChevronRight,
  Command,
  Anchor,
} from "lucide-react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

const navItems = [
  { path: "/dashboard", label: "Dashboard", icon: LayoutDashboard, description: "Human Graph & State" },
  { path: "/advisor", label: "Advisor", icon: MessageCircle, description: "Decision Conversations" },
  { path: "/twin", label: "Twin Agent", icon: Users, description: "Your Digital Twin" },
  { path: "/agents", label: "Agents", icon: Bot, description: "Custom Agents & Automations" },
  { path: "/memory", label: "Memory", icon: Brain, description: "Knowledge & Records" },
  { path: "/workspace", label: "Workspace", icon: FolderKanban, description: "Projects & Tasks" },
  { path: "/settings", label: "Settings", icon: Settings, description: "Preferences" },
];

export default function AppLayout({ children }: { children: ReactNode }) {
  const [collapsed, setCollapsed] = useState(false);
  const [location] = useLocation();

  return (
    <div className="flex h-screen overflow-hidden bg-background">
      {/* Sidebar */}
      <motion.aside
        initial={false}
        animate={{ width: collapsed ? 72 : 260 }}
        transition={{ duration: 0.3, ease: [0.25, 0.1, 0.25, 1] }}
        className="relative flex flex-col border-r border-border/50 bg-sidebar"
      >
        {/* Logo area */}
        <div className="flex h-16 items-center gap-3 px-5 border-b border-border/50">
          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-primary/10">
            <Anchor className="h-4 w-4 text-primary" />
          </div>
          <AnimatePresence>
            {!collapsed && (
              <motion.div
                initial={{ opacity: 0, x: -10 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: -10 }}
                transition={{ duration: 0.2 }}
                className="flex flex-col overflow-hidden"
              >
                <span className="text-sm font-semibold tracking-tight text-foreground">Anchor</span>
                <span className="text-[10px] font-medium text-muted-foreground tracking-widest uppercase">Decision OS</span>
              </motion.div>
            )}
          </AnimatePresence>
        </div>

        {/* Navigation */}
        <nav className="flex-1 overflow-y-auto py-4 px-3 custom-scrollbar">
          <div className="space-y-1">
            {navItems.map((item) => {
              const isActive = item.path === "/dashboard" ? location === "/dashboard" : location.startsWith(item.path);
              const Icon = item.icon;
              return (
                <Tooltip key={item.path} delayDuration={collapsed ? 0 : 1000}>
                  <TooltipTrigger asChild>
                    <Link href={item.path}>
                      <motion.div
                        className={`
                          group relative flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition-colors
                          ${isActive
                            ? "bg-primary/10 text-primary"
                            : "text-muted-foreground hover:bg-accent hover:text-foreground"
                          }
                        `}
                        whileHover={{ x: 2 }}
                        transition={{ duration: 0.15 }}
                      >
                        {isActive && (
                          <motion.div
                            layoutId="activeNav"
                            className="absolute left-0 top-1/2 -translate-y-1/2 w-[3px] h-5 rounded-full bg-primary"
                            transition={{ type: "spring", stiffness: 300, damping: 30 }}
                          />
                        )}
                        <Icon className={`h-[18px] w-[18px] shrink-0 ${isActive ? "text-primary" : ""}`} />
                        <AnimatePresence>
                          {!collapsed && (
                            <motion.span
                              initial={{ opacity: 0 }}
                              animate={{ opacity: 1 }}
                              exit={{ opacity: 0 }}
                              transition={{ duration: 0.15 }}
                              className="truncate"
                            >
                              {item.label}
                            </motion.span>
                          )}
                        </AnimatePresence>
                      </motion.div>
                    </Link>
                  </TooltipTrigger>
                  {collapsed && (
                    <TooltipContent side="right" sideOffset={8}>
                      <p className="font-medium">{item.label}</p>
                      <p className="text-xs text-muted-foreground">{item.description}</p>
                    </TooltipContent>
                  )}
                </Tooltip>
              );
            })}
          </div>
        </nav>

        {/* Quick Command hint */}
        <div className="px-3 pb-3">
          <AnimatePresence>
            {!collapsed && (
              <motion.div
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                className="flex items-center gap-2 rounded-lg px-3 py-2 text-xs text-muted-foreground glass"
              >
                <Command className="h-3 w-3" />
                <span>Press</span>
                <kbd className="rounded bg-muted px-1.5 py-0.5 text-[10px] font-mono font-medium">⌘K</kbd>
                <span>for commands</span>
              </motion.div>
            )}
          </AnimatePresence>
        </div>

        {/* Collapse toggle */}
        <button
          onClick={() => setCollapsed(!collapsed)}
          className="absolute -right-3 top-20 z-10 flex h-6 w-6 items-center justify-center rounded-full border border-border bg-card text-muted-foreground shadow-sm hover:text-foreground hover:bg-accent transition-colors"
        >
          {collapsed ? <ChevronRight className="h-3 w-3" /> : <ChevronLeft className="h-3 w-3" />}
        </button>
      </motion.aside>

      {/* Main content */}
      <main className="flex-1 overflow-y-auto custom-scrollbar">
        {children}
      </main>
    </div>
  );
}
