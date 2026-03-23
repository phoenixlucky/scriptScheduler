const taskForm = document.getElementById("task-form");
const taskList = document.getElementById("task-list");
const resetButton = document.getElementById("reset-form");
const refreshButton = document.getElementById("refresh-list");
const exportButton = document.getElementById("export-tasks");
const importButton = document.getElementById("import-tasks");
const importFileInput = document.getElementById("import-file");
const autoRefreshEnabledInput = document.getElementById("auto-refresh-enabled");
const autoRefreshIntervalInput = document.getElementById("auto-refresh-interval");
const formTitle = document.getElementById("form-title");
const taskTemplate = document.getElementById("task-template");
const scheduleInput = document.getElementById("schedule");
const cronMinuteInput = document.getElementById("cron-minute");
const cronHourInput = document.getElementById("cron-hour");
const cronDayInput = document.getElementById("cron-day");
const cronMonthInput = document.getElementById("cron-month");
const cronWeekdayInput = document.getElementById("cron-weekday");
const heroTotal = document.getElementById("hero-total");
const heroRunning = document.getElementById("hero-running");
const heroEnabled = document.getElementById("hero-enabled");
const AUTO_REFRESH_ENABLED_KEY = "weischeduler:auto-refresh-enabled";
const AUTO_REFRESH_INTERVAL_KEY = "weischeduler:auto-refresh-interval";
let loadTimer = null;
const expandedTaskIds = new Set();
const cronPartInputs = [cronMinuteInput, cronHourInput, cronDayInput, cronMonthInput, cronWeekdayInput];

const beijingDateTimeFormatter = new Intl.DateTimeFormat("zh-CN", {
  timeZone: "Asia/Shanghai",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false,
});

function formatDisplayTime(value) {
  if (!value) {
    return "-";
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return beijingDateTimeFormatter.format(date).replace(/\//g, "-");
}

function getAutoRefreshEnabled() {
  return autoRefreshEnabledInput.checked;
}

function getAutoRefreshInterval() {
  const interval = Number(autoRefreshIntervalInput.value);
  return Number.isFinite(interval) && interval > 0 ? interval : 10000;
}

function persistAutoRefreshPreferences() {
  window.localStorage.setItem(AUTO_REFRESH_ENABLED_KEY, String(getAutoRefreshEnabled()));
  window.localStorage.setItem(AUTO_REFRESH_INTERVAL_KEY, String(getAutoRefreshInterval()));
}

function hydrateAutoRefreshPreferences() {
  const savedEnabled = window.localStorage.getItem(AUTO_REFRESH_ENABLED_KEY);
  const savedInterval = window.localStorage.getItem(AUTO_REFRESH_INTERVAL_KEY);

  if (savedEnabled !== null) {
    autoRefreshEnabledInput.checked = savedEnabled === "true";
  }
  if (savedInterval && [...autoRefreshIntervalInput.options].some((option) => option.value === savedInterval)) {
    autoRefreshIntervalInput.value = savedInterval;
  }
}

function clearLoadTimer() {
  if (loadTimer) {
    window.clearTimeout(loadTimer);
    loadTimer = null;
  }
}

function scheduleAutoRefresh() {
  clearLoadTimer();
  if (!getAutoRefreshEnabled()) {
    return;
  }

  loadTimer = window.setTimeout(() => {
    loadTasks().catch((error) => {
      taskList.innerHTML = `<div class="empty-state">${error.message}</div>`;
    });
  }, getAutoRefreshInterval());
}

function formToPayload() {
  const formData = new FormData(taskForm);
  return {
    id: formData.get("id") || undefined,
    name: formData.get("name"),
    runnerType: formData.get("runnerType"),
    commandPath: formData.get("commandPath"),
    condaTarget: formData.get("condaTarget"),
    scriptPath: formData.get("scriptPath"),
    args: formData.get("args"),
    timeArgName: formData.get("timeArgName"),
    timeArgValue: formData.get("timeArgValue"),
    workingDirectory: formData.get("workingDirectory"),
    schedule: formData.get("schedule"),
    enabled: document.getElementById("enabled").checked,
  };
}

function updateRunnerFields() {
  const runnerType = document.getElementById("runnerType").value;
  const condaRow = document.getElementById("conda-target-row");
  const commandPathRow = document.getElementById("command-path-row");
  const commandPath = document.getElementById("commandPath");
  const condaTarget = document.getElementById("condaTarget");
  const commandPathLabel = commandPathRow.querySelector(".field-label");

  if (runnerType === "python") {
    commandPathRow.style.display = "grid";
    condaRow.style.display = "none";
    commandPath.required = true;
    commandPath.placeholder = "例如：D:\\ProgramData\\miniconda3\\envs\\py3143\\python.exe";
    commandPathLabel.textContent = "Python 路径";
    condaTarget.required = false;
  } else {
    commandPathRow.style.display = "grid";
    condaRow.style.display = "grid";
    commandPath.required = false;
    commandPath.placeholder = "可选：Miniconda 根目录、Scripts\\conda.exe 或 condabin\\conda.bat";
    commandPathLabel.textContent = "Conda 根目录或命令路径";
    condaTarget.required = true;
  }
}

function resetForm() {
  taskForm.reset();
  document.getElementById("task-id").value = "";
  document.getElementById("enabled").checked = true;
  document.getElementById("runnerType").value = "python";
  updateRunnerFields();
  syncCronBuilderFromSchedule("");
  formTitle.textContent = "新建任务";
}

function renderLog(task) {
  if (task.running && task.liveLog) {
    return [
      `[${task.liveLog.stopRequested ? "stopping" : "running"}] ${formatDisplayTime(task.liveLog.startedAt)} -> -`,
      `trigger: ${task.liveLog.trigger}`,
      "exitCode: -",
      "",
      task.liveLog.stdout ? `stdout:\n${task.liveLog.stdout}` : "stdout:\n<streaming>",
      "",
      task.liveLog.stderr ? `stderr:\n${task.liveLog.stderr}` : "stderr:\n<empty>",
    ].join("\n");
  }

  const [latest] = task.logs || [];
  if (!latest) {
    return "暂无运行记录";
  }

  return [
    `[${latest.status}] ${formatDisplayTime(latest.startedAt)} -> ${formatDisplayTime(latest.finishedAt)}`,
    `trigger: ${latest.trigger}`,
    `exitCode: ${latest.exitCode}`,
    "",
    latest.stdout ? `stdout:\n${latest.stdout}` : "stdout:\n<empty>",
    "",
    latest.stderr ? `stderr:\n${latest.stderr}` : "stderr:\n<empty>",
  ].join("\n");
}

function describeSchedule(schedule) {
  const presets = {
    "*/5 * * * *": "每 5 分钟",
    "0 * * * *": "每小时",
    "0 */3 * * *": "每 3 小时",
    "0 9 * * *": "每天 09:00",
    "0 0 */3 * *": "每 3 天",
    "0 9 * * 1-5": "工作日 09:00",
    "0 0 1 * *": "每月 1 日",
  };

  if (presets[schedule]) {
    return presets[schedule];
  }

  const everyMinutes = schedule.match(/^\*\/(\d+) \* \* \* \*$/);
  if (everyMinutes) {
    return `每 ${everyMinutes[1]} 分钟`;
  }

  return schedule;
}

function splitCronExpression(schedule) {
  const parts = String(schedule || "")
    .trim()
    .split(/\s+/)
    .filter(Boolean);

  return parts.length === 5 ? parts : null;
}

function syncCronBuilderFromSchedule(schedule) {
  const parts = splitCronExpression(schedule);
  cronPartInputs.forEach((input, index) => {
    input.value = parts ? parts[index] : "";
  });
}

function composeCronFromBuilder() {
  return cronPartInputs
    .map((input) => String(input.value || "").trim() || "*")
    .join(" ");
}

function sleep(ms) {
  return new Promise((resolve) => {
    window.setTimeout(resolve, ms);
  });
}

function getLatestTaskLog(task) {
  return Array.isArray(task?.logs) && task.logs.length ? task.logs[0] : null;
}

function getMostRelevantFailedLog(task) {
  if (!Array.isArray(task?.logs) || !task.logs.length) {
    return null;
  }

  const failedLog = task.logs.find((log) => log?.status === "failed");
  return failedLog || task.logs[0];
}

function getMeaningfulErrorLine(text) {
  const lines = String(text || "")
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

  if (!lines.length) {
    return "";
  }

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

  return preferredLine || lines[0];
}

function summarizeTaskError(log) {
  const stderrLine = getMeaningfulErrorLine(log?.stderr || "");

  if (stderrLine) {
    return stderrLine;
  }

  const stdoutLine = getMeaningfulErrorLine(log?.stdout || "");
  if (stdoutLine) {
    return stdoutLine;
  }

  if (typeof log?.exitCode === "number" && log.exitCode !== 0) {
    return `进程退出码 ${log.exitCode}`;
  }

  return "执行失败，但没有返回更多错误信息";
}

function buildManualRunFailureDetails(task) {
  const failedLog = getMostRelevantFailedLog(task);
  const summary = task.lastError || summarizeTaskError(failedLog);
  const stderr = String(failedLog?.stderr || "").trim();
  const stdout = String(failedLog?.stdout || "").trim();
  const detail = stderr || stdout;

  if (!detail || detail === summary) {
    return `${task.name} 执行失败：${summary}`;
  }

  return [
    `${task.name} 执行失败：${summary}`,
    "",
    "详细信息：",
    detail,
  ].join("\n");
}

function buildManualRunError(task) {
  return buildManualRunFailureDetails(task);
}

async function waitForManualRunResult(taskId, previousLogId) {
  const startedAt = Date.now();
  let sawRunning = false;

  while (Date.now() - startedAt < 120000) {
    const task = await request(`/api/tasks/${taskId}`);
    const latest = getLatestTaskLog(task);
    const hasNewLog = latest && latest.id !== previousLogId;

    if (task.running) {
      sawRunning = true;
    }

    if (hasNewLog && !task.running) {
      return task;
    }

    if (sawRunning && !task.running) {
      return task;
    }

    await sleep(700);
  }

  return request(`/api/tasks/${taskId}`);
}

function detailRows(task) {
  const commandLabel = task.commandPath || task.pythonPath || "-";

  return [
    ["执行方式", task.runnerType],
    ["命令路径", commandLabel],
    ["Conda 目标", task.condaTarget || "-"],
    ["脚本", task.scriptPath],
    ["参数", task.args || "-"],
    ["时间参数", task.timeArgName ? `${task.timeArgName} ${task.timeArgValue || "(执行时当前时间)"}` : "-"],
    ["目录", task.workingDirectory || "-"],
    ["Cron", task.schedule],
    ["启用", task.enabled ? "是" : "否"],
    ["最近执行", task.lastRunAt ? formatDisplayTime(task.lastRunAt) : "从未执行"],
  ]
    .map(([label, value]) => `<dt>${label}</dt><dd>${value}</dd>`)
    .join("");
}

async function request(url, options = {}) {
  const response = await fetch(url, {
    headers: {
      "Content-Type": "application/json",
    },
    ...options,
  });

  if (!response.ok) {
    const data = await response.json().catch(() => ({ error: "请求失败" }));
    throw new Error(data.error || "请求失败");
  }

  if (response.status === 204) {
    return null;
  }

  return response.json();
}

async function exportTasks() {
  const response = await fetch("/api/tasks-export");
  if (!response.ok) {
    throw new Error("导出任务失败");
  }

  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  const contentDisposition = response.headers.get("Content-Disposition") || "";
  const fileNameMatch = contentDisposition.match(/filename="(.+)"/i);
  const fileName = fileNameMatch ? fileNameMatch[1] : "weischeduler-tasks.json";
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

async function importTasks(file) {
  const text = await file.text();
  let payload;
  try {
    payload = JSON.parse(text);
  } catch (_error) {
    throw new Error("导入文件不是有效的 JSON");
  }

  const result = await request("/api/tasks-import", {
    method: "POST",
    body: JSON.stringify(payload),
  });
  return result?.imported || 0;
}

async function triggerManualRun(taskId) {
  const beforeTask = await request(`/api/tasks/${taskId}`);
  const previousLogId = getLatestTaskLog(beforeTask)?.id || null;
  await request(`/api/tasks/${taskId}/run`, { method: "POST" });
  const task = await waitForManualRunResult(taskId, previousLogId);
  await loadTasks();

  const latest = getLatestTaskLog(task);
  if (latest?.id !== previousLogId && latest?.status === "failed") {
    throw new Error(buildManualRunError(task));
  }
}

async function loadTasks() {
  const tasks = await request("/api/tasks");
  taskList.innerHTML = "";
  heroTotal.textContent = String(tasks.length);
  heroRunning.textContent = String(tasks.filter((task) => task.running).length);
  heroEnabled.textContent = String(tasks.filter((task) => task.enabled).length);

  if (!tasks.length) {
    taskList.innerHTML = '<div class="empty-state">还没有任务，先在左侧创建一个。</div>';
    return;
  }

  for (const task of tasks) {
    const node = taskTemplate.content.firstElementChild.cloneNode(true);
    node.querySelector(".task-name").textContent = task.name;
    node.querySelector(".task-frequency").textContent = describeSchedule(task.schedule);
    const failedLog = getMostRelevantFailedLog(task);
    const failureText = task.lastStatus === "failed" ? task.lastError || summarizeTaskError(failedLog) : "";
    node.querySelector(".task-meta").textContent = task.running
      ? `触发方式：${task.liveLog?.trigger || "manual"} · 开始于 ${formatDisplayTime(task.liveLog?.startedAt)}`
      : task.lastStatus === "failed"
        ? `状态：failed · 原因：${failureText} · 最近执行：${task.lastRunAt ? formatDisplayTime(task.lastRunAt) : "从未执行"}`
        : `状态：${task.lastStatus} · 最近执行：${task.lastRunAt ? formatDisplayTime(task.lastRunAt) : "从未执行"}`;

    const status = node.querySelector(".task-status");
    status.textContent = task.running ? (task.liveLog?.stopRequested ? "终止中" : "运行中") : task.lastStatus;
    status.classList.toggle("failed", task.lastStatus === "failed");
    status.classList.toggle("never", task.lastStatus === "never");
    status.classList.toggle("stopped", task.lastStatus === "stopped");

    const toggleButton = node.querySelector(".action-toggle");
    const startButton = node.querySelector(".action-start");
    const pauseButton = node.querySelector(".action-pause");
    const headStopButton = node.querySelector(".action-stop-head");
    const runOnceButton = node.querySelector(".action-run-once");
    const stopButton = node.querySelector(".action-stop");
    const clearLogsButton = node.querySelector(".action-clear-logs");
    const isCollapsed = !expandedTaskIds.has(task.id);
    node.classList.toggle("collapsed", isCollapsed);
    toggleButton.textContent = isCollapsed ? "展开详情" : "折叠详情";
    startButton.disabled = task.enabled;
    pauseButton.disabled = !task.enabled;
    runOnceButton.disabled = task.running;
    headStopButton.disabled = !task.running;
    headStopButton.textContent = task.liveLog?.stopRequested ? "终止中" : "终止";
    stopButton.disabled = !task.running;
    stopButton.textContent = task.liveLog?.stopRequested ? "终止中..." : "终止任务";
    clearLogsButton.disabled = !(task.logs && task.logs.length);

    node.querySelector(".task-detail").innerHTML = detailRows(task);
    node.querySelector(".task-log").textContent = renderLog(task);

    toggleButton.addEventListener("click", () => {
      if (expandedTaskIds.has(task.id)) {
        expandedTaskIds.delete(task.id);
      } else {
        expandedTaskIds.add(task.id);
      }
      loadTasks().catch((error) => {
        taskList.innerHTML = `<div class="empty-state">${error.message}</div>`;
      });
    });

    node.querySelector(".action-edit").addEventListener("click", () => {
      document.getElementById("task-id").value = task.id;
      document.getElementById("name").value = task.name;
      document.getElementById("runnerType").value = task.runnerType || "python";
      document.getElementById("commandPath").value = task.commandPath || task.pythonPath || "";
      document.getElementById("condaTarget").value = task.condaTarget || "";
      document.getElementById("scriptPath").value = task.scriptPath;
      document.getElementById("args").value = task.args || "";
      document.getElementById("timeArgName").value = task.timeArgName || "";
      document.getElementById("timeArgValue").value = task.timeArgValue || "";
      document.getElementById("workingDirectory").value = task.workingDirectory || "";
      document.getElementById("schedule").value = task.schedule;
      syncCronBuilderFromSchedule(task.schedule);
      document.getElementById("enabled").checked = task.enabled;
      updateRunnerFields();
      formTitle.textContent = `编辑任务: ${task.name}`;
      window.scrollTo({ top: 0, behavior: "smooth" });
    });

    startButton.addEventListener("click", async () => {
      try {
        await request(`/api/tasks/${task.id}/start`, { method: "POST" });
        await loadTasks();
      } catch (error) {
        alert(error.message);
      }
    });

    pauseButton.addEventListener("click", async () => {
      try {
        await request(`/api/tasks/${task.id}/pause`, { method: "POST" });
        await loadTasks();
      } catch (error) {
        alert(error.message);
      }
    });

    runOnceButton.addEventListener("click", async () => {
      try {
        await triggerManualRun(task.id);
      } catch (error) {
        alert(error.message);
      }
    });

    node.querySelector(".action-run").addEventListener("click", async () => {
      try {
        await triggerManualRun(task.id);
      } catch (error) {
        alert(error.message);
      }
    });

    const stopTask = async () => {
      try {
        await request(`/api/tasks/${task.id}/stop`, { method: "POST" });
        await loadTasks();
      } catch (error) {
        alert(error.message);
      }
    };

    stopButton.addEventListener("click", stopTask);
    headStopButton.addEventListener("click", stopTask);

    clearLogsButton.addEventListener("click", async () => {
      const confirmed = window.confirm(`确认清除任务“${task.name}”的最近日志吗？`);
      if (!confirmed) {
        return;
      }
      try {
        await request(`/api/tasks/${task.id}/logs`, { method: "DELETE" });
        await loadTasks();
      } catch (error) {
        alert(error.message);
      }
    });

    node.querySelector(".action-delete").addEventListener("click", async () => {
      const confirmed = window.confirm(`确认删除任务“${task.name}”吗？`);
      if (!confirmed) {
        return;
      }
      try {
        await request(`/api/tasks/${task.id}`, { method: "DELETE" });
        if (document.getElementById("task-id").value === task.id) {
          resetForm();
        }
        await loadTasks();
      } catch (error) {
        alert(error.message);
      }
    });

    taskList.appendChild(node);
  }

  scheduleAutoRefresh();
}

taskForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const taskId = document.getElementById("task-id").value;
  const payload = formToPayload();

  try {
    if (taskId) {
      await request(`/api/tasks/${taskId}`, {
        method: "PUT",
        body: JSON.stringify(payload),
      });
    } else {
      await request("/api/tasks", {
        method: "POST",
        body: JSON.stringify(payload),
      });
    }

    resetForm();
    await loadTasks();
  } catch (error) {
    alert(error.message);
  }
});

resetButton.addEventListener("click", resetForm);
refreshButton.addEventListener("click", loadTasks);
autoRefreshEnabledInput.addEventListener("change", () => {
  persistAutoRefreshPreferences();
  scheduleAutoRefresh();
});
autoRefreshIntervalInput.addEventListener("change", () => {
  persistAutoRefreshPreferences();
  scheduleAutoRefresh();
});
exportButton.addEventListener("click", async () => {
  try {
    await exportTasks();
  } catch (error) {
    alert(error.message);
  }
});
importButton.addEventListener("click", () => {
  importFileInput.click();
});
importFileInput.addEventListener("change", async (event) => {
  const [file] = event.target.files || [];
  if (!file) {
    return;
  }

  try {
    const imported = await importTasks(file);
    alert(`已导入 ${imported} 个任务`);
    await loadTasks();
  } catch (error) {
    alert(error.message);
  } finally {
    importFileInput.value = "";
  }
});
document.getElementById("runnerType").addEventListener("change", updateRunnerFields);
cronPartInputs.forEach((input) => {
  input.addEventListener("input", () => {
    scheduleInput.value = composeCronFromBuilder();
  });
});
scheduleInput.addEventListener("input", () => {
  syncCronBuilderFromSchedule(scheduleInput.value);
});
document.querySelectorAll(".cron-preset").forEach((button) => {
  button.addEventListener("click", () => {
    scheduleInput.value = button.dataset.cron || "";
    syncCronBuilderFromSchedule(scheduleInput.value);
    scheduleInput.focus();
  });
});

hydrateAutoRefreshPreferences();
updateRunnerFields();
syncCronBuilderFromSchedule(scheduleInput.value);
loadTasks().catch((error) => {
  taskList.innerHTML = `<div class="empty-state">${error.message}</div>`;
});
