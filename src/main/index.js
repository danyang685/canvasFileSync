import { app, Menu, dialog, ipcMain, BrowserWindow, Tray, Notification } from 'electron' // eslint-disable-line
import { autoUpdater } from 'electron-updater';
import * as Sentry from '@sentry/electron';
import canvasIntegration from '../utils/canvasIntegration';

Sentry.init({ dsn: 'https://312e7fd7b4784962ba2948b19547c3cc@sentry.io/1311555' });
const path = require('path');
const log = require('electron-log');
const _ = require('lodash');
const applicationMenu = require('./application-menus');
const dataStorageFile = require('../utils/dataStorage');
const fs = require('fs');
const moment = require('moment');
const dataStorage = dataStorageFile.default;
const requestPromise = require('request-promise');
const request = require('request');
const pMap = require('p-map');
const PrettyError = require('pretty-error');
const pe = new PrettyError();
autoUpdater.autoDownload = true;
autoUpdater.logger = require('electron-log');
autoUpdater.logger.transports.file.level = 'info';

/**
 * Set `__static` path to static files in production
 * https://simulatedgreg.gitbooks.io/electron-vue/content/en/using-static-assets.html
 */
if (process.env.NODE_ENV !== 'development') {
  global.__static = path.join(__dirname, '/static').replace(/\\/g, '\\\\') // eslint-disable-line
  app.setLoginItemSettings({ openAtLogin: true, openAsHidden: true });
}

let mainWindow = null;
let tray;
let syncing = false;
let defaultFolder = '';
const winURL = process.env.NODE_ENV === 'development'
  ? 'http://localhost:9080'
  : `file://${__dirname}/index.html`;

const createWindow = () => {
  if (app.dock) app.dock.show();
  mainWindow = new BrowserWindow({
    minHeight: 650,
    minWidth: 1000,
    height: 650,
    width: 1000,
    webPreferences: { webSecurity: false },
    transparent: true,
    frame: false,
  });

  log.info('window created');
  mainWindow.loadURL(winURL);
  log.info('loaded url');

  mainWindow.on('closed', () => {
    if (app.dock) app.dock.hide();
    mainWindow = null;
  });
};

const notConnectedMenu = [
  {
    label: 'Connect',
    enabled: true,
    click() {
      if (mainWindow === null) {
        createWindow();
      }
    },
  },
  {
    label: 'Quit',
    click() {
      app.quit();
    },
    accelerator: 'CommandOrControl+Q',
  },
];

const syncingMenu = [
  {
    label: 'Syncing...',
    icon: path.join(__static, 'icons_normal/loading.png'),
    enabled: false,
  },
  {
    label: 'Open',
    enabled: true,
    click() {
      if (mainWindow === null) {
        createWindow();
      }
    },
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
      label: 'Open',
      enabled: true,
      click() {
        if (mainWindow === null) {
          createWindow();
        }
      },
    },
    {
      label: 'Restart',
      enabled: true,
      click() {
        app.relaunch({ args: process.argv.slice(1).concat(['--relaunch']) });
        app.exit(0);
      },
    },
    {
      label: 'Quit',
      enabled: true,
      click() {
        app.quit();
      },
    },
  ];
};

app.on('ready', async () => {
  defaultFolder = app.getPath('documents');
  Menu.setApplicationMenu(applicationMenu);
  tray = new Tray(
    path.join(__static, 'icons_normal/icons/png/32x32@2x.png') // eslint-disable-line
  );
  tray.setPressedImage(
    path.join(__static, 'icons_inverted/icons/png/32x32@2x.png') // eslint-disable-line
  );

  // handles windows
  tray.on('right-click', async () => {
    if (await dataStorage.isConnected() && !syncing) {
      updateMenu(getUpdatedConnectedMenu(await dataStorage.getLastSynced()));
    }
  });

  // handles mac
  tray.on('mouse-enter', async () => {
    if (await dataStorage.isConnected() && !syncing) {
      updateMenu(getUpdatedConnectedMenu(await dataStorage.getLastSynced()));
    }
  });

  if (await dataStorage.isConnected()) {
    if (await dataStorage.hasCheckedModules()) {
      log.info('we already have modules');
    } else {
      const hello = new Notification({ title: 'Now supporting Canvas Modules', body: 'Click to get your Modules if you have any' });
      hello.show();
      hello.on('click', () => {
        createWindow();
      });
    }
    if (app.dock) app.dock.hide();
    updateMenu(getUpdatedConnectedMenu(await dataStorage.getLastSynced()));
  } else {
    updateMenu(notConnectedMenu);
    createWindow();
  }
  // handles recurring sync
  let delay = 60 * 1000;
  setTimeout(async function changeTimeout() {
    if (process.env.NODE_ENV === 'production') {
      autoUpdater.checkForUpdates();
    }
    if (await dataStorage.isConnected() && !syncing) {
      // multiple by 60000 because syncfreq is in minutes
      delay = 60000 * (await dataStorage.getSyncFrequency());
      sync(await dataStorage.getLastSynced());
    }
    setTimeout(changeTimeout, delay);
  }, delay);
});

app.on('window-all-closed', () => {
  if (app.dock) app.dock.hide();
});

ipcMain.on('choose-folder', (event) => {
  let folder = dialog.showOpenDialog({ properties: ['openDirectory'] });
  if (folder === undefined) {
    folder = 'No folder chosen';
  }
  event.sender.send('chose-folder', folder);
});

const streamFile = (file) => {
  return new Promise((resolve, reject) => {
    const writeStream = fs.createWriteStream(file.fullPath);

    request.get(file.url)
      .on('error', reject)
      .pipe(writeStream)
      .on('close', resolve);
  });
};

const downloadFiles = async (event, files) => {
  const totalDownloadSize = _.sumBy(files, 'size');
  let downloadedBytes = 0;
  let filesDownloaded = 0;
  let failedDownloads = 0;

  await pMap(files, async (file) => {
    try {
      await streamFile(file);

      downloadedBytes += file.size;
      const completionPercentage = (downloadedBytes / totalDownloadSize) * 100;

      filesDownloaded += 1;

      event.sender.send('update-progress', completionPercentage);
    } catch (error) {
      log.error(file);
      failedDownloads += 1;
      console.error(JSON.stringify({
        error,
        failedDownloads,
        filesDownloaded,
      }, null, 2));
    }
  }, { concurrency: 20 });

  const report = { filesDownloaded, failedDownloads };
  log.info({ report });

  event.sender.send('download-report', report);
};


ipcMain.on('download-files', downloadFiles);

ipcMain.on('download-started', async () => {
  const started = new Notification({ title: 'Download Started', body: 'Don\'t close this window until it is completed' });
  started.show();
});

const syncDownloadFiles = async (files, rootFolder) => {
  return Promise.all(_.map(files, async (file) => {
    try {
      const options = {
        method: 'GET',
        uri: file.url,
        json: true,
        encoding: null,
      };
      const response = await requestPromise.get(options);
      const buffer = Buffer.from(response, 'utf8');
      await fs.writeFileSync(path.join(rootFolder, file.filePath), buffer);
      return file;
    } catch (err) {
      log.error(err);
      return file;
    }
  }));
};

const conflictDownload = async (file, rootFolder) => {
  return new Promise(async (resolve, reject) => {
    try {
      const options = {
        method: 'GET',
        uri: file.url,
        json: true,
        encoding: null,
      };
      const response = await requestPromise.get(options);
      const buffer = Buffer.from(response, 'utf8');
      await fs.writeFileSync(path.join(rootFolder, file.filePath), buffer);
      resolve(file);
    } catch (err) {
      log.error(err);
      reject(file);
    }
  });
};

const getFileNamesInFolder = async (folderPath) => {
  return fs.readdirSync(folderPath);
};

ipcMain.on('download-conflict-file', async (event, payload) => {
  const { file, rootFolder } = payload;
  conflictDownload(file, rootFolder).then(() => {
    event.sender.send('downloaded-conflict-file', file);
  });
});

ipcMain.on('syncing', async () => {
  syncing = true;
  updateMenu(syncingMenu);
});

ipcMain.on('get-filenames-in-folder', async (event, folderPath) => {
  event.sender.send('returning-filenames', await getFileNamesInFolder(folderPath));
});

ipcMain.on('rename-file', async (event, payload) => {
  const { filePath, newFilePath } = payload;
  await fs.renameSync(filePath, newFilePath);
  event.sender.send('renamed-file');
});

ipcMain.on('syncing-done', async () => {
  syncing = false;
  updateMenu(getUpdatedConnectedMenu(await dataStorage.getLastSynced()));
});

ipcMain.on('completed-initial-sync', async () => {
  const started = new Notification({ title: 'Download Finished', body: 'Close the window and we\'ll keep you updated' });
  started.show();
  updateMenu(getUpdatedConnectedMenu(await dataStorage.getLastSynced()));
});

ipcMain.on('disconnect', async (e) => {
  dataStorage.wipeState();
  updateMenu(notConnectedMenu);
  e.sender.send('disconnected');
});

ipcMain.on('create-folders', async (event, folders) => {
  await createFolders(folders);
  event.sender.send('folders-created');
});

ipcMain.on('get-default-folder', async (event) => {
  log.info(defaultFolder);
  event.sender.send('got-default-folder', defaultFolder);
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
  try {
    syncing = true;
    updateMenu(syncingMenu);
    let allConflictFiles = [];
    const allCourses = await dataStorage.getCourses();
    const authToken = await dataStorage.getAuthToken();
    const rootURL = await dataStorage.getRootURL();
    const rootFolder = await dataStorage.getRootFolder();
    const { hasUpdates,
      newCourses,
      removedCourseIDs } = await checkForNewAndRemovedCourses(authToken, rootURL, allCourses);
    let updatedCourses = _.cloneDeep(allCourses);
    if (hasUpdates) {
      log.info('has course updates');
      if (newCourses.length > 0) {
        await dataStorage.setHasNewCourses(true);
        const newBuiltCourses = await Promise.all(_.map(newCourses, async (course) => {
          const builtCourse = await canvasIntegration
            .buildCourseMap(authToken, rootURL, course);
          builtCourse.sync = false;
          return builtCourse;
        }));
        updatedCourses.push(...newBuiltCourses);
        // log.info(updatedCourses);
      }
      if (removedCourseIDs.length > 0) {
        await Promise.all(_.remove(updatedCourses), async (course) => {
          return removedCourseIDs.includes(course.id);
        });
        // log.info('courses');
        // log.info(updatedCourses);
      }
    } else {
      log.info('no updates to courses');
      const syncableCourses = await dataStorage.getSyncableCourses();
      updatedCourses = await Promise.all(_.map(syncableCourses, async (course) => {
        let currentCourse = course;
        let allNewFolders = [];
        let allNewFiles = [];
        // getting any new modules - adding them to courses object
        const { courseWithNewModules, newModules, hasUpdates } = await getNewModules(authToken,
          rootURL, course);
        log.info({ newModules });
        // log.info(`Course: ${course.name} has updates: ${hasUpdates}`);
        if (hasUpdates) {
          allNewFolders = allNewFolders.concat(_.map(newModules, (newModule) => {
            return newModule.modulePath;
          }));
          const { updatedModulesFiles, courseWithModulesFiles } = await canvasIntegration
            .getUpdatedModulesFiles(authToken, newModules, courseWithNewModules, lastSynced);
          allNewFiles = allNewFiles.concat(_.flatten(updatedModulesFiles));
          currentCourse = courseWithModulesFiles;
        }
        // getting new folders
        const { courseWithNewFolders, newFolders } = await getNewFolders(authToken,
          rootURL, currentCourse, lastSynced);
        // log.info({ newFolders });
        currentCourse = courseWithNewFolders;
        allNewFolders = allNewFolders.concat(_.flatten(_.map(newFolders, (newFolder) => {
          return path.join(rootFolder, newFolder.folderPath);
        })));
        // log.info({ allNewFolders });
        // create folders from both the modules view and from the files view
        await createFolders(allNewFolders);
        if (course.hasFilesTab) {
          // get new or updated files from files view
          const { courseWithNewFilesAndFolders, newOrUpdatedFiles } = await getNewFiles(authToken,
            rootURL, currentCourse, lastSynced);
          allNewFiles = allNewFiles.concat(newOrUpdatedFiles);
          currentCourse = courseWithNewFilesAndFolders;
        }
        // log new files, but only if they exist
        if (allNewFiles.length > 0) log.info({ allNewFiles });
        // get conflicting files to store them in separate place
        const conflictFiles = _.filter(allNewFiles, (newFile) => {
          try {
            const lastModifiedByUser = fs.statSync(path.join(rootFolder, newFile.filePath)).mtimeMs;
            const currentCourseFile = _.find(course.files, (courseFile) => {
              return courseFile.filePath === newFile.filePath;
            });
            return lastModifiedByUser > currentCourseFile.lastUpdated;
          } catch (err) {
            return false;
          }
        });
        allConflictFiles = allConflictFiles.concat(conflictFiles);

        // log conflicting files, but only if they exist
        if (conflictFiles.length > 0) log.info({ allConflictFiles });
        // get safe files to be downloaded
        const safeFiles = _.filter(allNewFiles, (newFile) => {
          try {
            const lastModifiedByUser = fs.statSync(path.join(rootFolder, newFile.filePath)).mtimeMs;
            const currentCourseFile = _.find(course.files, (courseFile) => {
              return courseFile.filePath === newFile.filePath;
            });
            return lastModifiedByUser < currentCourseFile.lastUpdated;
          } catch (err) {
            return true;
          }
        });
        const downloadedFiles = await syncDownloadFiles(safeFiles, rootFolder);
        await Promise.all(_.forEach(downloadedFiles, async (file) => {
          const fileIndex = _.findIndex(currentCourse.files,
            { filePath: file.filePath });
          currentCourse.files[fileIndex].lastUpdated = Date.now();
        }));
        return currentCourse;
      }));
    }
    await dataStorage.addConflicts(allConflictFiles);
    await dataStorage.updateCourses(updatedCourses);
    await dataStorage.updateLastSynced();
    syncing = false;
    updateMenu(getUpdatedConnectedMenu(await dataStorage.getLastSynced()));
    if (allConflictFiles.length > 1) {
      const newConflicts = new Notification({ title: 'Conflict', body: 'Your teacher edited files that you have also edited. Click here' });
      newConflicts.show();
      newConflicts.on('click', () => {
        createWindow();
      });
    } else if (allConflictFiles.length > 0) {
      const newConflicts = new Notification({ title: 'Conflict', body: 'Your teacher edited a file that you have also edited. Click here' });
      newConflicts.show();
      newConflicts.on('click', () => {
        createWindow();
      });
    }
    if (await dataStorage.getHasNewCourses()) {
      const newCourses = new Notification({ title: 'New courses available', body: 'Click to choose which you want to sync' });
      newCourses.show();
      newCourses.on('click', () => {
        createWindow();
      });
    }
  } catch (err) {
    log.error(pe.render(err));
  }
};

const getNewFiles = async (authToken, rootURL, course, lastSynced) => {
  const courseWithNewFilesAndFolders = JSON.parse(JSON.stringify(course));
  const newOrUpdatedFiles = [];
  try {
    if (courseWithNewFilesAndFolders.hasFilesTab) {
      const courseHasNewFile = await canvasIntegration.hasNewFile(authToken,
        rootURL,
        courseWithNewFilesAndFolders.id,
        lastSynced);
      if (courseHasNewFile) {
        log.info('has new file(s)');
        const courseFiles = await canvasIntegration.getAllNewOrUpdatedFiles(authToken,
          courseWithNewFilesAndFolders, lastSynced);
        log.info(`num new or updated course files: ${courseFiles.length}`);
        for (let j = 0; j < courseFiles.length; j += 1) {
          const fileIndex = _.findIndex(courseWithNewFilesAndFolders.files,
            { filePath: courseFiles[j].filePath });
          const fileWithID = JSON.parse(JSON.stringify(courseFiles[j]));
          fileWithID.courseID = courseWithNewFilesAndFolders.id;
          newOrUpdatedFiles.push(fileWithID);
          if (fileIndex >= 0) {
            log.info('updating file');
            courseWithNewFilesAndFolders.files[fileIndex] = courseFiles[j];
          } else {
            courseWithNewFilesAndFolders.files.push(courseFiles[j]);
          }
        }
      } else {
        // log.info('no new files');
      }
    }
    return { courseWithNewFilesAndFolders, newOrUpdatedFiles };
  } catch (err) {
    log.error('Error getting new files');
    log.error(pe.render(err));
    return { courseWithNewFilesAndFolders, newOrUpdatedFiles };
  }
};

const getNewFolders = async (authToken, rootURL, course, lastSynced) => {
  const newFolders = [];
  const courseWithNewFolders = JSON.parse(JSON.stringify(course));
  try {
    if (courseWithNewFolders.hasFilesTab) {
      const courseNewFolders = await canvasIntegration.getNewFolders(authToken,
        rootURL, courseWithNewFolders, lastSynced);
      for (let j = 0; j < courseNewFolders.length; j += 1) {
        const folderIndex = _.findIndex(courseWithNewFolders.folders,
          { folderPath: courseNewFolders[j].folderPath });
        if (folderIndex >= 0) {
          log.info('updating folder');
          courseWithNewFolders.folders[folderIndex] = courseNewFolders[j];
        } else {
          log.info('brand new folder');
          courseWithNewFolders.folders.push(courseNewFolders[j]);
          newFolders.push(courseNewFolders[j]);
        }
      }
    }
    return { courseWithNewFolders, newFolders };
  } catch (err) {
    log.error('Error getting new folders');
    log.error(pe.render(err));
    return { courseWithNewFolders, newFolders };
  }
};

const getNewModules = async (authToken, rootURL, course) => {
  let newModules = [];
  let hasUpdates = false;
  const courseWithNewModules = JSON.parse(JSON.stringify(course));
  try {
    if (courseWithNewModules.hasModulesTab) {
      const modules = await canvasIntegration.getModules(authToken,
        rootURL, courseWithNewModules);
      if (modules.length > courseWithNewModules.modules.length) {
        courseWithNewModules.modules = modules;
        newModules = newModules.concat(modules);
        hasUpdates = true;
      } else {
        log.info('no new modules. checking for new module items');
        for (let j = 0; j < modules.length; j += 1) {
          if (modules[j].items_count !== courseWithNewModules.modules[j].items_count) {
            courseWithNewModules.modules[j] = modules[j];
            newModules.push(modules[j]);
            hasUpdates = true;
          }
        }
      }
    }
    return { courseWithNewModules, newModules, hasUpdates };
  } catch (err) {
    log.error('Error getting new modules');
    log.error(pe.render(err));
    return { courseWithNewModules, newModules, hasUpdates };
  }
};

// checks for new courses/removed courses. Returns { hasUpdates, newCourseIDs, removedCourseIDs }
const checkForNewAndRemovedCourses = async (authToken, rootURL, courses) => {
  try {
    const currentCourseIDs = await _.map(courses, 'id');
    const coursesFromCanvas = await canvasIntegration.getCourses(authToken, rootURL);
    const courseIDsFromCanvas = await _.map(coursesFromCanvas.response, 'id');
    const newCourseIDs = await _.difference(courseIDsFromCanvas, currentCourseIDs);
    const removedCourseIDs = await _.difference(currentCourseIDs, courseIDsFromCanvas);
    const newCourses = [];
    await Promise.all(_.forEach(coursesFromCanvas.response, (course) => {
      if (newCourseIDs.includes(course.id)) {
        newCourses.push(course);
      }
    }));
    if (newCourseIDs.length === 0 && removedCourseIDs.length === 0) {
      return {
        hasUpdates: false,
        newCourses,
        removedCourseIDs,
      };
    }
    return {
      hasUpdates: true,
      newCourses,
      removedCourseIDs,
    };
  } catch (err) {
    log.error(pe.render(err));
    return {
      hasUpdates: false,
      newCourses: [],
      removedCourseIDs: [],
    };
  }
};

const createFolders = async (folders) => {
  return Promise.all(
    _.forEach(folders, async (folder) => {
      try {
        await fs.accessSync(folder, fs.constants.F_OK);
        return 'Folder already exists';
      } catch (err) {
        log.info(`Created folder ${folder}`);
        return fs.mkdirSync(folder);
      }
    }));
};
