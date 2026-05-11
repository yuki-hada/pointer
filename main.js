const { app, BrowserWindow, ipcMain, dialog, Menu, shell } = require('electron');
const path = require('path');
const fs = require('fs');

let mainWindow;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#1a1a2e',
    title: 'Pointer',
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
    },
  });
  mainWindow.loadFile('index.html');
}

function buildMenu() {
  const helpMenu = {
    label: 'Help',
    submenu: [
      {
        label: 'Open Source Licenses',
        click: () => shell.openPath(path.join(app.getAppPath(), 'LICENSES.txt')),
      },
    ],
  };

  const template =
    process.platform === 'darwin'
      ? [{ label: app.name, submenu: [{ role: 'quit' }] }, { role: 'editMenu' }, helpMenu]
      : [{ role: 'editMenu' }, helpMenu];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

app.whenReady().then(() => {
  buildMenu();
  createWindow();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

ipcMain.handle('open-pdb', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Open PDB File',
    filters: [
      { name: 'PDB Files', extensions: ['pdb', 'ent'] },
      { name: 'All Files', extensions: ['*'] },
    ],
    properties: ['openFile'],
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  const filePath = result.filePaths[0];
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    return { filePath, content };
  } catch (e) {
    return { error: e.message };
  }
});
