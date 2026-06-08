// 增强 SDK alpha.1 的 Songloft 接口，补齐尚未纳入官方的 fs / command 类型
import '@songloft/plugin-sdk';

declare module '@songloft/plugin-sdk' {
  interface Songloft {
    fs: SongloftFS;
    command: SongloftCommand;
  }
}

interface FsDirEntry {
  name: string;
  isDir: boolean;
}

interface FsStatResult {
  size: number;
  modTime: number;
  isDir: boolean;
}

interface SongloftFS {
  readFile(path: string, options?: { encoding?: 'utf8' | 'base64' }): Promise<string>;
  writeFile(path: string, data: string, options?: { encoding?: 'utf8' | 'base64' }): Promise<void>;
  appendFile(path: string, data: string, options?: { encoding?: 'utf8' | 'base64' }): Promise<void>;
  readdir(path: string): Promise<FsDirEntry[]>;
  unlink(path: string): Promise<void>;
  exists(path: string): Promise<boolean>;
  mkdir(path: string, options?: { recursive?: boolean }): Promise<void>;
  stat(path: string): Promise<FsStatResult>;
  rename(oldPath: string, newPath: string): Promise<void>;
}

interface CommandExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

interface SongloftCommand {
  exec(program: string, args?: string[], options?: {
    timeout?: number; stdin?: string; env?: Record<string, string>;
  }): Promise<CommandExecResult>;
  start(name: string, program: string, args?: string[], options?: {
    env?: Record<string, string>;
  }): Promise<{ pid: number }>;
  stop(name: string): Promise<void>;
  isRunning(name: string): Promise<boolean>;
  download(url: string, filename: string, options?: {
    extract?: 'tgz';
    extractTarget?: string;
  }): Promise<void>;
  deleteBin(filename: string): Promise<void>;
  listBin(): Promise<string[]>;
  exists(filename: string): Promise<boolean>;
}
