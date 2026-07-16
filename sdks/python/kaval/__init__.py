"""Kaval Python SDK — evidence gates and review-only offer research for AI agents."""

from importlib.metadata import PackageNotFoundError, version

from .client import KavalClient, KavalError
from .models import (
    ActionContext,
    ActionDecision,
    AuditInput,
    CommerceActionBinding,
    CommerceActionTimeGateInput,
    CommerceActionTimeGateResult,
    CommerceAcquisitionSourceLedgerEntry,
    CommerceCheckoutVerification,
    CommerceOfferSearchLifecycle,
    DecisionThreshold,
    LiveOfferSearchAcquisitionTrace,
    LiveOfferSearchResult,
    OfferSearchFinalEvent,
    OfferSearchInput,
    OfferSearchProgressEvent,
    OfferSearchProvisionalCandidateDetails,
    OfferSearchProvisionalCandidateEvent,
    OfferSearchReplayEvent,
    OfferSearchStageEvent,
    OfferSearchStreamEvent,
    ProofGateInput,
    ProofGateResult,
    ProofPacket,
    RecordRef,
)

__all__ = [
    "ActionContext",
    "ActionDecision",
    "AuditInput",
    "CommerceActionBinding",
    "CommerceActionTimeGateInput",
    "CommerceActionTimeGateResult",
    "CommerceAcquisitionSourceLedgerEntry",
    "CommerceCheckoutVerification",
    "CommerceOfferSearchLifecycle",
    "DecisionThreshold",
    "KavalClient",
    "KavalError",
    "LiveOfferSearchAcquisitionTrace",
    "LiveOfferSearchResult",
    "OfferSearchFinalEvent",
    "OfferSearchInput",
    "OfferSearchProgressEvent",
    "OfferSearchProvisionalCandidateDetails",
    "OfferSearchProvisionalCandidateEvent",
    "OfferSearchReplayEvent",
    "OfferSearchStageEvent",
    "OfferSearchStreamEvent",
    "ProofGateInput",
    "ProofGateResult",
    "ProofPacket",
    "RecordRef",
]

try:
    # Single source of truth: read the installed distribution's version (set in pyproject.toml)
    # so __version__ can never drift from the package metadata / wheel filename.
    __version__ = version("kaval")
except PackageNotFoundError:  # running from source without an install
    __version__ = "0.0.0+unknown"
