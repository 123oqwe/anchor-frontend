import { useState, useEffect } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  FolderKanban, Plus, Minus, ChevronRight, MoreHorizontal,
  CheckCircle2, Circle, Clock, Tag, GripVertical, Trash2,
  Edit3, Search, Bot, Loader2,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { api } from "@/lib/api";

interface Task {
  id: string; title: string; status: "todo" | "in-progress" | "done" | "blocked";
  priority: "high" | "medium" | "low"; tags: string[]; due_date?: string; subtasks?: Task[];
}
interface Project { id: string; name: string; description: string; color: string; tasks: Task[]; created_at: string; }

const statusConfig = {
  "todo":        { icon: Circle,       color: "text-muted-foreground", label: "To Do" },
  "in-progress": { icon: Clock,        color: "text-blue-400",         label: "In Progress" },
  "done":        { icon: CheckCircle2, color: "text-emerald-400",      label: "Done" },
  "blocked":     { icon: Circle,       color: "text-red-400",          label: "Blocked" },
};
const priorityConfig = {
  high:   "border-red-500/30 text-red-400 bg-red-500/5",
  medium: "border-amber-500/30 text-amber-400 bg-amber-500/5",
  low:    "border-muted-foreground/30 text-muted-foreground bg-muted/5",
};

function TaskItem({ task, depth = 0, onStatusChange }: { task: Task; depth?: number; onStatusChange: (id: string, status: string) => void }) {
  const [expanded, setExpanded] = useState(false);
  const [status, setStatus] = useState(task.status);
  const StatusIcon = statusConfig[status].icon;

  const cycleStatus = () => {
    const order: Task["status"][] = ["todo", "in-progress", "done", "blocked"];
    const next = order[(order.indexOf(status) + 1) % order.length];
    setStatus(next);
    onStatusChange(task.id, next);
  };

  return (
    <div>
      <div className={`group flex items-center gap-2 py-2 px-3 rounded-lg hover:bg-white/[0.03] transition-colors ${depth > 0 ? "ml-6" : ""}`}>
        <GripVertical className="h-3 w-3 text-muted-foreground/30 opacity-0 group-hover:opacity-100 transition-opacity cursor-grab shrink-0" />
        {task.subtasks && task.subtasks.length > 0 ? (
          <button onClick={() => setExpanded(!expanded)} className="shrink-0">
            <motion.div animate={{ rotate: expanded ? 90 : 0 }} transition={{ duration: 0.15 }}>
              <ChevronRight className="h-3 w-3 text-muted-foreground" />
            </motion.div>
          </button>
        ) : <div className="w-3" />}
        <button onClick={cycleStatus} className="shrink-0">
          <StatusIcon className={`h-4 w-4 ${statusConfig[status].color} transition-colors`} />
        </button>
        <span className={`flex-1 text-sm ${status === "done" ? "line-through text-muted-foreground" : "text-foreground"}`}>{task.title}</span>
        <div className="flex items-center gap-2 opacity-0 group-hover:opacity-100 transition-opacity">
          {task.tags.map(tag => <Badge key={tag} variant="outline" className="text-[9px] border-border/50 text-muted-foreground py-0">{tag}</Badge>)}
        </div>
        <Badge variant="outline" className={`text-[9px] shrink-0 ${priorityConfig[task.priority]}`}>{task.priority}</Badge>
        {task.due_date && <span className={`text-[10px] font-mono shrink-0 ${task.due_date === "Overdue" ? "text-red-400" : "text-muted-foreground"}`}>{task.due_date}</span>}
      </div>
      <AnimatePresence>
        {expanded && task.subtasks && (
          <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={{ duration: 0.2 }} className="overflow-hidden">
            {task.subtasks.map(sub => <TaskItem key={sub.id} task={sub} depth={depth + 1} onStatusChange={onStatusChange} />)}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

export default function Workspace() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [activeProject, setActiveProject] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [showNewProject, setShowNewProject] = useState(false);
  const [newProjectName, setNewProjectName] = useState("");
  const [newTaskTitle, setNewTaskTitle] = useState("");
  const [loading, setLoading] = useState(true);
  const [agentStats, setAgentStats] = useState<any>(null);

  const load = async () => {
    const [projs, agents] = await Promise.all([api.getProjects(), api.getAgentStatus()]);
    setProjects(projs);
    setAgentStats(agents.find((a: any) => a.name === "Workspace Agent"));
    setLoading(false);
  };

  useEffect(() => { load(); }, []);

  const selectedProject = projects.find(p => p.id === activeProject);

  const handleCreateProject = async () => {
    if (!newProjectName.trim()) return;
    const colors = ["bg-blue-500", "bg-emerald-500", "bg-purple-500", "bg-amber-500", "bg-rose-500"];
    const color = colors[Math.floor(Math.random() * colors.length)];
    const { id } = await api.createProject({ name: newProjectName, description: "", color });
    await load();
    setNewProjectName("");
    setShowNewProject(false);
    setActiveProject(id);
  };

  const handleDeleteProject = async (id: string) => {
    await api.deleteProject(id);
    if (activeProject === id) setActiveProject(null);
    setProjects(prev => prev.filter(p => p.id !== id));
  };

  const handleAddTask = async () => {
    if (!newTaskTitle.trim() || !activeProject) return;
    await api.createTask(activeProject, { title: newTaskTitle, status: "todo", priority: "medium", tags: [] });
    setNewTaskTitle("");
    const updated = await api.getProjects();
    setProjects(updated);
  };

  const handleStatusChange = async (taskId: string, status: string) => {
    await api.patchTaskStatus(taskId, status);
  };

  const filteredProjects = projects.filter(p => !searchQuery || p.name.toLowerCase().includes(searchQuery.toLowerCase()));

  if (loading) return <div className="min-h-screen flex items-center justify-center"><Loader2 className="h-6 w-6 animate-spin text-primary" /></div>;

  return (
    <div className="min-h-screen dot-grid">
      <div className="px-8 pt-8 pb-6">
        <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }}>
          <div className="flex items-center gap-2 mb-4">
            <FolderKanban className="h-4 w-4 text-primary" />
            <span className="text-xs font-medium text-primary tracking-wider uppercase">Workspace</span>
          </div>
          <div className="flex items-center justify-between">
            <div>
              <h1 className="text-3xl font-bold tracking-tight mb-2">Projects</h1>
              <p className="text-sm text-muted-foreground">Organize your goals into projects.</p>
              {agentStats && (
                <div className="flex items-center gap-2 text-[10px] mt-2">
                  <Bot className="h-3 w-3 text-primary" />
                  <span className="text-muted-foreground">Workspace Agent</span>
                  <Plus className="h-2 w-2 text-emerald-400" /><span className="text-emerald-400">{agentStats.successes}</span>
                  <Minus className="h-2 w-2 text-red-400" /><span className="text-red-400">{agentStats.failures}</span>
                  <span className="text-muted-foreground">exec</span>
                </div>
              )}
            </div>
            <button onClick={() => setShowNewProject(true)} className="glass rounded-xl px-4 py-2 text-xs text-muted-foreground hover:text-foreground transition-colors flex items-center gap-1.5">
              <Plus className="h-3.5 w-3.5" />New Project
            </button>
          </div>
        </motion.div>
      </div>

      <div className="px-8 pb-8">
        {/* Search */}
        <div className="mb-4 glass rounded-xl flex items-center gap-3 px-4 focus-within:border-primary/30 transition-colors">
          <Search className="h-4 w-4 text-muted-foreground shrink-0" />
          <input type="text" value={searchQuery} onChange={e => setSearchQuery(e.target.value)}
            placeholder="Search projects..." className="flex-1 bg-transparent py-3 text-sm text-foreground placeholder:text-muted-foreground/60 focus:outline-none" />
        </div>

        {/* New project form */}
        <AnimatePresence>
          {showNewProject && (
            <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0 }} className="overflow-hidden mb-4">
              <div className="glass rounded-xl p-4 flex gap-2">
                <input type="text" value={newProjectName} onChange={e => setNewProjectName(e.target.value)}
                  onKeyDown={e => e.key === "Enter" && handleCreateProject()}
                  placeholder="Project name..." autoFocus
                  className="flex-1 bg-transparent text-sm text-foreground placeholder:text-muted-foreground/60 focus:outline-none" />
                <button onClick={handleCreateProject} className="text-xs text-primary hover:text-primary/80 transition-colors">Create</button>
                <button onClick={() => setShowNewProject(false)} className="text-xs text-muted-foreground hover:text-foreground transition-colors">Cancel</button>
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
          {/* Project list */}
          <div className="space-y-2">
            {filteredProjects.map((p, i) => {
              const done = p.tasks?.filter(t => t.status === "done").length ?? 0;
              const total = p.tasks?.length ?? 0;
              return (
                <motion.div key={p.id} initial={{ opacity: 0, x: -10 }} animate={{ opacity: 1, x: 0 }} transition={{ delay: i * 0.05 }}
                  onClick={() => setActiveProject(p.id === activeProject ? null : p.id)}
                  className={`glass rounded-xl p-4 cursor-pointer group transition-all hover:bg-white/[0.07] ${p.id === activeProject ? "border-primary/30" : ""}`}
                  style={{ borderWidth: "1px" }}>
                  <div className="flex items-center gap-3 mb-2">
                    <div className={`w-2.5 h-2.5 rounded-full shrink-0 ${p.color}`} />
                    <span className="text-sm font-medium text-foreground flex-1 truncate">{p.name}</span>
                    <button onClick={e => { e.stopPropagation(); handleDeleteProject(p.id); }}
                      className="opacity-0 group-hover:opacity-100 transition-opacity text-muted-foreground hover:text-red-400">
                      <Trash2 className="h-3 w-3" />
                    </button>
                  </div>
                  {p.description && <p className="text-xs text-muted-foreground mb-2 truncate">{p.description}</p>}
                  <div className="flex items-center gap-2">
                    <div className="flex-1 h-1 rounded-full bg-white/5 overflow-hidden">
                      <div className="h-full bg-primary/40 rounded-full" style={{ width: total > 0 ? `${(done / total) * 100}%` : "0%" }} />
                    </div>
                    <span className="text-[10px] text-muted-foreground font-mono">{done}/{total}</span>
                  </div>
                </motion.div>
              );
            })}
            {filteredProjects.length === 0 && <div className="text-center py-8 text-muted-foreground text-sm">No projects yet</div>}
          </div>

          {/* Task detail */}
          <div className="lg:col-span-2">
            <AnimatePresence mode="wait">
              {selectedProject ? (
                <motion.div key={selectedProject.id} initial={{ opacity: 0, x: 20 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0 }} className="glass rounded-xl overflow-hidden">
                  <div className="p-5 border-b border-border/50">
                    <div className="flex items-center gap-3">
                      <div className={`w-3 h-3 rounded-full ${selectedProject.color}`} />
                      <h2 className="text-base font-semibold text-foreground flex-1">{selectedProject.name}</h2>
                      <span className="text-xs text-muted-foreground">{selectedProject.tasks?.filter(t => t.status === "done").length ?? 0} / {selectedProject.tasks?.length ?? 0} done</span>
                    </div>
                    {selectedProject.description && <p className="text-xs text-muted-foreground mt-1 ml-6">{selectedProject.description}</p>}
                  </div>

                  <div className="p-3">
                    {selectedProject.tasks?.filter((t: any) => !t.parent_id).map((task: any) => (
                      <TaskItem key={task.id} task={task} onStatusChange={handleStatusChange} />
                    ))}

                    {/* Add task */}
                    <div className="mt-2 flex items-center gap-2 px-3 py-2">
                      <Plus className="h-3.5 w-3.5 text-muted-foreground/50 shrink-0" />
                      <input type="text" value={newTaskTitle} onChange={e => setNewTaskTitle(e.target.value)}
                        onKeyDown={e => e.key === "Enter" && handleAddTask()}
                        placeholder="Add a task..." className="flex-1 bg-transparent text-sm text-foreground placeholder:text-muted-foreground/40 focus:outline-none" />
                      {newTaskTitle && (
                        <button onClick={handleAddTask} className="text-[10px] text-primary hover:text-primary/80 transition-colors">Add</button>
                      )}
                    </div>
                  </div>
                </motion.div>
              ) : (
                <motion.div key="empty" initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="glass rounded-xl p-12 flex items-center justify-center">
                  <div className="text-center">
                    <FolderKanban className="h-8 w-8 text-muted-foreground/30 mx-auto mb-3" />
                    <p className="text-sm text-muted-foreground">Select a project to view tasks</p>
                  </div>
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        </div>
      </div>
    </div>
  );
}
