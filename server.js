const express = require("express");
const path = require("path");
const cron = require("node-cron");
const { spawn, execFile } = require("child_process");
const {
  ensureStore,
  getTasks,
  getTask,
  saveTask,
  deleteTask,
  appendRunLog,
  clearActiveRun,
} = require("./storage");

const app = express();
const PORT = process.env.PORT || 3000;
const scheduledJobs = new Map();
const activeProcesses = new Map();
const activeRunState = new Map();

ensureStore();

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

function normalizeTask(payload) {
  const now = new Date().toISOString();
  const runnerType = String(payload.runnerType || "python").trim();
  const commandPath = String(payload.commandPath || payload.pythonPath || "").trim();
  const task = {
    id: payload.id || `task_${Date.now()}`,
    name: String(payload.name || "").trim(),
    runnerType,
    commandPath,
    condaTarget: String(payload.condaTarget || "").trim(),
    scriptPath: String(payload.scriptPath || "").trim(),
    args: String(payload.args || "").trim(),
    timeArgName: String(payload.timeArgName || "").trim(),
    timeArgValue: String(payload.timeArgValue || "").trim(),
    workingDirectory: String(payload.workingDirectory || "").trim(),
    schedule: String(payload.schedule || "").trim(),
    enabled: Boolean(payload.enabled),
    createdAt: payload.createdAt || now,
    updatedAt: now,
    lastRunAt: payload.lastRunAt || null,
    lastStatus: payload.lastStatus || "never",
    logs: Array.isArray(payload.logs) ? payload.logs : [],
  };

  if (!task.name) {
    throw new Error("任务名称不能为空");
  }
  if (!["python", "conda-name", "conda-path"].includes(task.runnerType)) {
    throw new Error("执行方式无效");
  }
  if (task.runnerType === "python" && !task.commandPath) {
    throw new Error("Python 环境路径不能为空");
  }
  if (task.runnerType !== "python" && !task.condaTarget) {
    throw new Error(task.runnerType === "conda-name" ? "Conda 环境名不能为空" : "Conda 环境路径不能为空");
  }
  if (!task.scriptPath) {
    throw new Error("Python 脚本路径不能为空");
  }
  if (!task.schedule || !cron.validate(task.schedule)) {
    throw new Error("Cron 表达式无效");
  }

  return task;
}

function splitArgs(argsText) {
  if (!argsText) {
    return [];
  }

  const parts = [];
  const regex = /[^\s"]+|"([^"]*)"/g;
  let match;
  while ((match = regex.exec(argsText)) !== null) {
    parts.push(match[1] !== undefined ? match[1] : match[0]);
  }
  return parts;
}

function unscheduleTask(taskId) {
  const existing = scheduledJobs.get(taskId);
  if (existing) {
    existing.stop();
    scheduledJobs.delete(taskId);
  }
}

function scheduleTask(task) {
  unscheduleTask(task.id);
  if (!task.enabled) {
    return;
  }

  const job = cron.schedule(task.schedule, () => {
    runTask(task.id, "scheduled").catch((error) => {
      console.error(`Task ${task.id} failed:`, error);
    });
  });

  scheduledJobs.set(task.id, job);
}

function refreshSchedules() {
  for (const task of getTasks()) {
    scheduleTask(task);
  }
}

function formatTimeArgValue(value) {
  if (!value) {
    return "";
  }
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value)) {
    return `${value}:00`;
  }
  return value;
}

function buildExecution(task) {
  const commandPath = task.commandPath || task.pythonPath;
  const baseArgs = splitArgs(task.args);
  const timeArgs = task.timeArgName
    ? [task.timeArgName, formatTimeArgValue(task.timeArgValue || new Date().toISOString().slice(0, 16))]
    : [];
  const scriptArgs = [task.scriptPath, ...baseArgs, ...timeArgs];

  if (task.runnerType === "conda-name") {
    return {
      command: commandPath || "conda",
      args: ["run", "-n", task.condaTarget, "python", ...scriptArgs],
    };
  }

  if (task.runnerType === "conda-path") {
    return {
      command: commandPath || "conda",
      args: ["run", "-p", task.condaTarget, "python", ...scriptArgs],
    };
  }

  return {
    command: commandPath,
    args: scriptArgs,
  };
}

function terminateProcessTree(child) {
  if (!child?.pid) {
    return Promise.resolve();
  }

  if (process.platform === "win32") {
    return new Promise((resolve, reject) => {
      execFile("taskkill", ["/PID", String(child.pid), "/T", "/F"], (error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
  }

  return new Promise((resolve, reject) => {
    try {
      child.kill("SIGTERM");
      resolve();
    } catch (error) {
      reject(error);
    }
  });
}

async function runTask(taskId, trigger) {
  const task = getTask(taskId);
  if (!task) {
    throw new Error("任务不存在");
  }
  if (activeProcesses.has(taskId)) {
    throw new Error("任务正在运行中");
  }

  const startedAt = new Date().toISOString();
  const execution = buildExecution(task);
  const child = spawn(execution.command, execution.args, {
    cwd: task.workingDirectory || path.dirname(task.scriptPath),
    windowsHide: true,
  });

  activeProcesses.set(taskId, child);
  activeRunState.set(taskId, {
    trigger,
    startedAt,
    stdout: "",
    stderr: "",
  });

  let stdout = "";
  let stderr = "";

  child.stdout.on("data", (chunk) => {
    const text = chunk.toString();
    stdout += text;
    const current = activeRunState.get(taskId);
    if (current) {
      current.stdout += text;
    }
  });

  child.stderr.on("data", (chunk) => {
    const text = chunk.toString();
    stderr += text;
    const current = activeRunState.get(taskId);
    if (current) {
      current.stderr += text;
    }
  });

  return new Promise((resolve) => {
    child.on("close", (code) => {
      const current = activeRunState.get(taskId);
      activeProcesses.delete(taskId);
      activeRunState.delete(taskId);
      const finishedAt = new Date().toISOString();
      const status = current?.stopRequested ? "stopped" : code === 0 ? "success" : "failed";

      appendRunLog(taskId, {
        id: `run_${Date.now()}`,
        trigger,
        startedAt,
        finishedAt,
        exitCode: code,
        status,
        command: execution.command,
        commandArgs: execution.args,
        stdout: stdout.trim(),
        stderr: stderr.trim(),
      });

      saveTask({
        ...getTask(taskId),
        lastRunAt: finishedAt,
        lastStatus: status,
      });

      clearActiveRun(taskId);
      resolve();
    });

    child.on("error", (error) => {
      const current = activeRunState.get(taskId);
      activeProcesses.delete(taskId);
      activeRunState.delete(taskId);
      const finishedAt = new Date().toISOString();

      appendRunLog(taskId, {
        id: `run_${Date.now()}`,
        trigger,
        startedAt,
        finishedAt,
        exitCode: -1,
        status: current?.stopRequested ? "stopped" : "failed",
        command: execution.command,
        commandArgs: execution.args,
        stdout: stdout.trim(),
        stderr: `${stderr}\n${error.message}`.trim(),
      });

      saveTask({
        ...getTask(taskId),
        lastRunAt: finishedAt,
        lastStatus: current?.stopRequested ? "stopped" : "failed",
      });

      clearActiveRun(taskId);
      resolve();
    });
  });
}

app.get("/api/tasks", (_req, res) => {
  const tasks = getTasks().map((task) => ({
    ...task,
    running: activeProcesses.has(task.id),
    liveLog: activeRunState.get(task.id) || null,
  }));
  res.json(tasks);
});

app.get("/api/tasks/:id", (req, res) => {
  const task = getTask(req.params.id);
  if (!task) {
    return res.status(404).json({ error: "任务不存在" });
  }
  return res.json({
    ...task,
    running: activeProcesses.has(task.id),
    liveLog: activeRunState.get(task.id) || null,
  });
});

app.post("/api/tasks", (req, res) => {
  try {
    const task = normalizeTask(req.body);
    saveTask(task);
    scheduleTask(task);
    res.status(201).json(task);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.put("/api/tasks/:id", (req, res) => {
  try {
    const existing = getTask(req.params.id);
    if (!existing) {
      return res.status(404).json({ error: "任务不存在" });
    }

    const task = normalizeTask({
      ...existing,
      ...req.body,
      id: req.params.id,
      createdAt: existing.createdAt,
    });

    saveTask(task);
    scheduleTask(task);
    return res.json(task);
  } catch (error) {
    return res.status(400).json({ error: error.message });
  }
});

app.delete("/api/tasks/:id", (req, res) => {
  const existing = getTask(req.params.id);
  if (!existing) {
    return res.status(404).json({ error: "任务不存在" });
  }

  if (activeProcesses.has(req.params.id)) {
    return res.status(409).json({ error: "任务正在运行，无法删除" });
  }

  unscheduleTask(req.params.id);
  deleteTask(req.params.id);
  return res.status(204).end();
});

app.post("/api/tasks/:id/run", async (req, res) => {
  try {
    await runTask(req.params.id, "manual");
    return res.json({ ok: true });
  } catch (error) {
    return res.status(400).json({ error: error.message });
  }
});

app.post("/api/tasks/:id/stop", async (req, res) => {
  const child = activeProcesses.get(req.params.id);
  if (!child) {
    return res.status(409).json({ error: "任务未在运行" });
  }

  const current = activeRunState.get(req.params.id);
  if (current) {
    current.stopRequested = true;
  }

  try {
    await terminateProcessTree(child);
    return res.status(202).json({ ok: true });
  } catch (error) {
    if (current) {
      current.stopRequested = false;
    }
    return res.status(500).json({ error: `终止任务失败: ${error.message}` });
  }
});

app.get("*", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

refreshSchedules();

app.listen(PORT, () => {
  console.log(`Scheduler running at http://localhost:${PORT}`);
});
