"""Per-platform discovery modules. Each exposes a `discover(niche, settings, since_days, limit)
-> list[RawVideo]` function and registers itself in PLATFORM_REGISTRY (see base.py).
Adding a new platform later = one new module + one registry line, no pipeline changes.
"""
