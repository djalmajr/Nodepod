import { describe, expect, it } from "vitest";
import { NodepodTerminal } from "../sdk/nodepod-terminal";

class FakeXterm {
  buffer = "";
  cols = 80;
  rows = 24;

  clear(): void {}
  dispose(): void {}
  focus(): void {}
  loadAddon(): void {}
  onData(): { dispose: () => void } {
    return { dispose: () => {} };
  }
  open(): void {}
  write(data: string): void {
    this.buffer += data;
  }
  writeln(data: string): void {
    this.buffer += data + "\r\n";
  }
}

function createTerminal() {
  const commands: string[] = [];
  const terminal = new NodepodTerminal({ Terminal: FakeXterm } as never);
  terminal.attach({} as HTMLElement);
  terminal._wireExecution({
    getActiveAbort: () => null,
    getIsStdinRaw: () => false,
    getSendStdin: () => null,
    onCommand: async (cmd) => {
      commands.push(cmd);
      terminal._setRunning(false);
    },
    setActiveAbort: () => {},
  });

  return { commands, terminal };
}

const LEFT = "\x1b[D";
const RIGHT = "\x1b[C";
const UP = "\x1b[A";
const HOME = "\x1b[H";
const END = "\x1b[F";
const DELETE = "\x1b[3~";
const BACKSPACE = "\x7f";

describe("NodepodTerminal line editing", () => {
  it("inserts characters at the cursor after moving left", () => {
    const { commands, terminal } = createTerminal();
    terminal.input("echo ab");
    terminal.input(LEFT);
    terminal.input("X");
    terminal.input("\r");

    expect(commands).toEqual(["echo aXb"]);
  });

  it("backspaces the character left of the cursor, not the line end", () => {
    const { commands, terminal } = createTerminal();
    terminal.input("abc");
    terminal.input(LEFT);
    terminal.input(BACKSPACE);
    terminal.input("\r");

    expect(commands).toEqual(["ac"]);
  });

  it("supports home, end, and delete", () => {
    const { commands, terminal } = createTerminal();
    terminal.input("bc");
    terminal.input(HOME);
    terminal.input("a");
    terminal.input(END);
    terminal.input("d");
    terminal.input(HOME);
    terminal.input(DELETE);
    terminal.input("\r");

    expect(commands).toEqual(["bcd"]);
  });

  it("supports ctrl+a and ctrl+e", () => {
    const { commands, terminal } = createTerminal();
    terminal.input("bb");
    terminal.input("\x01");
    terminal.input("a");
    terminal.input("\x05");
    terminal.input("c");
    terminal.input("\r");

    expect(commands).toEqual(["abbc"]);
  });

  it("clamps cursor movement at both ends", () => {
    const { commands, terminal } = createTerminal();
    terminal.input("ab");
    terminal.input(LEFT + LEFT + LEFT + LEFT);
    terminal.input(RIGHT + RIGHT + RIGHT + RIGHT);
    terminal.input("c");
    terminal.input("\r");

    expect(commands).toEqual(["abc"]);
  });

  it("resets the cursor to the end when history replaces the line", () => {
    const { commands, terminal } = createTerminal();
    terminal.input("first\r");
    terminal.input(UP);
    terminal.input("!");
    terminal.input("\r");

    expect(commands).toEqual(["first", "first!"]);
  });
});
