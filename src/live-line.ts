import fs from 'node:fs';

type Writer = (value: string) => void;

export class LiveLine {
  private writer: Writer | null = null;
  private ownedFd: number | null = null;
  private lastWidth = 0;
  private lastFallbackAt = 0;

  constructor(writer?: Writer) {
    if (writer) {
      this.writer = writer;
      return;
    }
    if (process.stdout.isTTY) {
      this.writer = value => process.stdout.write(value);
      return;
    }
    if (process.platform === 'win32') {
      try {
        this.ownedFd = fs.openSync('CONOUT$', 'w');
        this.writer = value => fs.writeSync(this.ownedFd!, value);
      } catch {
        this.ownedFd = null;
      }
    }
  }

  update(line: string): void {
    if (this.writer) {
      this.writer(`\r${line.padEnd(this.lastWidth)}`);
      this.lastWidth = Math.max(this.lastWidth, line.length);
      return;
    }
    const now = Date.now();
    if (!this.lastFallbackAt || now - this.lastFallbackAt >= 30_000) {
      console.log(line);
      this.lastFallbackAt = now;
    }
  }

  finish(line: string): void {
    if (this.writer) this.writer(`\r${line.padEnd(this.lastWidth)}\n`);
    else console.log(line);
    if (this.ownedFd !== null) fs.closeSync(this.ownedFd);
    this.writer = null;
    this.ownedFd = null;
  }
}
