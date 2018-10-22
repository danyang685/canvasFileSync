// const { app, BrowserWindow, Menu, dialog, Tray } = require("electron");
import { app, Menu, dialog, ipcMain, BrowserWindow, Tray, ipcRenderer } from 'electron' // eslint-disable-line
import canvasIntegration from '../utils/canvasIntegration';
const path = require('path');
const _ = require('lodash');
const applicationMenu = require('./application-menus');
const dataStorageFile = require('../utils/dataStorage');
const moment = require('moment');
const dataStorage = dataStorageFile.default;
const fs = require('fs');
const request = require('request-promise');


/**
 * Set `__static` path to static files in production
 * https://simulatedgreg.gitbooks.io/electron-vue/content/en/using-static-assets.html
 */
if (process.env.NODE_ENV !== 'development') {
  global.__static = path.join(__dirname, '/static').replace(/\\/g, '\\\\') // eslint-disable-line
}

let mainWindow;
let tray;
const winURL = process.env.NODE_ENV === 'development'
  ? 'http://localhost:9080'
  : `file://${__dirname}/index.html`;

const notConnectedMenu = [
  {
    label: 'Connect',
    enabled: true,
  },
  {
    label: 'Sign Out',
    enabled: false,
  },
  {
    label: 'Quit',
    click() {
      app.quit();
    },
    accelerator: 'CommandOrControl+Q',
  },
];

const getUpdatedConnectedMenu = (lastSynced) => {
  return [
    {
      label: `Last Synced: ${moment(lastSynced).fromNow()}`,
      enabled: false,
    },
    {
      label: 'Sync Now',
      enabled: true,
      click() {
        sync(lastSynced);
      },
    },
    {
      label: 'Sign Out',
      enabled: true,
    },
    {
      label: 'Quit',
    },
  ];
};

function createWindow() {
  /**
   * Initial window options
   */
  mainWindow = new BrowserWindow({
    height: 600,
    width: 1000,
    webPreferences: { webSecurity: false },
  });

  mainWindow.loadURL(winURL);

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

app.on('ready', async () => {
  if (process.platform !== 'darwin') {
    Menu.setApplicationMenu(null);
  } else {
    Menu.setApplicationMenu(applicationMenu);
  }
  console.log(__static); // eslint-disable-line
  tray = new Tray(
    path.join(__static, 'icons_normal/icons/png/32x32@2x.png') // eslint-disable-line
  );
  tray.setPressedImage(
    path.join(__static, 'icons_inverted/icons/png/32x32@2x.png') // eslint-disable-line
  );

  if (await dataStorage.isConnected()) {
    if (app.dock) app.dock.hide();
    console.log(await dataStorage.getLastSynced());
    updateMenu(getUpdatedConnectedMenu(await dataStorage.getLastSynced()));
  } else {
    updateMenu(notConnectedMenu);
    createWindow();
  }
});

app.on('window-all-closed', () => {
  if (app.dock) app.dock.hide();
});

ipcMain.on('choose-folder', (event) => {
  const folder = dialog.showOpenDialog({ properties: ['openDirectory'] });
  event.sender.send('chose-folder', folder);
});

ipcMain.on('download-file', async (e, args) => {
  const { options, file } = args;
  try {
    const response = await request.get(options);
    const buffer = Buffer.from(response, 'utf8');
    await fs.writeFileSync(file.fullPath, buffer);
    return e.sender.send('file-downloaded', file);
  } catch (err) {
    console.error(err);
    return e.sender.send('file-download-failed', file);
  }
});

ipcMain.on('create-folder', (event, folder) => {
  fs.access(path.resolve(folder), fs.constants.F_OK, (err) => {
    if (err) {
      fs.mkdir(folder, () => {
        event.sender.send('folder-created', folder);
      });
    } else {
      event.sender.send('folder-created', folder);
    }
  });
});

app.on('activate', () => {
  if (mainWindow === null) {
    createWindow();
  }
});

const updateMenu = (template) => {
  const menu = Menu.buildFromTemplate(template);
  tray.setContextMenu(menu);
};

const sync = async (lastSynced) => {
  const courses = await dataStorage.getSyncableCourses();
  const authToken = await dataStorage.getAuthToken();
  const rootURL = await dataStorage.getRootURL();
  const rootFolder = await dataStorage.getRootFolder();
  const newFolders = await getNewFolders(authToken, rootURL, courses, lastSynced);
  console.log(newFolders);
  const foldersToBeCreated = _.flatten(newFolders);
  console.log(foldersToBeCreated);
  console.log('last');
  await createNewFolders(rootFolder, foldersToBeCreated);
  const coursesWithNewFiles = await filterCoursesWithNewFiles(lastSynced,
    courses, authToken, rootURL);
  console.log(coursesWithNewFiles);
};

// const filterCoursesWithNewFolders = async (lastSynced, courses, authToken, rootURL) => {
//   const coursesWithNewFolders = [];
//   /* eslint-disable no-await-in-loop */
//   for (let i = 0; i < courses.length; i += 1) {
//     const courseHasNewFolder = await canvasIntegration.hasNewFolder(authToken,
//       rootURL,
//       courses[i].id,
//       lastSynced,
//     );
//     if (courseHasNewFolder) {
//       coursesWithNewFolders.push(courses[i]);
//     }
//   }
//   return coursesWithNewFolders;
// };

const filterCoursesWithNewFiles = async (lastSynced, courses, authToken, rootURL) => {
  const coursesWithNewFiles = [];
  /* eslint-disable no-await-in-loop */
  for (let i = 0; i < courses.length; i += 1) {
    const courseHasNewFile = await canvasIntegration.hasNewFile(authToken,
      rootURL,
      courses[i].id,
      lastSynced);
    if (courseHasNewFile) {
      coursesWithNewFiles.push(courses[i]);
    }
  }
  return coursesWithNewFiles;
};

const getNewFolders = async (authToken, rootURL, courses, lastSynced) => {
  const newFolders = [];
  /* eslint-disable no-await-in-loop */
  for (let i = 0; i < courses.length; i += 1) {
    const courseNewFolders = await canvasIntegration.getNewFolders(authToken,
      rootURL, courses[i], lastSynced);
    newFolders.push(courseNewFolders);
  }
  return newFolders;
};

const createNewFolders = async (rootFolder, folders) => {
  return Promise.all(
    _.forEach(folders, async (folder) => {
      try {
        await fs.accessSync(path.join(rootFolder, folder.folderPath), fs.constants.F_OK);
        return await fs.mkdirSync(path.join(rootFolder, folder.folderPath));
      } catch (err) {
        console.error('Folder already exists');
        return 'Folder already exists';
      }
    }));
};

/**
 * Auto Updater
 *
 * Uncomment the following code below and install `electron-updater` to
 * support auto updating. Code Signing with a valid certificate is required.
 * https://simulatedgreg.gitbooks.io/electron-vue/content/en/using-electron-builder.html#auto-updating
 */

/*
import { autoUpdater } from 'electron-updater'

autoUpdater.on('update-downloaded', () => {
  autoUpdater.quitAndInstall()
})

app.on('ready', () => {
  if (process.env.NODE_ENV === 'production') autoUpdater.checkForUpdates()
})
 */
