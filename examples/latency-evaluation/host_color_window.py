#!/usr/bin/env python3
import json
import queue
import sys
import threading
import time
import tkinter as tk


COLOR_MAP = {
    "black": "#000000",
    "red": "#ff0000",
    "green": "#00ff00",
}


def now_ms():
    return time.time_ns() // 1_000_000


class HostColorWindow:
    def __init__(self):
        self.root = tk.Tk()
        self.root.title("BSole Latency Test")
        self.root.configure(bg=COLOR_MAP["black"])
        self.root.attributes("-fullscreen", True)
        self.root.attributes("-topmost", True)
        self.root.config(cursor="none")
        self.root.bind("<Escape>", self.on_close)
        self.root.protocol("WM_DELETE_WINDOW", self.on_close)

        self.command_queue = queue.Queue()
        self.stdout_lock = threading.Lock()
        self.running = True

        self.root.after(0, self.emit_ready)
        self.root.after(5, self.process_commands)

        self.reader_thread = threading.Thread(target=self.read_commands, daemon=True)
        self.reader_thread.start()

    def emit(self, message):
        with self.stdout_lock:
            sys.stdout.write(json.dumps(message) + "\n")
            sys.stdout.flush()

    def emit_ready(self):
        self.root.update_idletasks()
        self.emit(
            {
                "type": "ready",
                "width": self.root.winfo_screenwidth(),
                "height": self.root.winfo_screenheight(),
                "fullscreen": True,
                "readyAtUnixMs": now_ms(),
            }
        )

    def read_commands(self):
        for raw_line in sys.stdin:
            line = raw_line.strip()
            if not line:
                continue
            try:
                self.command_queue.put(json.loads(line))
            except Exception as error:
                self.emit({"type": "error", "message": f"Invalid command: {error}"})

    def process_commands(self):
        if not self.running:
            return

        try:
            while True:
                command = self.command_queue.get_nowait()
                self.handle_command(command)
        except queue.Empty:
            pass

        self.root.after(5, self.process_commands)

    def handle_command(self, command):
        command_type = command.get("type")
        if command_type == "setColor":
            self.set_color(command.get("color", "black"), command.get("revision"))
            return

        if command_type == "close":
            self.on_close()
            return

        self.emit({"type": "error", "message": f"Unknown command type: {command_type}"})

    def set_color(self, color_name, revision):
        color_hex = COLOR_MAP.get(color_name, COLOR_MAP["black"])
        self.root.configure(bg=color_hex)
        self.root.update_idletasks()

        def acknowledge():
            self.emit(
                {
                    "type": "presented",
                    "revision": revision,
                    "color": color_name,
                    "presentedAtUnixMs": now_ms(),
                }
            )

        self.root.after_idle(acknowledge)

    def on_close(self, *_args):
        if not self.running:
            return
        self.running = False
        self.emit({"type": "closed", "closedAtUnixMs": now_ms()})
        self.root.destroy()

    def run(self):
        self.root.mainloop()


def main():
    try:
        app = HostColorWindow()
    except Exception as error:
        print(f"[host-color-window] failed to open GUI: {error}", file=sys.stderr)
        sys.exit(1)

    app.run()


if __name__ == "__main__":
    main()
