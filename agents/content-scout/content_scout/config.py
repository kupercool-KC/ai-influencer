"""Settings loaded from environment / .env file. No secrets hardcoded here."""
from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path

from dotenv import load_dotenv


@dataclass(frozen=True)
class Settings:
    apify_token: str | None
    youtube_api_key: str | None
    data_dir: Path

    def require_apify(self) -> str:
        if not self.apify_token:
            raise MissingCredentialError(
                "APIFY_TOKEN is not set. Create a free Apify account at "
                "https://console.apify.com, generate an API token at "
                "https://console.apify.com/settings/integrations, and put it in your .env file."
            )
        return self.apify_token

    def require_youtube(self) -> str:
        if not self.youtube_api_key:
            raise MissingCredentialError(
                "YOUTUBE_API_KEY is not set. Create one (free) at "
                "https://console.cloud.google.com/apis/credentials after enabling "
                "'YouTube Data API v3' for a Google Cloud project, and put it in your .env file."
            )
        return self.youtube_api_key


class MissingCredentialError(RuntimeError):
    """Raised when a pipeline stage needs a credential that isn't configured yet."""


def load_settings(env_file: str | Path | None = None) -> Settings:
    """Load settings from a .env file (if present) plus process environment.

    Process environment always wins over .env file values.
    """
    if env_file is not None:
        load_dotenv(env_file, override=False)
    else:
        # Look for .env in cwd and in the project root (parent of this package).
        for candidate in (Path.cwd() / ".env", Path(__file__).resolve().parent.parent / ".env"):
            if candidate.exists():
                load_dotenv(candidate, override=False)
                break

    data_dir = Path(os.environ.get("CONTENT_SCOUT_DATA_DIR", "./data")).resolve()
    return Settings(
        apify_token=os.environ.get("APIFY_TOKEN") or None,
        youtube_api_key=os.environ.get("YOUTUBE_API_KEY") or None,
        data_dir=data_dir,
    )
