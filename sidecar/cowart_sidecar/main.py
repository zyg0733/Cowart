from __future__ import annotations

import uvicorn

from .api import create_app
from .config import Settings


def main() -> None:
    settings = Settings.from_env()
    app = create_app(settings)
    uvicorn.run(
        app,
        host=settings.host,
        port=settings.port,
        workers=1,
        access_log=False,
        server_header=False,
    )


if __name__ == "__main__":
    main()
