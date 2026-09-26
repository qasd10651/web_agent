import { IFileSystem } from "just-bash";

export class WebFs implements IFileSystem {
  private rootHandle: FileSystemDirectoryHandle;

  constructor(rootHandle: FileSystemDirectoryHandle) {
    this.rootHandle = rootHandle;
  }

  // 輔助函式：根據路徑解析出對應的 Handle (支援遞迴建立)
  private async getHandle(path: string, create = false, isFile = true) {
    const parts = path.split('/').filter(p => p !== '.' && p !== '');
    let currentHandle = this.rootHandle;

    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      const isLast = i === parts.length - 1;
      try {
        if (isLast && isFile) {
          return await currentHandle.getFileHandle(part, { create });
        } else {
          // 資料夾路徑：如果 create 為 true，會自動建立不存在的子資料夾
          currentHandle = await currentHandle.getDirectoryHandle(part, { create });
        }
      } catch (e) {
        throw new Error(`ENOENT: no such file or directory, '${path}'`);
      }
    }
    return currentHandle;
  }

  // 輔助函式：取得母資料夾 Handle 與目標名稱 (用來執行刪除)
  private async getParentAndName(path: string) {
    const parts = path.split('/').filter(p => p !== '.' && p !== '');
    if (parts.length === 0) throw new Error("EPERM: cannot modify root directory");
    
    const name = parts.pop()!;
    const parentPath = parts.join('/');
    const parentHandle = (await this.getHandle(parentPath, false, false)) as FileSystemDirectoryHandle;
    
    return { parentHandle, name };
  }

  // ================= 檔案讀寫 =================
  async readFile(path: string): Promise<string> {
    const handle = await this.getHandle(path, false, true) as FileSystemFileHandle;
    const file = await handle.getFile();
    return await file.text();
  }

  async readFileBuffer(path: string): Promise<Uint8Array> {
    const handle = await this.getHandle(path, false, true) as FileSystemFileHandle;
    const file = await handle.getFile();
    return new Uint8Array(await file.arrayBuffer());
  }

  async writeFile(path: string, content: FileContent): Promise<void> {
    const handle = await this.getHandle(path, true, true) as FileSystemFileHandle;
    const writable = await handle.createWritable();
    await writable.write(content);
    await writable.close();
  }

  async appendFile(path: string, content: FileContent): Promise<void> {
    const handle = await this.getHandle(path, true, true) as FileSystemFileHandle;
    const file = await handle.getFile();
    const writable = await handle.createWritable({ keepExistingData: true });
    await writable.seek(file.size);
    await writable.write(content);
    await writable.close();
  }

  // ================= 檔案與目錄管理 =================
  async mkdir(path: string, options?: { recursive?: boolean }): Promise<void> {
    // 這裡我們簡化處理，getHandle 的 create = true 會自動遞迴建立
    await this.getHandle(path, true, false);
  }

  async rm(path: string, options?: { recursive?: boolean; force?: boolean }): Promise<void> {
    try {
      const { parentHandle, name } = await this.getParentAndName(path);
      await parentHandle.removeEntry(name, { recursive: options?.recursive || false });
    } catch (e) {
      if (!options?.force) throw new Error(`ENOENT: no such file or directory, rm '${path}'`);
    }
  }

  async cp(src: string, dest: string, options?: { recursive?: boolean }): Promise<void> {
    const srcStat = await this.stat(src);
    
    if (srcStat.isFile) {
      const data = await this.readFileBuffer(src);
      await this.writeFile(dest, data);
    } else if (srcStat.isDirectory) {
      if (!options?.recursive) throw new Error(`EISDIR: is a directory, cp '${src}'`);
      await this.mkdir(dest);
      const children = await this.readdir(src);
      for (const child of children) {
        await this.cp(`${src}/${child}`, `${dest}/${child}`, options);
      }
    }
  }

  async mv(src: string, dest: string): Promise<void> {
    // Web API 沒有原生 mv，實作為 複製 (cp) + 刪除 (rm)
    await this.cp(src, dest, { recursive: true });
    await this.rm(src, { recursive: true });
  }

  // ================= 查詢與狀態 =================
  async readdir(path: string): Promise<string[]> {
    const handle = await this.getHandle(path, false, false) as FileSystemDirectoryHandle;
    const entries: string[] = [];
    for await (const name of handle.keys()) {
      entries.push(name);
    }
    return entries;
  }

  async readdirWithFileTypes(path: string): Promise<any[]> {
    const handle = await this.getHandle(path, false, false) as FileSystemDirectoryHandle;
    const entries = [];
    for await (const [name, entry] of handle.entries()) {
      entries.push({
        name,
        isFile: entry.kind === 'file',
        isDirectory: entry.kind === 'directory',
        isSymbolicLink: false
      });
    }
    return entries;
  }

  async exists(path: string): Promise<boolean> {
    if (path === '/' || path === '') return true;
    try {
      await this.stat(path);
      return true;
    } catch {
      return false;
    }
  }

  async stat(path: string): Promise<FsStat> {
    if (path === '/' || path === '') {
       return { isFile: false, isDirectory: true, isSymbolicLink: false, mode: 0o777, size: 0, mtime: new Date(), identity: "webfs-root" };
    }
    try {
      const handle = await this.getHandle(path, false, true) as FileSystemFileHandle;
      const file = await handle.getFile();
      return { isFile: true, isDirectory: false, isSymbolicLink: false, mode: 0o666, size: file.size, mtime: new Date(file.lastModified), identity: `webfs-${path}` };
    } catch {
      // 假設是資料夾
      await this.getHandle(path, false, false);
      return { isFile: false, isDirectory: true, isSymbolicLink: false, mode: 0o777, size: 0, mtime: new Date(), identity: `webfs-${path}` };
    }
  }

  async lstat(path: string): Promise<FsStat> {
    return this.stat(path); // 網頁 API 沒有 Symlink，lstat 與 stat 行為一致
  }

  // ================= 不支援的功能 (拋出 ENOTSUP) =================
  // 因為網頁瀏覽器無法存取真實作業系統的進階屬性，遇到這些操作直接拒絕
  
  writeFileSync() { throw new Error("ENOTSUP: Sync operations not supported in WebFs"); }
  mkdirSync() { throw new Error("ENOTSUP: Sync operations not supported in WebFs"); }
  
  async chmod() { throw new Error("ENOTSUP: chmod not supported in browser"); }
  async symlink() { throw new Error("ENOTSUP: symlink not supported in browser"); }
  async link() { throw new Error("ENOTSUP: hard link not supported in browser"); }
  async readlink() { throw new Error("ENOTSUP: readlink not supported in browser"); }
  async utimes() { throw new Error("ENOTSUP: utimes not supported in browser"); }
  async realpath(path: string): Promise<string> { return path; } // 因為沒有 Symlink，直接回傳原路徑即可
}
