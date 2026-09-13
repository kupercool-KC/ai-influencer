"""Platform discovery protocol + registry."""
from __future__ import annotations

from typing import Callable, Protocol

from content_scout.config import Settings
from content_scout.models import RawVideo


class PlatformModule(Protocol):
    def discover(
        self, niche: str, settings: Settings, since_days: int, limit: int
    ) -> list[RawVideo]:
        """Return up to `limit` candidate videos for `niche`, posted within `since_days`."""
        ...


# Populated at the bottom of each platforms/<name>.py via register().
PLATFORM_REGISTRY: dict[str, Callable[[str, Settings, int, int], list[RawVideo]]] = {}


def register(name: str, discover_fn: Callable[[str, Settings, int, int], list[RawVideo]]) -> None:
    PLATFORM_REGISTRY[name] = discover_fn


def get_platform(name: str) -> Callable[[str, Settings, int, int], list[RawVideo]]:
    # Import lazily so `content_scout.platforms.youtube` etc. only get imported (and their
    # deps only get required) when that platform is actually requested.
    if name not in PLATFORM_REGISTRY:
        _import_platform(name)
    try:
        return PLATFORM_REGISTRY[name]
    except KeyError as exc:
        raise ValueError(
            f"Unknown platform '{name}'. Available: {', '.join(KNOWN_PLATFORMS)}"
        ) from exc


KNOWN_PLATFORMS = ["youtube", "tiktok", "instagram"]


def _import_platform(name: str) -> None:
    if name == "youtube":
        import content_scout.platforms.youtube  # noqa: F401
    elif name == "tiktok":
        import content_scout.platforms.tiktok  # noqa: F401
    elif name == "instagram":
        import content_scout.platforms.instagram  # noqa: F401
    else:
        raise ValueError(f"Unknown platform '{name}'. Available: {', '.join(KNOWN_PLATFORMS)}")
