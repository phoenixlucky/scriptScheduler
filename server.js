const express = require("express");
const fs = require("fs");
const path = require("path");
const cron = require("node-cron");
const TimeMatcher = require("node-cron/src/time-matcher");
const iconv = require("iconv-lite");
const { spawn, execFile, execFileSync } = require("child_process");
const {
  ensureStore,
  getTasks,
  getTask,
  saveTask,
  deleteTask,
  appendRunLog,
  clearTaskLogs,
  clearActiveRun,
} = require("./storage");

const DEFAULT_PORT = Number(process.env.PORT || 3000);
const scheduledJobs = new Map();
const triggeredScheduleMinutes = new Map();
const activeProcesses = new Map();
const activeRunState = new Map();

let serverInstance = null;
let scheduleCompensationTimer = null;
const NEXT_RUN_LOOKAHEAD_MINUTES = 5 * 366 * 24 * 60;

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
    lastError: String(payload.lastError || "").trim(),
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

function cloneForExport(task) {
  return {
    ...task,
    logs: Array.isArray(task.logs) ? task.logs : [],
  };
}

function generateTaskId(existingIds) {
  let candidate = `task_${Date.now()}`;
  while (existingIds.has(candidate)) {
    candidate = `task_${Date.now()}_${Math.floor(Math.random() * 1000)}`;
  }
  existingIds.add(candidate);
  return candidate;
}

function importTasks(items) {
  if (!Array.isArray(items) || !items.length) {
    throw new Error("导入内容不能为空");
  }

  const existingTasks = getTasks();
  const existingIds = new Set(existingTasks.map((task) => task.id));
  const existingByName = new Map(existingTasks.map((task) => [task.name, task]));
  const imported = [];

  for (const rawItem of items) {
    const candidate = normalizeTask(rawItem);
    const matchedByName = existingByName.get(candidate.name);

    if (matchedByName) {
      candidate.id = matchedByName.id;
      candidate.createdAt = matchedByName.createdAt;
    } else if (existingIds.has(candidate.id)) {
      candidate.id = generateTaskId(existingIds);
    }

    existingIds.add(candidate.id);
    existingByName.set(candidate.name, candidate);
    saveTask(candidate);
    scheduleTask(candidate);
    imported.push(candidate);
  }

  return imported;
}

function setTaskEnabled(taskId, enabled) {
  const existing = getTask(taskId);
  if (!existing) {
    return null;
  }

  const task = {
    ...existing,
    enabled,
    updatedAt: new Date().toISOString(),
  };
  saveTask(task);
  scheduleTask(task);
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
  triggeredScheduleMinutes.delete(taskId);
}

function toMinuteDate(date = new Date()) {
  const minuteDate = new Date(date);
  minuteDate.setSeconds(0, 0);
  return minuteDate;
}

function getMinuteKey(date = new Date()) {
  return toMinuteDate(date).toISOString();
}

function hasTriggeredTaskForMinute(taskId, date = new Date()) {
  return triggeredScheduleMinutes.get(taskId) === getMinuteKey(date);
}

function markTaskTriggeredForMinute(taskId, date = new Date()) {
  triggeredScheduleMinutes.set(taskId, getMinuteKey(date));
}

function triggerScheduledTask(taskId, scheduledAt = new Date()) {
  if (hasTriggeredTaskForMinute(taskId, scheduledAt)) {
    return;
  }

  markTaskTriggeredForMinute(taskId, scheduledAt);
  runTask(taskId, "scheduled").catch((error) => {
    console.error(`Task ${taskId} failed:`, error);
  });
}

function checkMissedSchedules(now = new Date()) {
  const currentMinute = toMinuteDate(now);

  for (const task of getTasks()) {
    if (!task?.enabled || !task?.schedule || !cron.validate(task.schedule)) {
      continue;
    }

    const matcher = new TimeMatcher(task.schedule);
    if (matcher.match(currentMinute)) {
      triggerScheduledTask(task.id, currentMinute);
    }
  }
}

function startScheduleCompensation() {
  if (scheduleCompensationTimer) {
    clearInterval(scheduleCompensationTimer);
  }

  checkMissedSchedules();
  scheduleCompensationTimer = setInterval(() => {
    checkMissedSchedules();
  }, 30 * 1000);
}

function scheduleTask(task) {
  unscheduleTask(task.id);
  if (!task.enabled) {
    return;
  }

  const job = cron.schedule(task.schedule, () => {
    triggerScheduledTask(task.id);
  });

  scheduledJobs.set(task.id, job);
}

function computeNextRunAt(task, baseDate = new Date()) {
  if (!task?.enabled || !task?.schedule || !cron.validate(task.schedule)) {
    return null;
  }

  const matcher = new TimeMatcher(task.schedule);
  const nextMinute = new Date(baseDate);
  nextMinute.setSeconds(0, 0);
  nextMinute.setMinutes(nextMinute.getMinutes() + 1);

  for (let offset = 0; offset < NEXT_RUN_LOOKAHEAD_MINUTES; offset += 1) {
    const candidate = new Date(nextMinute.getTime() + offset * 60 * 1000);
    if (matcher.match(candidate)) {
      return candidate.toISOString();
    }
  }

  return null;
}

function serializeTask(task) {
  return {
    ...task,
    running: activeProcesses.has(task.id),
    liveLog: activeRunState.get(task.id) || null,
    nextRunAt: computeNextRunAt(task),
  };
}

function refreshSchedules() {
  for (const task of getTasks()) {
    scheduleTask(task);
  }

  startScheduleCompensation();
}

function backfillTaskErrors() {
  for (const task of getTasks()) {
    if (task.lastStatus !== "failed" || task.lastError) {
      continue;
    }

    const failedLog = Array.isArray(task.logs) ? task.logs.find((log) => log?.status === "failed") : null;
    const lastError = getErrorSummary({
      stderr: failedLog?.stderr || "",
      stdout: failedLog?.stdout || "",
      exitCode: failedLog?.exitCode,
    });

    if (!lastError) {
      continue;
    }

    saveTask({
      ...task,
      lastError,
    });
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

function getErrorSummary({ stderr, stdout, exitCode, fallbackMessage }) {
  const text = [stderr, stdout]
    .map((value) => String(value || ""))
    .join("\n");
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => {
      if (!line) {
        return false;
      }
      if (/^[#><=\-`.\s]+$/.test(line)) {
        return false;
      }
      if (/^#\s*>+/.test(line)) {
        return false;
      }
      return true;
    });

  const preferredLine = lines.find((line) => {
    const normalized = line.toLowerCase();
    return (
      normalized.includes("error") ||
      normalized.includes("exception") ||
      normalized.includes("traceback") ||
      normalized.includes("failed") ||
      normalized.includes("cannot") ||
      normalized.includes("not found") ||
      normalized.includes("无法") ||
      normalized.includes("失败") ||
      normalized.includes("未找到")
    );
  });

  if (preferredLine) {
    return preferredLine;
  }
  if (lines.length) {
    return lines[0];
  }
  if (fallbackMessage) {
    return fallbackMessage;
  }
  if (typeof exitCode === "number" && exitCode !== 0) {
    return `进程退出码 ${exitCode}`;
  }
  return "";
}

function decodeProcessChunk(chunk) {
  const utf8Text = chunk.toString("utf8");
  if (!utf8Text.includes("�")) {
    return utf8Text;
  }

  const gbkText = iconv.decode(chunk, "cp936");
  const utf8ReplacementCount = (utf8Text.match(/�/g) || []).length;
  const gbkReplacementCount = (gbkText.match(/�/g) || []).length;

  return gbkReplacementCount <= utf8ReplacementCount ? gbkText : utf8Text;
}

function stripWrappingQuotes(value) {
  return String(value || "").trim().replace(/^"(.*)"$/, "$1");
}

function dedupePaths(paths) {
  return [...new Set(paths.filter(Boolean).map((item) => path.normalize(item)))];
}

function getHomeDirCandidates() {
  return dedupePaths([
    process.env.USERPROFILE,
    process.env.HOMEDRIVE && process.env.HOMEPATH ? `${process.env.HOMEDRIVE}${process.env.HOMEPATH}` : "",
    process.env.HOME,
  ]);
}

function getDefaultCondaBaseCandidates() {
  const homeDirs = getHomeDirCandidates();
  const candidates = [
    "D:\\ProgramData\\miniconda3",
    "C:\\ProgramData\\miniconda3",
    "D:\\Miniconda3",
    "C:\\Miniconda3",
    "D:\\Anaconda3",
    "C:\\Anaconda3",
  ];

  for (const homeDir of homeDirs) {
    candidates.push(path.join(homeDir, "miniconda3"));
    candidates.push(path.join(homeDir, "anaconda3"));
    candidates.push(path.join(homeDir, "AppData", "Local", "miniconda3"));
    candidates.push(path.join(homeDir, "AppData", "Local", "anaconda3"));
  }

  return dedupePaths(candidates.filter((candidate) => fs.existsSync(candidate)));
}

function resolveCondaBaseCandidates(commandPath) {
  const input = stripWrappingQuotes(commandPath);
  const candidates = [];

  if (input) {
    const normalized = path.normalize(input);
    if (fs.existsSync(normalized)) {
      const stats = fs.statSync(normalized);
      if (stats.isDirectory()) {
        candidates.push(normalized);
      } else {
        const parentDir = path.dirname(normalized);
        const parentName = path.basename(parentDir).toLowerCase();
        if (parentName === "scripts" || parentName === "condabin") {
          candidates.push(path.dirname(parentDir));
        }
      }
    } else {
      const parentDir = path.dirname(normalized);
      const parentName = path.basename(parentDir).toLowerCase();
      if (parentName === "scripts" || parentName === "condabin") {
        candidates.push(path.dirname(parentDir));
      }
    }
  }

  if (process.env.CONDA_ROOT) {
    candidates.push(process.env.CONDA_ROOT);
  }
  if (process.env.CONDA_EXE) {
    candidates.push(path.dirname(path.dirname(process.env.CONDA_EXE)));
  }

  return dedupePaths([...candidates, ...getDefaultCondaBaseCandidates()]);
}

function readCondaEnvList(commandPath) {
  const condaCommand = resolveCondaCommand(commandPath);
  const queries = [
    ["env", "list", "--json"],
    ["info", "--envs", "--json"],
  ];

  for (const args of queries) {
    try {
      const sharedOptions = {
        encoding: "utf8",
        windowsHide: true,
        env: {
          ...process.env,
          CONDA_NO_PLUGINS: "true",
          PYTHONIOENCODING: "utf-8",
          PYTHONUTF8: "1",
        },
      };
      const stdout = /\.bat$/i.test(condaCommand)
        ? execFileSync("cmd.exe", ["/d", "/s", "/c", `call "${condaCommand}" ${args.join(" ")}`], sharedOptions)
        : execFileSync(condaCommand, args, sharedOptions);
      const payload = JSON.parse(stdout);
      const envs = Array.isArray(payload?.envs) ? payload.envs : [];
      if (envs.length) {
        return envs.map((item) => path.normalize(item));
      }
    } catch (_error) {
      // Fall back to filesystem-based resolution if Conda can't report environments.
    }
  }

  return [];
}

function resolveCondaEnvPrefixByName(envName, commandPath) {
  const normalizedEnvName = stripWrappingQuotes(envName);
  const discoveredEnvs = readCondaEnvList(commandPath);
  const match = discoveredEnvs.find((envPath) => path.basename(envPath).toLowerCase() === normalizedEnvName.toLowerCase());

  if (match) {
    return match;
  }

  return null;
}

function resolveCondaPython(task) {
  if (task.runnerType === "conda-path") {
    const prefix = stripWrappingQuotes(task.condaTarget);
    const pythonPath = path.join(prefix, "python.exe");
    if (!fs.existsSync(pythonPath)) {
      throw new Error(`未找到 Conda 环境解释器: ${pythonPath}`);
    }
    return pythonPath;
  }

  const envName = stripWrappingQuotes(task.condaTarget);
  const discoveredPrefix = resolveCondaEnvPrefixByName(envName, task.commandPath || task.pythonPath);
  if (discoveredPrefix) {
    const discoveredPython = path.join(discoveredPrefix, "python.exe");
    if (fs.existsSync(discoveredPython)) {
      return discoveredPython;
    }
  }

  const baseCandidates = resolveCondaBaseCandidates(task.commandPath || task.pythonPath);
  const pythonCandidates = baseCandidates.map((basePath) =>
    envName.toLowerCase() === "base" ? path.join(basePath, "python.exe") : path.join(basePath, "envs", envName, "python.exe")
  );

  for (const candidate of dedupePaths(pythonCandidates)) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  const searched = pythonCandidates.length ? pythonCandidates.join(" ; ") : "未提供候选路径";
  throw new Error(`无法解析 Conda 环境 ${envName} 的 python.exe。已检查: ${searched}`);
}

function getCondaExecutableCandidates(basePath) {
  return [
    path.join(basePath, "Scripts", "conda.exe"),
    path.join(basePath, "condabin", "conda.exe"),
    path.join(basePath, "condabin", "conda.bat"),
    path.join(basePath, "Scripts", "conda.bat"),
  ];
}

function resolveCondaCommand(commandPath) {
  const input = stripWrappingQuotes(commandPath);
  const directCandidates = [];

  if (input) {
    const normalized = path.normalize(input);
    const lowerName = path.basename(normalized).toLowerCase();
    if (["conda.exe", "conda.bat"].includes(lowerName)) {
      directCandidates.push(normalized);
    }
  }

  const baseCandidates = resolveCondaBaseCandidates(commandPath);
  const commandCandidates = dedupePaths([
    ...directCandidates,
    ...baseCandidates.flatMap((basePath) => getCondaExecutableCandidates(basePath)),
    process.env.CONDA_EXE,
  ]);

  for (const candidate of commandCandidates) {
    if (candidate && fs.existsSync(candidate)) {
      return candidate;
    }
  }

  const searched = commandCandidates.length ? commandCandidates.join(" ; ") : "未提供候选路径";
  throw new Error(`无法解析 Conda 命令。已检查: ${searched}`);
}

function buildExecution(task) {
  const commandPath = task.commandPath || task.pythonPath;
  const baseArgs = splitArgs(task.args);
  const timeArgs = task.timeArgName
    ? [task.timeArgName, formatTimeArgValue(task.timeArgValue || new Date().toISOString().slice(0, 16))]
    : [];
  const scriptArgs = [task.scriptPath, ...baseArgs, ...timeArgs];

  if (task.runnerType === "conda-name") {
    try {
      return {
        command: resolveCondaPython(task),
        args: scriptArgs,
      };
    } catch (error) {
      return {
        command: resolveCondaCommand(commandPath),
        args: ["run", "--no-capture-output", "-n", stripWrappingQuotes(task.condaTarget), "python", ...scriptArgs],
        env: {
          CONDA_NO_PLUGINS: "true",
          PYTHONIOENCODING: "utf-8",
          PYTHONUTF8: "1",
        },
        resolutionError: error.message,
      };
    }
  }

  if (task.runnerType === "conda-path") {
    try {
      return {
        command: resolveCondaPython(task),
        args: scriptArgs,
      };
    } catch (error) {
      return {
        command: resolveCondaCommand(commandPath),
        args: ["run", "--no-capture-output", "-p", stripWrappingQuotes(task.condaTarget), "python", ...scriptArgs],
        env: {
          CONDA_NO_PLUGINS: "true",
          PYTHONIOENCODING: "utf-8",
          PYTHONUTF8: "1",
        },
        resolutionError: error.message,
      };
    }
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
  let execution;
  try {
    execution = buildExecution(task);
  } catch (error) {
    const finishedAt = new Date().toISOString();
    const lastError = getErrorSummary({
      stderr: error.message,
      fallbackMessage: error.message,
      exitCode: -1,
    });

    appendRunLog(taskId, {
      id: `run_${Date.now()}`,
      trigger,
      startedAt,
      finishedAt,
      exitCode: -1,
      status: "failed",
      command: "",
      commandArgs: [],
      stdout: "",
      stderr: error.message,
    });

    const updatedTask = getTask(taskId);
    saveTask({
      ...updatedTask,
      lastRunAt: finishedAt,
      lastStatus: "failed",
      lastError,
    });
    return;
  }

  const child = spawn(execution.command, execution.args, {
    cwd: task.workingDirectory || path.dirname(task.scriptPath),
    windowsHide: true,
    env: {
      ...process.env,
      ...(execution.env || {}),
    },
  });

  activeProcesses.set(taskId, child);
  activeRunState.set(taskId, {
    trigger,
    startedAt,
    stdout: "",
    stderr: "",
  });

  let stdout = "";
  let stderr = execution.resolutionError ? `[conda fallback] ${execution.resolutionError}\n` : "";

  child.stdout.on("data", (chunk) => {
    const text = decodeProcessChunk(chunk);
    stdout += text;
    const current = activeRunState.get(taskId);
    if (current) {
      current.stdout += text;
    }
  });

  child.stderr.on("data", (chunk) => {
    const text = decodeProcessChunk(chunk);
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
      const lastError =
        status === "failed"
          ? getErrorSummary({
              stderr: stderr.trim(),
              stdout: stdout.trim(),
              exitCode: code,
            })
          : "";

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
        lastError,
      });

      clearActiveRun(taskId);
      resolve();
    });

    child.on("error", (error) => {
      const current = activeRunState.get(taskId);
      activeProcesses.delete(taskId);
      activeRunState.delete(taskId);
      const finishedAt = new Date().toISOString();
      const status = current?.stopRequested ? "stopped" : "failed";
      const mergedStderr = `${stderr}\n${error.message}`.trim();
      const lastError =
        status === "failed"
          ? getErrorSummary({
              stderr: mergedStderr,
              stdout: stdout.trim(),
              exitCode: -1,
              fallbackMessage: error.message,
            })
          : "";

      appendRunLog(taskId, {
        id: `run_${Date.now()}`,
        trigger,
        startedAt,
        finishedAt,
        exitCode: -1,
        status,
        command: execution.command,
        commandArgs: execution.args,
        stdout: stdout.trim(),
        stderr: mergedStderr,
      });

      saveTask({
        ...getTask(taskId),
        lastRunAt: finishedAt,
        lastStatus: status,
        lastError,
      });

      clearActiveRun(taskId);
      resolve();
    });
  });
}

function createApp() {
  const app = express();

  ensureStore();
  backfillTaskErrors();
  app.use(express.json());
  app.use(express.static(path.join(__dirname, "public")));

  app.get("/api/tasks", (_req, res) => {
    const tasks = getTasks().map((task) => serializeTask(task));
    res.json(tasks);
  });

  app.get("/api/tasks/:id", (req, res) => {
    const task = getTask(req.params.id);
    if (!task) {
      return res.status(404).json({ error: "任务不存在" });
    }
    return res.json(serializeTask(task));
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
      if (!getTask(req.params.id)) {
        return res.status(404).json({ error: "任务不存在" });
      }
      if (activeProcesses.has(req.params.id)) {
        return res.status(409).json({ error: "任务正在运行中" });
      }

      runTask(req.params.id, "manual").catch((error) => {
        console.error(`Task ${req.params.id} manual run failed:`, error);
      });
      return res.status(202).json({ ok: true });
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

  app.post("/api/tasks/:id/start", (req, res) => {
    const task = setTaskEnabled(req.params.id, true);
    if (!task) {
      return res.status(404).json({ error: "任务不存在" });
    }
    return res.json(task);
  });

  app.post("/api/tasks/:id/pause", (req, res) => {
    const task = setTaskEnabled(req.params.id, false);
    if (!task) {
      return res.status(404).json({ error: "任务不存在" });
    }
    return res.json(task);
  });

  app.delete("/api/tasks/:id/logs", (req, res) => {
    const task = clearTaskLogs(req.params.id);
    if (!task) {
      return res.status(404).json({ error: "任务不存在" });
    }
    return res.status(204).end();
  });

  app.get("/api/tasks-export", (_req, res) => {
    const tasks = getTasks().map(cloneForExport);
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="weischeduler-tasks-${new Date().toISOString().slice(0, 10)}.json"`);
    return res.send(
      JSON.stringify(
        {
          version: 1,
          exportedAt: new Date().toISOString(),
          tasks,
        },
        null,
        2
      )
    );
  });

  app.post("/api/tasks-import", (req, res) => {
    try {
      const payload = req.body || {};
      const tasks = Array.isArray(payload) ? payload : payload.tasks;
      const imported = importTasks(tasks);
      return res.status(201).json({ imported: imported.length });
    } catch (error) {
      return res.status(400).json({ error: error.message });
    }
  });

  app.get("*", (_req, res) => {
    res.sendFile(path.join(__dirname, "public", "index.html"));
  });

  return app;
}

function startServer({ port = DEFAULT_PORT, retries = 20 } = {}) {
  if (serverInstance) {
    return Promise.resolve({
      server: serverInstance,
      port: serverInstance.address().port,
    });
  }

  refreshSchedules();
  const app = createApp();

  return new Promise((resolve, reject) => {
    const tryListen = (candidatePort, retriesLeft) => {
      const server = app.listen(candidatePort, () => {
        serverInstance = server;
        console.log(`Scheduler running at http://localhost:${candidatePort}`);
        resolve({ server, port: candidatePort });
      });

      server.on("error", (error) => {
        if (error.code === "EADDRINUSE" && retriesLeft > 0) {
          console.warn(`Port ${candidatePort} is in use, retrying with ${candidatePort + 1}`);
          tryListen(candidatePort + 1, retriesLeft - 1);
          return;
        }

        reject(error);
      });
    };

    tryListen(port, retries);
  });
}

function stopServer() {
  if (!serverInstance) {
    return Promise.resolve();
  }

  return new Promise((resolve, reject) => {
    if (scheduleCompensationTimer) {
      clearInterval(scheduleCompensationTimer);
      scheduleCompensationTimer = null;
    }

    serverInstance.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      serverInstance = null;
      resolve();
    });
  });
}

module.exports = {
  startServer,
  stopServer,
};

if (require.main === module) {
  startServer().catch((error) => {
    console.error(`Failed to start server: ${error.message}`);
    process.exit(1);
  });
}
