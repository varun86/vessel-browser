const os = require("os");
const path = require("path");

let wcId = 0;

function createMockWebContents() {
  wcId += 1;
  let zoom = 0;
  const ipcHandlers = new Map();
  const ipcListeners = new Map();
  return {
    id: wcId,
    isDestroyed: () => false,
    getURL: () => "about:blank",
    getTitle: () => "New Tab",
    session: {
      fromPartition: () => ({ setCertificateVerifyProc: () => {} }),
      setCertificateVerifyProc: () => {},
    },
    loadURL: () => {},
    loadFile: () => {},
    reload: () => {},
    getZoomLevel: () => zoom,
    setZoomLevel: (v) => { zoom = v; },
    setAudioMuted: () => {},
    isAudioMuted: () => false,
    isCurrentlyAudible: () => false,
    executeJavaScript: () => Promise.resolve({}),
    setWindowOpenHandler: () => {},
    on: () => {},
    once: (_event, listener) => {
      if (typeof listener === "function") listener();
    },
    removeListener: () => {},
    close: () => {},
    copy: () => {},
    paste: () => {},
    cut: () => {},
    selectAll: () => {},
    send: () => {},
    ipc: {
      handle: (channel, listener) => {
        ipcHandlers.set(channel, listener);
      },
      on: (channel, listener) => {
        ipcListeners.set(channel, listener);
      },
      _handlers: ipcHandlers,
      _listeners: ipcListeners,
    },
  };
}

function WebContentsView(opts) {
  const session = opts?.webPreferences?.session;
  this.webContents = createMockWebContents();
  if (session) {
    this.webContents.session = session;
  }
  this.setBounds = () => {};
  this.setBackgroundColor = () => {};
}

function createMockSession() {
  return {
    setUserAgent: () => {},
    getUserAgent: () => "Vessel Test",
    setCertificateVerifyProc: () => {},
    webRequest: { onBeforeRequest: () => {} },
    on: () => {},
    clearStorageData: () => Promise.resolve(),
    clearCache: () => Promise.resolve(),
  };
}

const defaultSession = createMockSession();
const ipcMainHandlers = new Map();
const ipcMainListeners = new Map();

module.exports = {
  app: {
    getPath: (name) => path.join(os.tmpdir(), `vessel-test-${name}`),
    getAppPath: () => process.cwd(),
  },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (str) => Buffer.from(str, "utf-8"),
    decryptString: (buf) => buf.toString("utf-8"),
  },
  BaseWindow: class BaseWindow {
    constructor() {
      this.contentView = { addChildView: () => {}, removeChildView: () => {} };
      this._listeners = new Map();
    }
    getContentSize() { return [1280, 800]; }
    on(event, listener) { this._listeners.set(event, listener); }
    show() { this._listeners.get("show")?.(); }
    close() { this._listeners.get("closed")?.(); }
    minimize() {}
    maximize() {}
    unmaximize() {}
    isMaximized() { return false; }
  },
  WebContentsView,
  clipboard: { writeText: () => {} },
  Menu: { buildFromTemplate: () => ({ popup: () => {} }) },
  MenuItem: class MenuItem {},
  ipcMain: {
    handle: (channel, listener) => {
      ipcMainHandlers.set(channel, listener);
    },
    on: (channel, listener) => {
      ipcMainListeners.set(channel, listener);
    },
    removeHandler: (channel) => {
      ipcMainHandlers.delete(channel);
    },
    removeListener: (channel, listener) => {
      if (ipcMainListeners.get(channel) === listener) {
        ipcMainListeners.delete(channel);
      }
    },
    _handlers: ipcMainHandlers,
    _listeners: ipcMainListeners,
  },
  session: {
    fromPartition: () => createMockSession(),
    defaultSession,
  },
};
