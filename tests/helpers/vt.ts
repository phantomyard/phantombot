/**
 * A terminal, as a screen.
 *
 * Frame-content assertions cannot see a rendering fault: Ink can produce a
 * perfect frame and still put it on the wrong rows. This replays the bytes a
 * renderer actually wrote — cursor moves, erases, wrapping, and scrolling at
 * the bottom of the window — and hands back what the user would be looking at.
 *
 * Only the escapes Ink emits are implemented; anything else is skipped rather
 * than guessed at.
 */
const ESC = "";

export class VT {
  rows: string[][] = [];
  y = 0;
  x = 0;
  constructor(
    public cols: number,
    public height: number,
  ) {
    this.rows = Array.from({ length: height }, () => Array(cols).fill(" "));
  }
  private line(y: number) {
    while (this.rows.length <= y) this.rows.push(Array(this.cols).fill(" "));
    return this.rows[y]!;
  }
  private scrollIfNeeded() {
    while (this.y >= this.rows.length)
      this.rows.push(Array(this.cols).fill(" "));
    while (this.rows.length > this.height) {
      this.rows.shift();
      this.y--;
    }
  }
  write(s: string) {
    let i = 0;
    while (i < s.length) {
      const ch = s[i]!;
      if (ch === ESC) {
        const m = /^\[([0-9;?]*)([A-Za-z])/.exec(s.slice(i + 1));
        if (!m) {
          i++;
          continue;
        }
        const params = m[1]!.split(";").filter(Boolean).map(Number);
        const n = Number.isFinite(params[0]!) ? params[0]! : undefined;
        const cmd = m[2]!;
        switch (cmd) {
          case "A":
            this.y = Math.max(0, this.y - (n ?? 1));
            break;
          case "B":
            this.y += n ?? 1;
            this.scrollIfNeeded();
            break;
          case "C":
            this.x = Math.min(this.cols - 1, this.x + (n ?? 1));
            break;
          case "D":
            this.x = Math.max(0, this.x - (n ?? 1));
            break;
          case "E":
            this.y += n ?? 1;
            this.x = 0;
            this.scrollIfNeeded();
            break;
          case "F":
            this.y = Math.max(0, this.y - (n ?? 1));
            this.x = 0;
            break;
          case "G":
            this.x = Math.max(0, (n ?? 1) - 1);
            break;
          case "H":
            this.y = Math.max(0, (n ?? 1) - 1);
            this.x = Math.max(0, (params[1] ?? 1) - 1);
            break;
          case "J":
            if ((n ?? 0) === 2) {
              this.rows = Array.from({ length: this.height }, () =>
                Array(this.cols).fill(" "),
              );
              this.y = 0;
              this.x = 0;
            }
            break;
          case "K": {
            const l = this.line(this.y);
            if ((n ?? 0) === 0) for (let k = this.x; k < this.cols; k++) l[k] = " ";
            else if (n === 2) for (let k = 0; k < this.cols; k++) l[k] = " ";
            break;
          }
          default:
            break; // SGR (m), cursor show/hide (h/l), etc.
        }
        i += m[0]!.length + 1;
        continue;
      }
      if (ch === "\n") {
        this.y++;
        this.x = 0;
        this.scrollIfNeeded();
        i++;
        continue;
      }
      if (ch === "\r") {
        this.x = 0;
        i++;
        continue;
      }
      if (this.x >= this.cols) {
        this.y++;
        this.x = 0;
        this.scrollIfNeeded();
        continue;
      }
      const l = this.line(this.y);
      l[this.x] = ch;
      this.x++;
      i++;
    }
  }
  screen(): string[] {
    return this.rows.map((r) => r.join("").replace(/\s+$/, ""));
  }
}
