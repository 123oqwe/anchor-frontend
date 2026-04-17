/**
 * L7 — Command Palette (Cmd+K).
 * Global quick-access to pages, graph nodes, memories, and actions.
 * Inspired by Linear/Raycast/Spotlight.
 */
import { useState, useEffect } from "react";
import { Command, CommandInput, CommandList, CommandEmpty, CommandGroup, CommandItem } from "@/components/ui/command";
import { useLocation } from "wouter";
import {
  LayoutDashboard, MessageCircle, Users, Brain,
  FolderKanban, Settings, Cpu, Search, Zap,
} from "lucide-react";

const PAGES = [
  { name: "Dashboard", path: "/dashboard", icon: LayoutDashboard, group: "Navigate" },
  { name: "Advisor", path: "/advisor", icon: MessageCircle, group: "Navigate" },
  { name: "Twin Agent", path: "/twin", icon: Users, group: "Navigate" },
  { name: "Memory", path: "/memory", icon: Brain, group: "Navigate" },
  { name: "Workspace", path: "/workspace", icon: FolderKanban, group: "Navigate" },
  { name: "Settings", path: "/settings", icon: Settings, group: "Navigate" },
  { name: "Admin — Cortex", path: "/admin", icon: Cpu, group: "Admin" },
  { name: "Admin — Costs", path: "/admin/costs", icon: Zap, group: "Admin" },
  { name: "Admin — Logs", path: "/admin/logs", icon: Search, group: "Admin" },
];

export default function CommandPalette() {
  const [open, setOpen] = useState(false);
  const [, navigate] = useLocation();

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        setOpen(o => !o);
      }
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center pt-[20vh]">
      <div className="fixed inset-0 bg-black/50 backdrop-blur-sm" onClick={() => setOpen(false)} />
      <div className="relative w-full max-w-lg">
        <Command className="glass-strong rounded-xl border border-border/50 shadow-2xl overflow-hidden">
          <CommandInput placeholder="Search pages, actions..." className="border-b border-border/30" />
          <CommandList className="max-h-[300px]">
            <CommandEmpty>No results.</CommandEmpty>
            <CommandGroup heading="Navigate">
              {PAGES.filter(p => p.group === "Navigate").map(page => {
                const Icon = page.icon;
                return (
                  <CommandItem key={page.path} onSelect={() => { navigate(page.path); setOpen(false); }}
                    className="flex items-center gap-3 px-3 py-2 cursor-pointer">
                    <Icon className="h-4 w-4 text-muted-foreground" />
                    <span>{page.name}</span>
                  </CommandItem>
                );
              })}
            </CommandGroup>
            <CommandGroup heading="Admin">
              {PAGES.filter(p => p.group === "Admin").map(page => {
                const Icon = page.icon;
                return (
                  <CommandItem key={page.path} onSelect={() => { navigate(page.path); setOpen(false); }}
                    className="flex items-center gap-3 px-3 py-2 cursor-pointer">
                    <Icon className="h-4 w-4 text-amber-400" />
                    <span>{page.name}</span>
                  </CommandItem>
                );
              })}
            </CommandGroup>
          </CommandList>
        </Command>
      </div>
    </div>
  );
}
