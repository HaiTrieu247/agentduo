#!/usr/bin/env python3
"""Multi-agent development orchestrator.

    python3 .orchestrator/orchestrator.py "Implement JWT authentication with refresh tokens"
    python3 .orchestrator/orchestrator.py --resume [RUN_ID] [--decision resume|revise|abort --note "..."]
    python3 .orchestrator/orchestrator.py --status | --list | --doctor
"""
import sys
from pathlib import Path

sys.dont_write_bytecode = True  # keep the snapshotted working tree free of __pycache__
sys.path.insert(0, str(Path(__file__).resolve().parent))

from orch.cli import main  # noqa: E402

if __name__ == "__main__":
    sys.exit(main())
