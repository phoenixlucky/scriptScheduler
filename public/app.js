const taskForm = document.getElementById("task-form");
const taskList = document.getElementById("task-list");
const resetButton = document.getElementById("reset-form");
const refreshButton = document.getElementById("refresh-list");
const exportButton = document.getElementById("export-tasks");
const importButton = document.getElementById("import-tasks");
const importFileInput = document.getElementById("import-file");
const formTitle = document.getElementById("form-title");
const taskTemplate = document.getElementById("task-template");
const scheduleInput = document.getElementById("schedule");
let loadTimer = null;
const expandedTaskIds = new Set();

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
  formTitle.textContent = "新建任务";
}

function renderLog(task) {
  if (task.running && task.liveLog) {
    return [
      `[${task.liveLog.stopRequested ? "stopping" : "running"}] ${task.liveLog.startedAt} -> -`,
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
    `[${latest.status}] ${latest.startedAt} -> ${latest.finishedAt || "-"}`,
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
    ["最近执行", task.lastRunAt || "从未执行"],
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
  await request(`/api/tasks/${taskId}/run`, { method: "POST" });
  await loadTasks();
  if (loadTimer) {
    window.clearTimeout(loadTimer);
  }
  loadTimer = window.setTimeout(() => {
    loadTasks().catch((error) => {
      taskList.innerHTML = `<div class="empty-state">${error.message}</div>`;
    });
  }, 800);
}

async function loadTasks() {
  const tasks = await request("/api/tasks");
  taskList.innerHTML = "";

  if (!tasks.length) {
    taskList.innerHTML = '<div class="empty-state">还没有任务，先在左侧创建一个。</div>';
    return;
  }

  for (const task of tasks) {
    const node = taskTemplate.content.firstElementChild.cloneNode(true);
    node.querySelector(".task-name").textContent = task.name;
    node.querySelector(".task-frequency").textContent = describeSchedule(task.schedule);
    node.querySelector(".task-meta").textContent = task.running
      ? "任务正在运行中"
      : `状态：${task.lastStatus}`;

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

  const hasRunningTask = tasks.some((task) => task.running);
  if (loadTimer) {
    window.clearTimeout(loadTimer);
    loadTimer = null;
  }
  if (hasRunningTask) {
    loadTimer = window.setTimeout(() => {
      loadTasks().catch((error) => {
        taskList.innerHTML = `<div class="empty-state">${error.message}</div>`;
      });
    }, 2000);
  }
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
document.querySelectorAll(".cron-preset").forEach((button) => {
  button.addEventListener("click", () => {
    scheduleInput.value = button.dataset.cron || "";
    scheduleInput.focus();
  });
});

updateRunnerFields();
loadTasks().catch((error) => {
  taskList.innerHTML = `<div class="empty-state">${error.message}</div>`;
});
