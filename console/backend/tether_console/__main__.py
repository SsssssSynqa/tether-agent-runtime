# SPDX-License-Identifier: Apache-2.0
"""Run with: python -m tether_console"""

import os

import uvicorn


if __name__ == "__main__":
    uvicorn.run(
        "tether_console.app:app",
        host=os.environ.get("TETHER_CONSOLE_HOST", "127.0.0.1"),
        port=int(os.environ.get("TETHER_CONSOLE_PORT", "8431")),
        reload=False,
    )
