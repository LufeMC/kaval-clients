#!/usr/bin/env python3
"""Fail closed when a Kaval Python distribution contains the wrong files or API."""

from __future__ import annotations

from pathlib import Path, PurePosixPath
import re
import subprocess
import sys
import tarfile
import tempfile
import textwrap
import zipfile


PACKAGE = "kaval"
REQUIRED_PACKAGE_FILES = {
    "kaval/__init__.py",
    "kaval/client.py",
    "kaval/models.py",
    "kaval/pydantic_ai.py",
    "kaval/py.typed",
}
FORBIDDEN_PARTS = {
    ".env",
    ".git",
    ".pytest_cache",
    ".venv",
    ".venv-tmp",
    "__pycache__",
}


def fail(message: str) -> None:
    raise SystemExit(f"distribution check failed: {message}")


def project_version(project_root: Path) -> str:
    source = (project_root / "pyproject.toml").read_text(encoding="utf-8")
    match = re.search(
        r'(?m)^version\s*=\s*"(?P<version>\d+\.\d+\.\d+)"\s*$',
        source,
    )
    if match is None:
        fail("pyproject.toml has no exact semantic project version")
    return match.group("version")


def normalized_members(names: list[str], *, archive: str) -> set[str]:
    members: set[str] = set()
    for name in names:
        path = PurePosixPath(name)
        if path.is_absolute() or ".." in path.parts:
            fail(f"{archive} contains an unsafe path: {name!r}")
        if (
            path.name == "uv.lock"
            or path.suffix == ".pyc"
            or any(part in FORBIDDEN_PARTS for part in path.parts)
        ):
            fail(f"{archive} contains forbidden development material: {name!r}")
        members.add(path.as_posix())
    return members


def require_members(
    members: set[str],
    required: set[str],
    *,
    archive: str,
) -> None:
    missing = sorted(required - members)
    if missing:
        fail(f"{archive} is missing required members: {', '.join(missing)}")


def check_wheel(path: Path, version: str) -> None:
    expected_name = f"kaval-{version}-py3-none-any.whl"
    if path.name != expected_name:
        fail(f"expected wheel {expected_name!r}, got {path.name!r}")

    metadata_name = f"kaval-{version}.dist-info/METADATA"
    with zipfile.ZipFile(path) as wheel:
        members = normalized_members(wheel.namelist(), archive=path.name)
        require_members(
            members,
            REQUIRED_PACKAGE_FILES | {metadata_name},
            archive=path.name,
        )
        metadata = wheel.read(metadata_name).decode("utf-8")
        if f"Name: {PACKAGE}\n" not in metadata:
            fail(f"{path.name} metadata does not identify the kaval package")
        if f"Version: {version}\n" not in metadata:
            fail(f"{path.name} metadata does not match version {version}")

        with tempfile.TemporaryDirectory(prefix="kaval-wheel-check-") as temp:
            wheel.extractall(temp)
            smoke = textwrap.dedent(
                """
                import inspect
                from pathlib import Path
                import sys

                artifact_root = Path(sys.argv[1]).resolve()
                sys.path.insert(0, str(artifact_root))

                import kaval
                from kaval import (
                    KavalCancellationToken,
                    KavalClient,
                    ProductResearchInput,
                    ProductResearchResult,
                    ProductResearchStreamEvent,
                )

                module_path = Path(kaval.__file__).resolve()
                if artifact_root not in module_path.parents:
                    raise SystemExit(f"import resolved outside packed wheel: {module_path}")

                expected_exports = {
                    "KavalCancellationToken",
                    "KavalClient",
                    "ProductResearchInput",
                    "ProductResearchResult",
                    "ProductResearchStreamEvent",
                }
                missing_exports = expected_exports - set(kaval.__all__)
                if missing_exports:
                    raise SystemExit(
                        "packed wheel omits exports: " + ", ".join(sorted(missing_exports))
                    )

                for method_name in (
                    "research_products",
                    "stream_product_research",
                ):
                    method = getattr(KavalClient, method_name, None)
                    if not callable(method):
                        raise SystemExit(f"packed wheel omits KavalClient.{method_name}")
                    parameters = inspect.signature(method).parameters
                    if "cancellation_token" not in parameters:
                        raise SystemExit(
                            f"packed wheel omits cancellation_token on {method_name}"
                        )

                # These references make the import assertions explicit to static analyzers too.
                assert KavalCancellationToken
                assert ProductResearchInput
                assert ProductResearchResult
                assert ProductResearchStreamEvent
                """
            )
            completed = subprocess.run(
                [sys.executable, "-I", "-c", smoke, temp],
                check=False,
                capture_output=True,
                text=True,
            )
            if completed.returncode != 0:
                details = (completed.stderr or completed.stdout).strip()
                fail(f"{path.name} import smoke failed: {details}")


def check_sdist(path: Path, version: str) -> None:
    expected_name = f"kaval-{version}.tar.gz"
    if path.name != expected_name:
        fail(f"expected sdist {expected_name!r}, got {path.name!r}")

    prefix = f"kaval-{version}/"
    with tarfile.open(path, mode="r:gz") as sdist:
        members = normalized_members(
            [member.name for member in sdist.getmembers()],
            archive=path.name,
        )
    require_members(
        members,
        {f"{prefix}{name}" for name in REQUIRED_PACKAGE_FILES}
        | {f"{prefix}pyproject.toml"},
        archive=path.name,
    )


def exactly_one(dist: Path, pattern: str, *, kind: str) -> Path:
    matches = sorted(dist.glob(pattern))
    if len(matches) != 1:
        rendered = ", ".join(path.name for path in matches) or "none"
        fail(f"expected exactly one {kind}, found {rendered}")
    return matches[0]


def main() -> None:
    project_root = Path(__file__).resolve().parents[1]
    dist = (
        Path(sys.argv[1]).resolve()
        if len(sys.argv) == 2
        else (project_root / "dist").resolve()
    )
    if len(sys.argv) > 2:
        fail("usage: check_dist.py [dist-directory]")
    if not dist.is_dir():
        fail(f"distribution directory does not exist: {dist}")

    version = project_version(project_root)
    wheel = exactly_one(dist, f"kaval-{version}-*.whl", kind="wheel")
    sdist = exactly_one(dist, f"kaval-{version}.tar.gz", kind="sdist")
    check_wheel(wheel, version)
    check_sdist(sdist, version)
    print(
        "Python distributions OK: "
        f"{wheel.name} ({wheel.stat().st_size} bytes), "
        f"{sdist.name} ({sdist.stat().st_size} bytes)"
    )


if __name__ == "__main__":
    main()
