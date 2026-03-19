const fs = require("fs");
const path = require("path");

const dataDir = path.join(__dirname, "data");
const storeFile = path.join(dataDir, "tasks.json");

function ensureStore() {
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }
  if (!fs.existsSync(storeFile)) {
    fs.writeFileSync(storeFile, JSON.stringify({ tasks: [] }, null, 2), "utf8");
  }
}

function readStore() {
  ensureStore();
  return JSON.parse(fs.readFileSync(storeFile, "utf8"));
}

function writeStore(store) {
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

function clearActiveRun(_taskId) {}

module.exports = {
  ensureStore,
  getTasks,
  getTask,
  saveTask,
  deleteTask,
  appendRunLog,
  clearActiveRun,
};
