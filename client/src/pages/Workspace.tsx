import { useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  FolderKanban,
  Plus,
  ChevronRight,
  ChevronDown,
  MoreHorizontal,
  CheckCircle2,
  Circle,
  Clock,
  Tag,
  GripVertical,
  Trash2,
  Edit3,
  ArrowRight,
  Search,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";

interface Task {
  id: string;
  title: string;
  status: "todo" | "in-progress" | "done" | "blocked";
  priority: "high" | "medium" | "low";
  tags: string[];
  dueDate?: string;
  subtasks?: Task[];
}

interface Project {
  id: string;
  name: string;
  description: string;
  color: string;
  tasks: Task[];
  createdAt: string;
}

const initialProjects: Project[] = [
  {
    id: "p1",
    name: "YC Application",
    description: "Complete and submit Y Combinator W26 application",
    color: "bg-blue-500",
    createdAt: "2 weeks ago",
    tasks: [
      {
        id: "t1",
        title: "Refine 'Why Now' section",
        status: "in-progress",
        priority: "high",
        tags: ["writing", "deadline"],
        dueDate: "Tomorrow",
        subtasks: [
          { id: "t1a", title: "Research market timing data", status: "done", priority: "medium", tags: [] },
          { id: "t1b", title: "Draft behavioral insight angle", status: "in-progress", priority: "high", tags: [] },
          { id: "t1c", title: "Get co-founder review", status: "todo", priority: "medium", tags: [] },
        ],
      },
      {
        id: "t2",
        title: "Record 1-minute founder video",
        status: "todo",
        priority: "medium",
        tags: ["video", "creative"],
        dueDate: "Friday",
      },
      {
        id: "t3",
        title: "Finalize team section",
        status: "done",
        priority: "low",
        tags: ["writing"],
      },
      {
        id: "t4",
        title: "Technical architecture appendix",
        status: "todo",
        priority: "medium",
        tags: ["technical"],
        dueDate: "Thursday",
      },
    ],
  },
  {
    id: "p2",
    name: "CTO Hiring Pipeline",
    description: "Find and onboard a technical co-founder / CTO",
    color: "bg-emerald-500",
    createdAt: "1 month ago",
    tasks: [
      {
        id: "t5",
        title: "Schedule intro call with Alex Rivera",
        status: "in-progress",
        priority: "high",
        tags: ["hiring", "urgent"],
        dueDate: "Thursday",
      },
      {
        id: "t6",
        title: "Review 2 other candidate profiles",
        status: "todo",
        priority: "medium",
        tags: ["hiring"],
      },
      {
        id: "t7",
        title: "Prepare technical assessment criteria",
        status: "done",
        priority: "medium",
        tags: ["hiring", "technical"],
      },
    ],
  },
  {
    id: "p3",
    name: "Fundraising — Pre-Seed",
    description: "Raise $500K pre-seed round for Anchor",
    color: "bg-purple-500",
    createdAt: "3 weeks ago",
    tasks: [
      {
        id: "t8",
        title: "Follow up with Sarah Chen (Sequoia Scout)",
        status: "blocked",
        priority: "high",
        tags: ["investor", "follow-up"],
        dueDate: "Overdue",
      },
      {
        id: "t9",
        title: "Prepare technical architecture doc",
        status: "todo",
        priority: "high",
        tags: ["technical", "investor"],
        dueDate: "Next week",
      },
      {
        id: "t10",
        title: "Update pitch deck with latest metrics",
        status: "todo",
        priority: "medium",
        tags: ["pitch", "metrics"],
      },
    ],
  },
];

const statusConfig = {
  "todo": { icon: Circle, color: "text-muted-foreground", label: "To Do" },
  "in-progress": { icon: Clock, color: "text-blue-400", label: "In Progress" },
  "done": { icon: CheckCircle2, color: "text-emerald-400", label: "Done" },
  "blocked": { icon: Circle, color: "text-red-400", label: "Blocked" },
};

const priorityConfig = {
  high: "border-red-500/30 text-red-400 bg-red-500/5",
  medium: "border-amber-500/30 text-amber-400 bg-amber-500/5",
  low: "border-muted-foreground/30 text-muted-foreground bg-muted/5",
};

function TaskItem({ task, depth = 0 }: { task: Task; depth?: number }) {
  const [expanded, setExpanded] = useState(false);
  const [status, setStatus] = useState(task.status);
  const StatusIcon = statusConfig[status].icon;

  const cycleStatus = () => {
    const order: Task["status"][] = ["todo", "in-progress", "done", "blocked"];
    const idx = order.indexOf(status);
    setStatus(order[(idx + 1) % order.length]);
  };

  return (
    <div>
      <div
        className={`group flex items-center gap-2 py-2 px-3 rounded-lg hover:bg-white/[0.03] transition-colors ${
          depth > 0 ? "ml-6" : ""
        }`}
      >
        <GripVertical className="h-3 w-3 text-muted-foreground/30 opacity-0 group-hover:opacity-100 transition-opacity cursor-grab shrink-0" />

        {task.subtasks && task.subtasks.length > 0 && (
          <button onClick={() => setExpanded(!expanded)} className="shrink-0">
            <motion.div animate={{ rotate: expanded ? 90 : 0 }} transition={{ duration: 0.15 }}>
              <ChevronRight className="h-3 w-3 text-muted-foreground" />
            </motion.div>
          </button>
        )}
        {(!task.subtasks || task.subtasks.length === 0) && <div className="w-3" />}

        <button onClick={cycleStatus} className="shrink-0">
          <StatusIcon className={`h-4 w-4 ${statusConfig[status].color} transition-colors`} />
        </button>

        <span className={`flex-1 text-sm ${status === "done" ? "line-through text-muted-foreground" : "text-foreground"}`}>
          {task.title}
        </span>

        <div className="flex items-center gap-2 opacity-0 group-hover:opacity-100 transition-opacity">
          {task.tags.map((tag) => (
            <Badge key={tag} variant="outline" className="text-[9px] border-border/50 text-muted-foreground py-0">
              {tag}
            </Badge>
          ))}
        </div>

        <Badge variant="outline" className={`text-[9px] shrink-0 ${priorityConfig[task.priority]}`}>
          {task.priority}
        </Badge>

        {task.dueDate && (
          <span className={`text-[10px] font-mono shrink-0 ${
            task.dueDate === "Overdue" ? "text-red-400" : "text-muted-foreground"
          }`}>
            {task.dueDate}
          </span>
        )}

        <button className="opacity-0 group-hover:opacity-100 transition-opacity">
          <MoreHorizontal className="h-3.5 w-3.5 text-muted-foreground hover:text-foreground" />
        </button>
      </div>

      <AnimatePresence>
        {expanded && task.subtasks && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2 }}
            className="overflow-hidden"
          >
            {task.subtasks.map((sub) => (
              <TaskItem key={sub.id} task={sub} depth={depth + 1} />
            ))}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

export default function Workspace() {
  const [projects, setProjects] = useState(initialProjects);
  const [activeProject, setActiveProject] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [showNewProject, setShowNewProject] = useState(false);
  const [newProjectName, setNewProjectName] = useState("");

  const selectedProject = projects.find((p) => p.id === activeProject);

  const handleCreateProject = () => {
    if (!newProjectName.trim()) return;
    const colors = ["bg-blue-500", "bg-emerald-500", "bg-purple-500", "bg-amber-500", "bg-rose-500"];
    const newProject: Project = {
      id: `p${Date.now()}`,
      name: newProjectName,
      description: "",
      color: colors[Math.floor(Math.random() * colors.length)],
      tasks: [],
      createdAt: "Just now",
    };
    setProjects((prev) => [newProject, ...prev]);
    setNewProjectName("");
    setShowNewProject(false);
    setActiveProject(newProject.id);
  };

  return (
    <div className="min-h-screen dot-grid">
      {/* Header */}
      <div className="px-8 pt-8 pb-6">
        <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.6 }}>
          <div className="flex items-center gap-2 mb-4">
            <FolderKanban className="h-4 w-4 text-primary" />
            <span className="text-xs font-medium text-primary tracking-wider uppercase">Workspace</span>
          </div>
          <div className="flex items-center justify-between">
            <div>
              <h1 className="text-3xl font-bold tracking-tight mb-2">Projects</h1>
              <p className="text-sm text-muted-foreground">
                Organize your goals into projects. Each project is a collection of tasks that move you forward.
              </p>
            </div>
            <button
              onClick={() => setShowNewProject(true)}
              className="flex items-center gap-2 px-4 py-2 rounded-lg bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 transition-colors"
            >
              <Plus className="h-4 w-4" />
              New Project
            </button>
          </div>
        </motion.div>
      </div>

      <div className="px-8 pb-8">
        {/* New project input */}
        <AnimatePresence>
          {showNewProject && (
            <motion.div
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: "auto" }}
              exit={{ opacity: 0, height: 0 }}
              className="mb-6 overflow-hidden"
            >
              <div className="glass rounded-xl p-4 flex items-center gap-3">
                <input
                  type="text"
                  value={newProjectName}
                  onChange={(e) => setNewProjectName(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && handleCreateProject()}
                  placeholder="Project name..."
                  className="flex-1 bg-transparent text-sm text-foreground placeholder:text-muted-foreground/60 focus:outline-none"
                  autoFocus
                />
                <button
                  onClick={handleCreateProject}
                  className="px-3 py-1.5 rounded-lg bg-primary text-primary-foreground text-xs font-medium"
                >
                  Create
                </button>
                <button
                  onClick={() => setShowNewProject(false)}
                  className="px-3 py-1.5 rounded-lg text-xs text-muted-foreground hover:text-foreground"
                >
                  Cancel
                </button>
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        {activeProject && selectedProject ? (
          /* Project detail view */
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ duration: 0.3 }}
          >
            <button
              onClick={() => setActiveProject(null)}
              className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground mb-4 transition-colors"
            >
              <ArrowRight className="h-3 w-3 rotate-180" />
              Back to projects
            </button>

            <div className="glass rounded-xl overflow-hidden">
              <div className="p-5 border-b border-border/50">
                <div className="flex items-center gap-3 mb-2">
                  <div className={`w-3 h-3 rounded-full ${selectedProject.color}`} />
                  <h2 className="text-xl font-bold text-foreground">{selectedProject.name}</h2>
                </div>
                {selectedProject.description && (
                  <p className="text-sm text-muted-foreground pl-6">{selectedProject.description}</p>
                )}
                <div className="flex items-center gap-4 mt-3 pl-6 text-xs text-muted-foreground">
                  <span>{selectedProject.tasks.length} tasks</span>
                  <span>{selectedProject.tasks.filter((t) => t.status === "done").length} completed</span>
                  <span>Created {selectedProject.createdAt}</span>
                </div>
              </div>

              {/* Task list */}
              <div className="p-3">
                {selectedProject.tasks.map((task) => (
                  <TaskItem key={task.id} task={task} />
                ))}

                {/* Add task */}
                <button className="w-full flex items-center gap-2 py-2 px-3 rounded-lg text-sm text-muted-foreground hover:text-foreground hover:bg-white/[0.03] transition-colors mt-1">
                  <Plus className="h-4 w-4" />
                  Add task
                </button>
              </div>
            </div>
          </motion.div>
        ) : (
          /* Projects grid */
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {projects.map((project, i) => {
              const doneCount = project.tasks.filter((t) => t.status === "done").length;
              const totalCount = project.tasks.length;
              const progress = totalCount > 0 ? (doneCount / totalCount) * 100 : 0;

              return (
                <motion.div
                  key={project.id}
                  initial={{ opacity: 0, y: 15 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ duration: 0.4, delay: i * 0.05 }}
                  onClick={() => setActiveProject(project.id)}
                  className="glass rounded-xl p-5 cursor-pointer hover:bg-white/[0.07] transition-all group"
                >
                  <div className="flex items-start justify-between mb-3">
                    <div className="flex items-center gap-3">
                      <div className={`w-3 h-3 rounded-full ${project.color}`} />
                      <h3 className="text-sm font-semibold text-foreground">{project.name}</h3>
                    </div>
                    <ChevronRight className="h-4 w-4 text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity" />
                  </div>
                  {project.description && (
                    <p className="text-xs text-muted-foreground mb-3 line-clamp-2">{project.description}</p>
                  )}
                  <div className="flex items-center gap-3 text-xs text-muted-foreground mb-3">
                    <span>{totalCount} tasks</span>
                    <span>{doneCount} done</span>
                  </div>
                  <div className="h-1 rounded-full bg-white/5 overflow-hidden">
                    <motion.div
                      className={`h-full rounded-full ${project.color} opacity-60`}
                      initial={{ width: 0 }}
                      animate={{ width: `${progress}%` }}
                      transition={{ duration: 0.8, delay: 0.2 + i * 0.1 }}
                    />
                  </div>
                </motion.div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
