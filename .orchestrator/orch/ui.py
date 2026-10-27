"""Terminal progress output."""
from __future__ import annotations

import contextlib
import os
import sys
import threading
import time
from typing import Iterator, Optional, TextIO

_COLORS = {"ok": "32", "warn": "33", "error": "31", "info": "36", "dim": "2", "bold": "1"}


class UI:
    def __init__(self, stream: Optional[TextIO] = None, color: Optional[bool] = None):
        self.stream = stream or sys.stdout
        tty = hasattr(self.stream, "isatty") and self.stream.isatty()
        self.tty = tty
        self.color = tty and not os.environ.get("NO_COLOR") if color is None else color

    def _c(self, text: str, kind: str) -> str:
        return f"\033[{_COLORS[kind]}m{text}\033[0m" if self.color else text

    def _print(self, text: str) -> None:
        print(text, file=self.stream, flush=True)

    def banner(self, text: str) -> None:
        self._print(self._c(text, "bold"))

    def step(self, n: int, phase: str, round_no: int, agent: str, message: str, kind: str = "info") -> None:
        tag = self._c(f"[{n:02d}]", "dim")
        label = f"{phase} r{round_no}".ljust(16)
        self._print(f"{tag} {self._c(label, kind)} {agent.ljust(7)} {message}")

    def info(self, message: str) -> None:
        self._print(message)

    def warn(self, message: str) -> None:
        self._print(self._c("warning: ", "warn") + message)

    def error(self, message: str) -> None:
        self._print(self._c("error: ", "error") + message)

    def ok(self, message: str) -> None:
        self._print(self._c(message, "ok"))

    @contextlib.contextmanager
    def waiting(self, label: str) -> Iterator[None]:
        """Show an elapsed-time ticker while a long call runs (TTY only)."""
        if not self.tty:
            yield
            return
        stop = threading.Event()
        started = time.monotonic()

        def tick() -> None:
            while not stop.wait(1.0):
                elapsed = int(time.monotonic() - started)
                self.stream.write(f"\r     … {label} {elapsed // 60}m{elapsed % 60:02d}s ")
                self.stream.flush()

        thread = threading.Thread(target=tick, daemon=True)
        thread.start()
        try:
            yield
        finally:
            stop.set()
            thread.join()
            self.stream.write("\r\033[K")
            self.stream.flush()
