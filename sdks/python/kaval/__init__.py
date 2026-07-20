"""Kaval Python SDK — verify the facts an AI agent's action relies on, with signed proofs."""

from importlib.metadata import PackageNotFoundError, version

from .client import (
    KavalCancellationToken,
    KavalCancelledError,
    KavalClient,
    KavalError,
    KavalProofNotFoundError,
)
from .models import (
    ActionContext,
    ActionDecision,
    AuditInput,
    DecisionThreshold,
    EvidenceDocumentRef,
    EvidenceRef,
    ProofGateInput,
    ProofGateResult,
    ProofPacket,
    RecordRef,
    VerifyInput,
    VerifyReceipt,
    VerifyResult,
    VerifyStatus,
)

__all__ = [
    "ActionContext",
    "ActionDecision",
    "AuditInput",
    "DecisionThreshold",
    "EvidenceDocumentRef",
    "EvidenceRef",
    "KavalCancellationToken",
    "KavalCancelledError",
    "KavalClient",
    "KavalError",
    "KavalProofNotFoundError",
    "ProofGateInput",
    "ProofGateResult",
    "ProofPacket",
    "RecordRef",
    "VerifyInput",
    "VerifyReceipt",
    "VerifyResult",
    "VerifyStatus",
]

try:
    # Single source of truth: read the installed distribution's version (set in pyproject.toml)
    # so __version__ can never drift from the package metadata / wheel filename.
    __version__ = version("kaval")
except PackageNotFoundError:  # running from source without an install
    __version__ = "0.0.0+unknown"
