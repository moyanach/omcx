/**
 * fileLockService.js — 路径级异步细粒度读写并发锁
 *
 * 核心特性：
 * 1. 规范化绝对路径作为锁标识，消除不同相对路径别名；
 * 2. 相同文件写入操作排他排队，杜绝并发交叉覆盖；
 * 3. 正交的不同文件完全并行并发，榨干多核与 I/O 性能；
 * 4. 内置 30s 超时防死锁看门狗。
 */

const path = require("path");

class PathLockService {
  constructor() {
    /** @type {Map<string, Promise<any>>} */
    this._locks = new Map();
  }

  normalizePath(filePath) {
    if (!filePath || typeof filePath !== "string") return "";
    return path.resolve(filePath).toLowerCase();
  }

  /**
   * 在指定文件路径上获取排他锁并执行任务
   * @template T
   * @param {string} filePath 目标文件路径
   * @param {() => Promise<T>} task 异步操作
   * @param {number} [timeoutMs=30000] 超时时间 (毫秒)
   * @returns {Promise<T>}
   */
  async withLock(filePath, task, timeoutMs = 30000) {
    const key = this.normalizePath(filePath);
    if (!key) {
      return await task();
    }

    const prevLock = this._locks.get(key) || Promise.resolve();

    let releaseLock;
    const currentLock = new Promise((resolve) => {
      releaseLock = resolve;
    });

    const chainedLock = prevLock.then(
      () => currentLock,
      () => currentLock
    );
    this._locks.set(key, chainedLock);

    let timer = null;
    try {
      await Promise.race([
        prevLock,
        new Promise((_, reject) => {
          timer = setTimeout(() => {
            reject(new Error(`文件锁等待超时 (${timeoutMs}ms): ${filePath}`));
          }, timeoutMs);
        }),
      ]);

      if (timer) clearTimeout(timer);
      return await task();
    } finally {
      if (timer) clearTimeout(timer);
      releaseLock();
      if (this._locks.get(key) === chainedLock) {
        this._locks.delete(key);
      }
    }
  }
}

const fileLockService = new PathLockService();

module.exports = {
  fileLockService,
  PathLockService,
};
