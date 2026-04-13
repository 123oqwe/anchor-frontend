import { Router } from "express";
import { db, DEFAULT_USER_ID } from "../db.js";
import { nanoid } from "nanoid";
import { bus } from "../events.js";

const router = Router();

function getTasks(projectId: string, parentId: string | null = null): any[] {
  const rows = db.prepare("SELECT * FROM tasks WHERE project_id=? AND parent_id IS ? ORDER BY created_at").all(projectId, parentId) as any[];
  return rows.map(r => ({
    ...r,
    tags: JSON.parse(r.tags),
    subtasks: getTasks(projectId, r.id),
  }));
}

router.get("/projects", (_req, res) => {
  const projects = db.prepare("SELECT * FROM projects WHERE user_id=? ORDER BY created_at").all(DEFAULT_USER_ID) as any[];
  const result = projects.map(p => ({ ...p, tasks: getTasks(p.id) }));
  res.json(result);
});

router.get("/projects/:id", (req, res) => {
  const p = db.prepare("SELECT * FROM projects WHERE id=? AND user_id=?").get(req.params.id, DEFAULT_USER_ID) as any;
  if (!p) return res.status(404).json({ error: "Not found" });
  res.json({ ...p, tasks: getTasks(p.id) });
});

router.post("/projects", (req, res) => {
  const { name, description, color } = req.body;
  const id = nanoid();
  db.prepare("INSERT INTO projects (id, user_id, name, description, color) VALUES (?,?,?,?,?)")
    .run(id, DEFAULT_USER_ID, name, description ?? "", color ?? "bg-blue-500");
  res.json({ id });
});

router.put("/projects/:id", (req, res) => {
  const { name, description, color } = req.body;
  db.prepare("UPDATE projects SET name=?, description=?, color=? WHERE id=? AND user_id=?")
    .run(name, description, color, req.params.id, DEFAULT_USER_ID);
  res.json({ ok: true });
});

router.delete("/projects/:id", (req, res) => {
  db.prepare("DELETE FROM projects WHERE id=? AND user_id=?").run(req.params.id, DEFAULT_USER_ID);
  res.json({ ok: true });
});

router.post("/projects/:id/tasks", (req, res) => {
  const { title, status, priority, tags, due_date, parent_id } = req.body;
  const id = nanoid();
  db.prepare("INSERT INTO tasks (id, project_id, parent_id, title, status, priority, tags, due_date) VALUES (?,?,?,?,?,?,?,?)")
    .run(id, req.params.id, parent_id ?? null, title, status ?? "todo", priority ?? "medium", JSON.stringify(tags ?? []), due_date ?? null);
  res.json({ id });
});

router.put("/tasks/:id", (req, res) => {
  const { title, status, priority, tags, due_date } = req.body;
  db.prepare("UPDATE tasks SET title=?, status=?, priority=?, tags=?, due_date=? WHERE id=?")
    .run(title, status, priority, JSON.stringify(tags ?? []), due_date ?? null, req.params.id);
  res.json({ ok: true });
});

router.patch("/tasks/:id/status", (req, res) => {
  const { status } = req.body;
  db.prepare("UPDATE tasks SET status=? WHERE id=?").run(status, req.params.id);

  if (status === "done") {
    const task = db.prepare("SELECT title FROM tasks WHERE id=?").get(req.params.id) as any;
    if (task) bus.publish({ type: "TASK_COMPLETED", payload: { taskId: req.params.id, title: task.title } });
  }

  res.json({ ok: true });
});

router.delete("/tasks/:id", (req, res) => {
  db.prepare("DELETE FROM tasks WHERE id=?").run(req.params.id);
  res.json({ ok: true });
});

router.post("/projects/merge", (req, res) => {
  const { source_ids, target_name, target_description, target_color } = req.body;
  const newId = nanoid();
  db.prepare("INSERT INTO projects (id, user_id, name, description, color) VALUES (?,?,?,?,?)")
    .run(newId, DEFAULT_USER_ID, target_name, target_description ?? "", target_color ?? "bg-blue-500");
  // Move tasks from source projects to new project
  for (const srcId of source_ids) {
    db.prepare("UPDATE tasks SET project_id=? WHERE project_id=?").run(newId, srcId);
    db.prepare("DELETE FROM projects WHERE id=? AND user_id=?").run(srcId, DEFAULT_USER_ID);
  }
  res.json({ id: newId });
});

export default router;
