type Writer = (value: string) => void;

export class LiveLine {
  private writer: Writer | null = null;
  private lastWidth = 0;
  private lastFallbackAt = 0;
  private spinner: NodeJS.Timeout | null = null;
  private spinnerLabel = '';
  private spinnerFrame = 0;

  constructor(writer?: Writer) {
    if (writer) {
      this.writer = writer;
      return;
    }
    if (process.stdout.isTTY) {
      this.writer = value => process.stdout.write(value);
      return;
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

  startSpinner(label: string): void {
    this.stopSpinner();
    this.spinnerLabel = label;
    const frames = ['|', '/', '-', '\\'];
    const tick = () => {
      const frame = frames[this.spinnerFrame++ % frames.length];
      this.update(`      Transcript [${frame}] ${this.spinnerLabel}`);
    };
    tick();
    this.spinner = setInterval(tick, 120);
  }

  setSpinnerLabel(label: string): void {
    this.spinnerLabel = label;
  }

  stopSpinner(): void {
    if (this.spinner) clearInterval(this.spinner);
    this.spinner = null;
  }

  finish(line: string): void {
    this.stopSpinner();
    if (this.writer) this.writer(`\r${line.padEnd(this.lastWidth)}\n`);
    else console.log(line);
    this.writer = null;
  }
}
