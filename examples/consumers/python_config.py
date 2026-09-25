"""Load optional consumer settings after the WearMux transport settings."""

import os
from pathlib import Path


def _ini_files(config_path: Path) -> list[Path]:
    if config_path.is_file():
        return [config_path]
    if not config_path.is_dir():
        return []
    return sorted(config_path.glob("*.ini"), key=lambda path: (path.name != "config.ini", path.name))


def load_config(example: str) -> None:
    root = Path(__file__).resolve().parents[2]
    configured = os.environ.get("WEARMUX_CONFIG_PATH")
    config_path = Path(configured).expanduser().resolve() if configured else Path("/config")
    if not configured and not config_path.is_dir():
        config_path = root / "config"

    example_config = Path(__file__).resolve().parent / example / "config.ini"
    for path in [*_ini_files(config_path), example_config]:
        if not path.is_file():
            continue
        section = ""
        for raw in path.read_text(encoding="utf-8").splitlines():
            line = raw.strip()
            if not line or line.startswith(("#", ";")):
                continue
            if line.startswith("[") and line.endswith("]"):
                section = line[1:-1].strip().lower()
                continue
            if section != "env" or "=" not in line:
                continue
            key, value = (part.strip() for part in line.split("=", 1))
            if key and key not in os.environ:
                for marker in (" #", " ;"):
                    value = value.split(marker, 1)[0].rstrip()
                os.environ[key] = value
