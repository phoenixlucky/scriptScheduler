const fs = require("fs");
const path = require("path");

function getDataPaths() {
  const appRoot = process.env.WEISCHEDULER_DATA_DIR || (process.pkg ? path.dirname(process.execPath) : __dirname);
  return {
    dataDir: path.join(appRoot, "data"),
    storeFile: path.join(appRoot, "data", "tasks.json"),
  };
}

function ensureStore() {
  const { dataDir, storeFile } = getDataPaths();
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }
  if (!fs.existsSync(storeFile)) {
    fs.writeFileSync(storeFile, JSON.stringify({ tasks: [] }, null, 2), "utf8");
  }
}

function readStore() {
  const { storeFile } = getDataPaths();
  ensureStore();
  return JSON.parse(fs.readFileSync(storeFile, "utf8"));
}

function writeStore(store) {
  const { storeFile } = getDataPaths();
  fs.writeFileSync(storeFile, JSON.stringify(store, null, 2), "utf8");
}

function getTasks() {
  return readStore().tasks.sort((a, b) => a.name.localeCompare(b.name, "zh-CN"));
}

function getTask(taskId) {
  return readStore().tasks.find((task) => task.id === taskId);
}

function saveTask(task) {
  const store = readStore();
  const index = store.tasks.findIndex((item) => item.id === task.id);
  if (index >= 0) {
    store.tasks[index] = task;
  } else {
    store.tasks.push(task);
  }
  writeStore(store);
  return task;
}

function deleteTask(taskId) {
  const store = readStore();
  store.tasks = store.tasks.filter((task) => task.id !== taskId);
  writeStore(store);
}

function appendRunLog(taskId, log) {
  const store = readStore();
  const task = store.tasks.find((item) => item.id === taskId);
  if (!task) {
    return;
  }
  task.logs = Array.isArray(task.logs) ? task.logs : [];
  task.logs.unshift(log);
  task.logs = task.logs.slice(0, 20);
  writeStore(store);
}

function clearTaskLogs(taskId) {
  const store = readStore();
  const task = store.tasks.find((item) => item.id === taskId);
  if (!task) {
    return null;
  }
  task.logs = [];
  writeStore(store);
  return task;
}

function clearActiveRun(_taskId) {}

module.exports = {
  ensureStore,
  getTasks,
  getTask,
  saveTask,
  deleteTask,
  appendRunLog,
  clearTaskLogs,
  clearActiveRun,
};
