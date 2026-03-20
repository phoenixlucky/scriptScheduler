const path = require("path");
const { app, BrowserWindow, Menu, dialog, shell } = require("electron");
const packageJson = require("./package.json");

let mainWindow = null;
let startServer;
let stopServer;

function showAboutDialog() {
  dialog.showMessageBox({
    type: "info",
    title: "关于 WeiScheduler",
    message: "WeiScheduler",
    detail: [`版本: ${packageJson.version}`, packageJson.description, `数据目录: ${app.getPath("userData")}`].join("\n"),
    buttons: ["确定"],
    icon: path.join(__dirname, "build", "icon.ico"),
  });
}

function setOpenAtLogin(enabled) {
  app.setLoginItemSettings({
    openAtLogin: enabled,
    path: process.execPath,
  });
}

function buildApplicationMenu() {
  const openAtLogin = app.getLoginItemSettings().openAtLogin;
  const template = [
    {
      label: "WeiScheduler",
      submenu: [
        {
          label: "开机自启动",
          type: "checkbox",
          checked: openAtLogin,
          click: (menuItem) => {
            setOpenAtLogin(menuItem.checked);
          },
        },
        {
          label: "打开数据目录",
          click: () => {
            shell.openPath(app.getPath("userData"));
          },
        },
        { type: "separator" },
        {
          label: "关于 WeiScheduler",
          click: showAboutDialog,
        },
        { type: "separator" },
        { role: "quit", label: "退出" },
      ],
    },
    {
      label: "窗口",
      submenu: [
        { role: "reload", label: "重新加载" },
        { role: "forceReload", label: "强制重新加载" },
        { type: "separator" },
        { role: "minimize", label: "最小化" },
        { role: "togglefullscreen", label: "切换全屏" },
      ],
    },
    {
      label: "帮助",
      submenu: [
        {
          label: "关于 WeiScheduler",
          click: showAboutDialog,
        },
      ],
    },
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function createWindow(port) {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 960,
    minWidth: 1200,
    minHeight: 760,
    show: false,
    autoHideMenuBar: false,
    icon: path.join(__dirname, "build", "icon.ico"),
    webPreferences: {
      contextIsolation: true,
      sandbox: false,
    },
  });

  mainWindow.once("ready-to-show", () => {
    mainWindow.show();
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
  });

  mainWindow.loadURL(`http://127.0.0.1:${port}`);
}

async function bootstrap() {
  try {
    process.env.WEISCHEDULER_DATA_DIR = app.getPath("userData");
    ({ startServer, stopServer } = require("./server"));
    buildApplicationMenu();
    const { port } = await startServer();
    createWindow(port);
  } catch (error) {
    dialog.showErrorBox("WeiScheduler 启动失败", error.message);
    app.quit();
  }
}

const singleInstanceLock = app.requestSingleInstanceLock();

if (!singleInstanceLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (!mainWindow) {
      return;
    }
    if (mainWindow.isMinimized()) {
      mainWindow.restore();
    }
    mainWindow.focus();
  });

  app.whenReady().then(bootstrap);

  app.on("window-all-closed", () => {
    app.quit();
  });

  app.on("before-quit", () => {
    stopServer().catch(() => {});
  });

  app.on("activate", async () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      const { port } = await startServer();
      createWindow(port);
    }
  });
}
