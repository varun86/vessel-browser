import { safeStorage } from "electron";
import fs from "fs";
import path from "path";
import { createLogger } from "../../shared/logger";

const logger = createLogger("JsonPersistence");
const SECURE_STORAGE_UNAVAILABLE_MESSAGE =
  "Secure persistence requires OS-backed secret storage.";

class SecureStorageUnavailableError extends Error {
  constructor() {
    super(SECURE_STORAGE_UNAVAILABLE_MESSAGE);
    this.name = "SecureStorageUnavailableError";
  }
}

interface LoadJsonFileOptions<T> {
  filePath: string;
  fallback: T;
  parse: (raw: unknown) => T;
  secure?: boolean;
}

interface DebouncedJsonPersistenceOptions<T> {
  debounceMs: number;
  filePath: string;
  getValue: () => T | null | undefined;
  logLabel: string;
  resetOnSchedule?: boolean;
  secure?: boolean;
  serialize?: (value: T) => unknown;
}

function canUseSafeStorage(): boolean {
  try {
    return safeStorage.isEncryptionAvailable();
  } catch {
    return false;
  }
}

function assertSecureStorageAvailable(): void {
  if (
    !canUseSafeStorage() ||
    !safeStorage.encryptString ||
    !safeStorage.decryptString
  ) {
    throw new SecureStorageUnavailableError();
  }
}

function isSecureStorageUnavailableError(err: unknown): boolean {
  return err instanceof SecureStorageUnavailableError;
}

function decodeStoredData(data: Buffer, secure: boolean): string {
  if (secure) {
    assertSecureStorageAvailable();
    return safeStorage.decryptString(data);
  }
  return data.toString("utf-8");
}

function encodeStoredData(payload: string, secure: boolean): Buffer | string {
  if (secure) {
    assertSecureStorageAvailable();
    return safeStorage.encryptString(payload);
  }
  return payload;
}

export function loadJsonFile<T>({
  filePath,
  fallback,
  parse,
  secure = false,
}: LoadJsonFileOptions<T>): T {
  try {
    const raw = fs.readFileSync(filePath);
    const decoded = decodeStoredData(raw, secure);
    return parse(JSON.parse(decoded));
  } catch (err) {
    const isMissingFile =
      err instanceof Error && "code" in err && err.code === "ENOENT";
    if (isMissingFile) {
      logger.info(`Persistence file not found; using fallback defaults: ${filePath}`);
    } else if (isSecureStorageUnavailableError(err)) {
      throw err;
    } else {
      logger.warn(`Failed to load ${filePath}, using fallback:`, err);
    }
    return fallback;
  }
}

export function createDebouncedJsonPersistence<T>({
  debounceMs,
  filePath,
  getValue,
  logLabel,
  resetOnSchedule = false,
  secure = false,
  serialize,
}: DebouncedJsonPersistenceOptions<T>) {
  let saveTimer: ReturnType<typeof setTimeout> | null = null;
  let saveDirty = false;

  const persistNow = async (): Promise<void> => {
    saveDirty = false;
    if (saveTimer) {
      clearTimeout(saveTimer);
      saveTimer = null;
    }

    const value = getValue();
    if (value == null) return;

    const payload = JSON.stringify(
      serialize ? serialize(value) : value,
      null,
      2,
    );
    const data = encodeStoredData(payload, secure);

    await fs.promises
      .mkdir(path.dirname(filePath), { recursive: true })
      .then(() =>
        fs.promises.writeFile(
          filePath,
          data,
          typeof data === "string"
            ? { encoding: "utf-8", mode: 0o600 }
            : { mode: 0o600 },
        ),
      )
      .then(() => fs.promises.chmod(filePath, 0o600).catch((err) => {
        logger.warn(`Failed to chmod ${logLabel}:`, err);
      }))
      .catch((err) => logger.error(`Failed to save ${logLabel}:`, err));
  };

  const schedule = (): void => {
    saveDirty = true;
    if (saveTimer) {
      if (!resetOnSchedule) return;
      clearTimeout(saveTimer);
    }
    saveTimer = setTimeout(() => {
      saveTimer = null;
      if (saveDirty) {
        void persistNow().catch((err) => {
          logger.error(`Failed to save ${logLabel}:`, err);
        });
      }
    }, debounceMs);
  };

  const flush = (): Promise<void> => {
    return saveDirty ? persistNow() : Promise.resolve();
  };

  return {
    persistNow,
    schedule,
    flush,
  };
}
