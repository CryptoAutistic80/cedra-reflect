#!/usr/bin/env python3
"""Fail-closed, standard-library validation for Cedra release evidence.

This module never contacts a network, reads a Cedra profile, signs a transaction,
or submits a transaction.  It validates immutable JSON/file bindings and parses
already-captured simulation/finalized REST responses.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
from pathlib import Path
from typing import Any, NoReturn


SHA256_RE = re.compile(r"^[0-9a-f]{64}$")
COMMIT_RE = re.compile(r"^[0-9a-f]{40}$")
DECIMAL_RE = re.compile(r"^(0|[1-9][0-9]*)$")
TX_HASH_RE = re.compile(r"^0x[0-9a-f]{64}$")
DEPLOYMENT_RE = re.compile(r"^[A-Za-z0-9._-]{1,80}$")
TIMESTAMP_RE = re.compile(r"^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$")
FUNCTION_RE = re.compile(r"^(0x[0-9a-fA-F]{1,64})::([A-Za-z_][A-Za-z0-9_]*)::([A-Za-z_][A-Za-z0-9_]*)$")
LOCAL_FILE_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$")

ROLE_KEYS = (
    "core_publisher",
    "assets_publisher",
    "amm_publisher",
    "operations",
    "bootstrap_lp",
)
PACKAGE_KEYS = ("reflection_core", "test_assets", "test_amm")
CHAIN_ID = "2"
NETWORK = "cedra-testnet"
API_URL = "https://testnet.cedra.dev/v1"
APPROVAL_NAMESPACE = "cedra-reflect-testnet-release-v1"
CEDRA_COIN = "0x1::cedra_coin::CedraCoin"
PUBLIC_KEY_RE = re.compile(r"^ed25519-pub-0x([0-9a-f]{64})$")
ZERO_SIMULATION_SIGNATURE = "0x" + "00" * 64
PROFILE_DERIVATION_METHOD = "sha3-256(ed25519_public_key_bytes || 0x00)"
PROFILE_DERIVATION_TOOL = "OpenSSL dgst -sha3-256"
ASSEMBLER_REVALIDATION_SDK_PACKAGE = "@cedra-labs/ts-sdk"
ASSEMBLER_REVALIDATION_SDK_VERSION = "2.2.8"
PROFILE_NAMES = {
    "core_publisher": "cedra-reflect-core-publisher",
    "assets_publisher": "cedra-reflect-assets-publisher",
    "amm_publisher": "cedra-reflect-amm-publisher",
    "operations": "cedra-reflect-operations",
    "bootstrap_lp": "cedra-reflect-bootstrap-lp",
}


class EvidenceError(ValueError):
    pass


def fail(message: str) -> NoReturn:
    raise EvidenceError(message)


def load_json(path: Path) -> Any:
    try:
        with path.open("r", encoding="utf-8") as handle:
            return json.load(handle)
    except (OSError, UnicodeError, json.JSONDecodeError) as exc:
        fail(f"cannot read valid JSON from {path}: {exc}")


def canonical_json_bytes(value: Any) -> bytes:
    return (json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")) + "\n").encode("utf-8")


def sha256_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    try:
        with path.open("rb") as handle:
            for chunk in iter(lambda: handle.read(1024 * 1024), b""):
                digest.update(chunk)
    except OSError as exc:
        fail(f"cannot hash {path}: {exc}")
    return digest.hexdigest()


def require(condition: bool, message: str) -> None:
    if not condition:
        fail(message)


def require_exact_keys(value: Any, keys: tuple[str, ...] | list[str], label: str) -> dict[str, Any]:
    require(isinstance(value, dict), f"{label} must be an object")
    actual = set(value)
    wanted = set(keys)
    require(actual == wanted, f"{label} keys mismatch; missing={sorted(wanted - actual)}, unexpected={sorted(actual - wanted)}")
    return value


def require_string(value: Any, label: str, pattern: re.Pattern[str] | None = None) -> str:
    require(isinstance(value, str) and bool(value), f"{label} must be a non-empty string")
    if pattern is not None:
        require(pattern.fullmatch(value) is not None, f"{label} has an invalid format")
    return value


def require_decimal(value: Any, label: str, *, positive: bool = False) -> str:
    text = require_string(value, label, DECIMAL_RE)
    if positive:
        require(int(text) > 0, f"{label} must be positive")
    return text


def canonical_address(value: Any, label: str) -> str:
    text = require_string(value, label)
    require(re.fullmatch(r"0x[0-9a-fA-F]{1,64}", text) is not None, f"{label} is not a Cedra address")
    digits = text[2:].lower().lstrip("0") or "0"
    require(digits != "0", f"{label} must be non-zero")
    return "0x" + digits


def canonical_function(value: Any, label: str) -> str:
    text = require_string(value, label)
    match = FUNCTION_RE.fullmatch(text)
    require(match is not None, f"{label} is not a fully-qualified entry function")
    return f"{canonical_address(match.group(1), label + '.address')}::{match.group(2)}::{match.group(3)}"


def canonical_function_like_resource(value: Any) -> str:
    """Canonicalize a non-generic Move struct tag with the entry-function grammar."""
    return canonical_function(value, "resource type")


def local_file(directory: Path, value: Any, label: str) -> Path:
    name = require_string(value, label, LOCAL_FILE_RE)
    path = directory / name
    require(path.is_file() and not path.is_symlink(), f"{label} must name a regular, non-symlink file beside its record")
    return path


def role_map(value: Any, label: str = "roles") -> dict[str, str]:
    obj = require_exact_keys(value, list(ROLE_KEYS), label)
    normalized = {key: canonical_address(obj[key], f"{label}.{key}") for key in ROLE_KEYS}
    require(len(set(normalized.values())) == len(ROLE_KEYS), f"{label} addresses must all be distinct")
    return normalized


def validate_public_profile_binding(value: Any, roles: dict[str, str]) -> dict[str, Any]:
    binding = require_exact_keys(
        value,
        [
            "evidence_sha256",
            "public_role_candidate_sha256",
            "derivation_method",
            "derivation_tool",
            "assembler_revalidation_sdk_package",
            "assembler_revalidation_sdk_version",
            "profiles",
        ],
        "public_profile_binding",
    )
    require_string(binding["evidence_sha256"], "public_profile_binding.evidence_sha256", SHA256_RE)
    require_string(binding["public_role_candidate_sha256"], "public_profile_binding.public_role_candidate_sha256", SHA256_RE)
    require(
        binding["derivation_method"] == PROFILE_DERIVATION_METHOD
        and binding["derivation_tool"] == PROFILE_DERIVATION_TOOL,
        "public profile binding must identify the OpenSSL SHA3-256 evidence derivation",
    )
    require(
        binding["assembler_revalidation_sdk_package"] == ASSEMBLER_REVALIDATION_SDK_PACKAGE
        and binding["assembler_revalidation_sdk_version"] == ASSEMBLER_REVALIDATION_SDK_VERSION,
        "public profile binding must identify the reviewed assembler SDK revalidation",
    )
    profiles = require_exact_keys(binding["profiles"], list(ROLE_KEYS), "public_profile_binding.profiles")
    public_keys: list[str] = []
    for role in ROLE_KEYS:
        profile = require_exact_keys(
            profiles[role],
            ["profile_name", "address", "public_key"],
            f"public_profile_binding.profiles.{role}",
        )
        require(profile["profile_name"] == PROFILE_NAMES[role], f"public profile name mismatch for {role}")
        address = canonical_address(profile["address"], f"public_profile_binding.profiles.{role}.address")
        require(address == roles[role], f"public profile address differs from release role for {role}")
        public_key = require_string(profile["public_key"], f"public_profile_binding.profiles.{role}.public_key")
        match = PUBLIC_KEY_RE.fullmatch(public_key)
        require(match is not None, f"public profile key has an invalid Ed25519 format for {role}")
        derived = hashlib.sha3_256(bytes.fromhex(match.group(1)) + b"\x00").hexdigest().lstrip("0") or "0"
        require("0x" + derived == address, f"public profile key does not derive the release address for {role}")
        public_keys.append(public_key)
    require(len(set(public_keys)) == len(ROLE_KEYS), "public profile binding keys must all be distinct")
    return binding


def validate_build_environment(value: Any, application_commit: str, exact: dict[str, Any]) -> dict[str, Any]:
    environment = require_exact_keys(
        value,
        [
            "repository_head_commit",
            "repository_head_tree",
            "release_executable_closure_file",
            "release_executable_closure_sha256",
            "package_lock_file",
            "package_lock_sha256",
            "sdk_package",
            "sdk_version",
            "sdk_lock_integrity",
            "sdk_review_pin_file",
            "sdk_review_pin_sha256",
            "sdk_package_json_sha256",
            "sdk_loaded_entrypoint",
            "sdk_loaded_entrypoint_sha256",
            "sdk_package_tree_sha256",
            "sdk_package_file_count",
            "sdk_review_attestation_sha256",
            "sdk_review_signature_sha256",
            "sdk_review_signature_namespace",
            "sdk_review_reviewer_identity",
            "sdk_review_trusted_signers_sha256",
        ],
        "build_environment",
    )
    require(environment["repository_head_commit"] == application_commit == exact.get("application_commit"), "build environment HEAD differs from candidate/exact commit")
    require_string(environment["repository_head_tree"], "build_environment.repository_head_tree", COMMIT_RE)
    require(environment["repository_head_tree"] == exact.get("application_tree"), "build environment tree differs from exact-address tree")
    require(environment["release_executable_closure_file"] == "ops/evidence/release-executable-closure.json", "build environment must bind the reviewed release executable-closure manifest")
    require(environment["package_lock_file"] == "package-lock.json", "build environment must bind package-lock.json")
    for field in (
        "release_executable_closure_sha256",
        "package_lock_sha256",
        "sdk_package_json_sha256",
        "sdk_loaded_entrypoint_sha256",
        "sdk_package_tree_sha256",
        "sdk_review_attestation_sha256",
        "sdk_review_signature_sha256",
        "sdk_review_trusted_signers_sha256",
    ):
        require_string(environment[field], f"build_environment.{field}", SHA256_RE)
    require(environment["sdk_package"] == "@cedra-labs/ts-sdk" and environment["sdk_version"] == "2.2.8", "build environment must bind the reviewed Cedra SDK 2.2.8")
    require_string(environment["sdk_lock_integrity"], "build_environment.sdk_lock_integrity", re.compile(r"^sha512-[A-Za-z0-9+/]+={0,2}$"))
    require(environment["sdk_review_pin_file"] == "ops/evidence/reviewed-cedra-sdk-2.2.8.json", "build environment must bind the reviewed SDK artifact pin")
    require_string(environment["sdk_review_pin_sha256"], "build_environment.sdk_review_pin_sha256", SHA256_RE)
    require(environment["sdk_review_signature_namespace"] == "cedra-reflect-sdk-review-v1", "build environment has the wrong SDK-review signature namespace")
    require_string(environment["sdk_review_reviewer_identity"], "build_environment.sdk_review_reviewer_identity", re.compile(r"^[A-Za-z0-9][A-Za-z0-9._@+-]{2,127}$"))
    entrypoint = require_string(environment["sdk_loaded_entrypoint"], "build_environment.sdk_loaded_entrypoint", re.compile(r"^[A-Za-z0-9@._+/-]+$"))
    require(not entrypoint.startswith("/") and "../" not in entrypoint and entrypoint != "..", "build environment SDK entrypoint must be a safe relative path")
    count = environment["sdk_package_file_count"]
    require(isinstance(count, int) and not isinstance(count, bool) and count > 0, "build environment SDK file count must be a positive integer")
    return environment


def validate_external_profile_binding(
    candidate: dict[str, Any],
    exact: dict[str, Any],
    profile_path: Path,
    roles: dict[str, str],
) -> dict[str, Any]:
    require(profile_path.is_file() and not profile_path.is_symlink(), "public-profile evidence must be a regular non-symlink file")
    embedded = candidate["public_profile_binding"]
    require(sha256_file(profile_path) == embedded["evidence_sha256"], "candidate public-profile evidence digest differs from the supplied file")
    profile = load_json(profile_path)
    require(isinstance(profile, dict), "public-profile evidence must be an object")
    require(profile.get("schema_version") == 1 and profile.get("evidence_scope") == "local-public-profile-preflight" and profile.get("network_intent") == NETWORK, "supplied public-profile evidence has the wrong scope or network")
    exact_role_binding = exact.get("public_role_candidate_binding")
    require(isinstance(exact_role_binding, dict), "exact-address evidence has no public-role candidate binding")
    role_digest = require_string(exact_role_binding.get("sha256"), "exact public-role candidate digest", SHA256_RE)
    require(profile.get("public_role_candidate_sha256") == role_digest == embedded["public_role_candidate_sha256"], "candidate, profile, and exact evidence bind different public-role candidates")
    authentication = require_exact_keys(
        profile.get("authentication_key_validation"),
        ["all_profile_authentication_keys_match", "derivation_method", "derivation_tool"],
        "profile authentication_key_validation",
    )
    require(
        authentication
        == {
            "all_profile_authentication_keys_match": True,
            "derivation_method": PROFILE_DERIVATION_METHOD,
            "derivation_tool": PROFILE_DERIVATION_TOOL,
        },
        "public-profile evidence was not validated with the declared OpenSSL SHA3-256 derivation",
    )
    require(
        authentication["derivation_method"] == embedded["derivation_method"]
        and authentication["derivation_tool"] == embedded["derivation_tool"],
        "candidate public-profile derivation metadata differs from the supplied evidence",
    )
    observed_profiles = require_exact_keys(profile.get("profiles"), list(ROLE_KEYS), "external public profiles")
    for role in ROLE_KEYS:
        observed = require_exact_keys(
            observed_profiles[role],
            ["profile_name", "network", "has_private_key", "public_key", "account", "rest_url", "faucet_url"],
            f"external public profiles.{role}",
        )
        expected = embedded["profiles"][role]
        observed_address = canonical_address("0x" + require_string(observed["account"], f"external public profiles.{role}.account", re.compile(r"^[0-9a-f]{64}$")), f"external public profiles.{role}.account")
        require(
            observed["profile_name"] == expected["profile_name"]
            and observed["public_key"] == expected["public_key"]
            and observed_address == expected["address"] == roles[role]
            and observed["network"] == "Testnet"
            and observed["has_private_key"] is True
            and observed["rest_url"] == "https://testnet.cedra.dev"
            and observed["faucet_url"] == "https://faucet-api.cedra.dev",
            f"candidate embedded profile differs from supplied evidence for {role}",
        )
    return profile


def transaction_semantics(transaction: Any) -> dict[str, Any]:
    tx = require_exact_keys(
        transaction,
        [
            "sender",
            "secondary_signers",
            "sequence_number",
            "expiration_timestamp_secs",
            "max_gas_amount",
            "gas_unit_price",
            "payload",
        ],
        "transaction",
    )
    sender = canonical_address(tx["sender"], "transaction.sender")
    secondary = tx["secondary_signers"]
    require(isinstance(secondary, list), "transaction.secondary_signers must be an ordered array")
    secondary_normalized = [canonical_address(value, f"transaction.secondary_signers[{index}]") for index, value in enumerate(secondary)]
    require(len(set(secondary_normalized)) == len(secondary_normalized), "transaction.secondary_signers must be distinct")
    require(sender not in secondary_normalized, "transaction sender cannot also be a secondary signer")
    payload = require_exact_keys(tx["payload"], ["type", "function", "type_arguments", "arguments"], "transaction.payload")
    require(payload["type"] == "entry_function_payload", "transaction.payload.type must be entry_function_payload")
    function = canonical_function(payload["function"], "transaction.payload.function")
    require(isinstance(payload["type_arguments"], list) and all(isinstance(item, str) for item in payload["type_arguments"]), "transaction.payload.type_arguments must be a string array")
    require(isinstance(payload["arguments"], list), "transaction.payload.arguments must be an array")
    sequence = require_decimal(tx["sequence_number"], "transaction.sequence_number")
    expiration = require_decimal(tx["expiration_timestamp_secs"], "transaction.expiration_timestamp_secs", positive=True)
    max_gas = require_decimal(tx["max_gas_amount"], "transaction.max_gas_amount", positive=True)
    gas_price = require_decimal(tx["gas_unit_price"], "transaction.gas_unit_price", positive=True)
    return {
        "sender": sender,
        "secondary_signers": secondary_normalized,
        "sequence_number": sequence,
        "expiration_timestamp_secs": expiration,
        "max_gas_amount": max_gas,
        "gas_unit_price": gas_price,
        "payload": {
            "type": "entry_function_payload",
            "function": function,
            "type_arguments": payload["type_arguments"],
            "arguments": payload["arguments"],
        },
    }


def transaction_semantics_digest(transaction: Any) -> str:
    return sha256_bytes(canonical_json_bytes(transaction_semantics(transaction)))


def require_hex_bytes(value: Any, label: str) -> bytes:
    text = require_string(value, label)
    require(re.fullmatch(r"0x(?:[0-9a-f]{2})+", text) is not None, f"{label} must be non-empty lowercase even-length 0x hex")
    return bytes.fromhex(text[2:])


def validate_transaction_identity(identity: Any, tx: dict[str, Any]) -> dict[str, Any]:
    value = require_exact_keys(
        identity,
        [
            "transactionType",
            "senderAddress",
            "secondarySignerAddresses",
            "feePayerAddress",
            "sequenceNumber",
            "maxGasAmount",
            "gasUnitPrice",
            "expirationTimestampSeconds",
            "chainId",
            "fungibleAssetGasType",
            "rawTransactionBcsHex",
            "rawTransactionSha256",
            "transactionBcsHex",
            "transactionSha256",
            "signingMessageHex",
            "signingMessageSha256",
        ],
        "transaction_identity",
    )
    expected_type = "multi-agent" if tx["secondary_signers"] else "single-signer"
    require(value["transactionType"] == expected_type, "transaction_identity.transactionType disagrees with signer list")
    require(canonical_address(value["senderAddress"], "transaction_identity.senderAddress") == tx["sender"], "transaction identity sender mismatch")
    require(isinstance(value["secondarySignerAddresses"], list), "transaction identity secondary signers must be an array")
    identity_secondary = [canonical_address(item, f"transaction_identity.secondarySignerAddresses[{index}]") for index, item in enumerate(value["secondarySignerAddresses"])]
    require(identity_secondary == tx["secondary_signers"], "transaction identity ordered secondary signer mismatch")
    require(value["feePayerAddress"] is None, "release transactions cannot use a fee payer")
    require(require_decimal(value["sequenceNumber"], "transaction_identity.sequenceNumber") == tx["sequence_number"], "transaction identity sequence mismatch")
    require(require_decimal(value["maxGasAmount"], "transaction_identity.maxGasAmount", positive=True) == tx["max_gas_amount"], "transaction identity max gas mismatch")
    require(require_decimal(value["gasUnitPrice"], "transaction_identity.gasUnitPrice", positive=True) == tx["gas_unit_price"], "transaction identity gas unit price mismatch")
    require(require_decimal(value["expirationTimestampSeconds"], "transaction_identity.expirationTimestampSeconds", positive=True) == tx["expiration_timestamp_secs"], "transaction identity expiration mismatch")
    require(value["chainId"] == 2 and not isinstance(value["chainId"], bool), "transaction identity chainId must be numeric 2")
    require(value["fungibleAssetGasType"] == CEDRA_COIN, "transaction identity gas asset must be the default CED type")
    for hex_key, digest_key in (
        ("rawTransactionBcsHex", "rawTransactionSha256"),
        ("transactionBcsHex", "transactionSha256"),
        ("signingMessageHex", "signingMessageSha256"),
    ):
        decoded = require_hex_bytes(value[hex_key], f"transaction_identity.{hex_key}")
        digest = require_string(value[digest_key], f"transaction_identity.{digest_key}", SHA256_RE)
        require(sha256_bytes(decoded) == digest, f"transaction identity {digest_key} does not hash {hex_key}")
    return value


def normalize_rest_signature(value: Any, label: str) -> tuple[str, list[Any]]:
    signature = require_exact_keys(
        value,
        ["type", "public_key", "signature"]
        if isinstance(value, dict) and value.get("type") == "ed25519_signature"
        else ["type", "sender", "secondary_signer_addresses", "secondary_signers"],
        f"{label}.signature",
    )
    signature_type = require_string(signature["type"], f"{label}.signature.type")
    if signature_type == "ed25519_signature":
        require_string(signature["public_key"], f"{label}.signature.public_key")
        require_string(signature["signature"], f"{label}.signature.signature")
        return signature_type, []
    require(signature_type == "multi_agent_signature", f"{label}.signature.type must be ed25519_signature or multi_agent_signature; fee-payer and other signature types are forbidden")
    sender_signature = require_exact_keys(signature["sender"], ["type", "public_key", "signature"], f"{label}.signature.sender")
    require(sender_signature["type"] == "ed25519_signature", f"{label}.signature.sender must be an Ed25519 signature")
    require_string(sender_signature["public_key"], f"{label}.signature.sender.public_key")
    require_string(sender_signature["signature"], f"{label}.signature.sender.signature")
    secondary_addresses = signature["secondary_signer_addresses"]
    secondary_signatures = signature["secondary_signers"]
    require(isinstance(secondary_addresses, list) and len(secondary_addresses) > 0, f"{label}.signature.secondary_signer_addresses must be a non-empty ordered array")
    require(isinstance(secondary_signatures, list) and len(secondary_signatures) == len(secondary_addresses), f"{label}.signature.secondary_signers must match the address count")
    for index, secondary_signature in enumerate(secondary_signatures):
        item = require_exact_keys(secondary_signature, ["type", "public_key", "signature"], f"{label}.signature.secondary_signers[{index}]")
        require(item["type"] == "ed25519_signature", f"{label}.signature.secondary_signers[{index}] must be Ed25519")
        require_string(item["public_key"], f"{label}.signature.secondary_signers[{index}].public_key")
        require_string(item["signature"], f"{label}.signature.secondary_signers[{index}].signature")
    return signature_type, secondary_addresses


def normalize_rest_transaction(value: Any, label: str) -> dict[str, Any]:
    if isinstance(value, list):
        require(len(value) == 1 and isinstance(value[0], dict), f"{label} must contain exactly one transaction")
        value = value[0]
    require(isinstance(value, dict), f"{label} must be a transaction object")
    payload = value.get("payload")
    _, secondary = normalize_rest_signature(value.get("signature"), label)
    return transaction_semantics(
        {
            "sender": value.get("sender"),
            "secondary_signers": secondary,
            "sequence_number": str(value.get("sequence_number")) if value.get("sequence_number") is not None else None,
            "expiration_timestamp_secs": str(value.get("expiration_timestamp_secs")) if value.get("expiration_timestamp_secs") is not None else None,
            "max_gas_amount": str(value.get("max_gas_amount")) if value.get("max_gas_amount") is not None else None,
            "gas_unit_price": str(value.get("gas_unit_price")) if value.get("gas_unit_price") is not None else None,
            "payload": payload,
        }
    )


def require_zero_simulation_authenticator(value: Any, expected_public_key: str, label: str) -> None:
    authenticator = require_exact_keys(value, ["type", "public_key", "signature"], label)
    require(authenticator["type"] == "ed25519_signature", f"{label} must be Ed25519")
    require(authenticator["public_key"] == expected_public_key, f"{label} public key differs from the requested public profile key")
    require(authenticator["signature"] == ZERO_SIMULATION_SIGNATURE, f"{label} must use the SDK all-zero 64-byte simulation signature")


def validate_simulation_authenticator(response: dict[str, Any], candidate: dict[str, Any], tx: dict[str, Any]) -> None:
    profiles = candidate["public_profile_binding"]["profiles"]
    public_keys_by_address = {
        canonical_address(profiles[role]["address"], f"public_profile_binding.profiles.{role}.address"):
        profiles[role]["public_key"].removeprefix("ed25519-pub-")
        for role in ROLE_KEYS
    }
    sender_key = public_keys_by_address.get(tx["sender"])
    require(sender_key is not None, "simulation sender has no bound public profile key")
    signature = response.get("signature")
    if not tx["secondary_signers"]:
        require_zero_simulation_authenticator(signature, sender_key, "simulation sender authenticator")
        return

    multi = require_exact_keys(
        signature,
        ["type", "sender", "secondary_signer_addresses", "secondary_signers"],
        "simulation multi-agent authenticator",
    )
    require(multi["type"] == "multi_agent_signature", "simulation must use a multi-agent authenticator")
    require_zero_simulation_authenticator(multi["sender"], sender_key, "simulation sender authenticator")
    addresses = multi["secondary_signer_addresses"]
    signers = multi["secondary_signers"]
    require(isinstance(addresses, list) and isinstance(signers, list), "simulation secondary authenticator fields must be arrays")
    normalized_addresses = [canonical_address(address, f"simulation secondary signer address {index}") for index, address in enumerate(addresses)]
    require(normalized_addresses == tx["secondary_signers"], "simulation secondary signer addresses differ from the requested order")
    require(len(signers) == len(normalized_addresses), "simulation secondary authenticator count differs from the requested signer count")
    for index, (address, authenticator) in enumerate(zip(normalized_addresses, signers, strict=True)):
        expected_key = public_keys_by_address.get(address)
        require(expected_key is not None, f"simulation secondary signer {index} has no bound public profile key")
        require_zero_simulation_authenticator(authenticator, expected_key, f"simulation secondary authenticator {index}")


def expected_operation(candidate: dict[str, Any], roles: dict[str, str], tx: dict[str, Any]) -> None:
    operation = candidate["operation_key"]
    kind = candidate["transaction_kind"]
    function = tx["payload"]["function"]
    arguments = tx["payload"]["arguments"]
    type_arguments = tx["payload"]["type_arguments"]
    require(type_arguments == [], f"{operation} must have no type arguments")

    publish_operations = {
        "core_publish": ("reflection_core", "core_publisher"),
        "assets_publish": ("test_assets", "assets_publisher"),
        "amm_publish": ("test_amm", "amm_publisher"),
    }
    if operation in publish_operations:
        _, sender_role = publish_operations[operation]
        require(kind == "package_publish", f"{operation} must use transaction_kind package_publish")
        require(tx["sender"] == roles[sender_role], f"{operation} sender must be {sender_role}")
        require(tx["secondary_signers"] == [], f"{operation} cannot have secondary signers")
        require(function == "0x1::code::publish_package_txn", f"{operation} must call 0x1::code::publish_package_txn")
        require(len(arguments) == 2, f"{operation} must carry metadata and ordered module byte arrays")
        return

    core_initialize = f"{roles['core_publisher']}::reflection_token::initialize"
    faucet_initialize = f"{roles['assets_publisher']}::test_faucet::initialize"
    pool_initialize = f"{roles['amm_publisher']}::pool::initialize"
    if operation == "core_initialize":
        expected = ("core_initialize", roles["core_publisher"], [], core_initialize, [])
    elif operation == "faucet_initialize":
        expected = ("faucet_initialize", roles["core_publisher"], [roles["assets_publisher"]], faucet_initialize, [])
    elif operation == "pool_initialize":
        expected = (
            "pool_initialize",
            roles["core_publisher"],
            [roles["assets_publisher"], roles["amm_publisher"]],
            pool_initialize,
            [],
        )
    else:
        expected = None
    if expected is not None:
        expected_kind, sender, secondary, expected_function, expected_arguments = expected
        require(kind == expected_kind, f"{operation} has the wrong transaction_kind")
        require(tx["sender"] == sender and tx["secondary_signers"] == secondary, f"{operation} signer order mismatch")
        require(function == expected_function and arguments == expected_arguments, f"{operation} function or argument mismatch")
        return

    if operation == "amm_tusd_claim":
        require(kind == "faucet_claim", "amm_tusd_claim has the wrong transaction_kind")
        require(tx["sender"] == roles["amm_publisher"] and tx["secondary_signers"] == [], "amm_tusd_claim must be a single-signer AMM-publisher transaction")
        require(
            function == f"{roles['assets_publisher']}::test_faucet::claim_tusd" and arguments == [],
            "amm_tusd_claim must call the asset faucet with zero payload arguments",
        )
        return

    if operation == "atomic_operational_handoff":
        require(kind == "operational_handoff", "atomic_operational_handoff has the wrong transaction_kind")
        require(tx["sender"] == roles["core_publisher"], "atomic handoff sender must be core publisher")
        require(
            tx["secondary_signers"]
            == [roles["assets_publisher"], roles["amm_publisher"], roles["operations"]],
            "atomic handoff ordered secondary signers must be assets, AMM, operations",
        )
        require(
            function == f"{roles['amm_publisher']}::pool::set_all_operational_admin" and arguments == [],
            "atomic handoff must call set_all_operational_admin with zero payload arguments",
        )
        return

    if operation == "pool_seed":
        require(kind == "pool_seed", "pool_seed has the wrong transaction_kind")
        require(tx["sender"] == roles["core_publisher"], "pool_seed sender must be core publisher")
        require(
            tx["secondary_signers"] == [roles["amm_publisher"], roles["bootstrap_lp"]],
            "pool_seed ordered secondary signers must be AMM then bootstrap LP",
        )
        require(function == f"{roles['amm_publisher']}::pool::seed_liquidity", "pool_seed function mismatch")
        require(isinstance(arguments, list) and len(arguments) == 3, "pool_seed payload must contain exactly three amount arguments")
        for index, argument in enumerate(arguments):
            require_decimal(argument, f"pool_seed amount argument {index}", positive=True)
        return

    # Individual handoffs and any unknown bootstrap operation fail closed
    # instead of accepting a merely plausible function name or signer list.
    fail(f"unsupported fail-closed operation_key: {operation}")


def validate_simulation(candidate_path: Path, candidate: dict[str, Any], tx: dict[str, Any]) -> dict[str, Any]:
    simulation = require_exact_keys(
        candidate["simulation"],
        ["captured_at", "success", "vm_status", "gas_used", "raw_response_file", "raw_response_sha256", "transaction_semantics_sha256"],
        "simulation",
    )
    require(simulation["success"] is True, "simulation.success must be true")
    require_string(simulation["captured_at"], "simulation.captured_at", TIMESTAMP_RE)
    require_string(simulation["vm_status"], "simulation.vm_status")
    gas_used = require_decimal(simulation["gas_used"], "simulation.gas_used")
    require_string(simulation["raw_response_sha256"], "simulation.raw_response_sha256", SHA256_RE)
    require_string(simulation["transaction_semantics_sha256"], "simulation.transaction_semantics_sha256", SHA256_RE)
    response_path = local_file(candidate_path.parent, simulation["raw_response_file"], "simulation.raw_response_file")
    require(simulation["raw_response_file"] == "simulation-response.json", "simulation response filename must be simulation-response.json")
    require(sha256_file(response_path) == simulation["raw_response_sha256"], "simulation raw-response digest mismatch")
    raw_wrapper = load_json(response_path)
    require_exact_keys(raw_wrapper, ["identity", "responses"], "simulation evidence wrapper")
    require(raw_wrapper["identity"] == candidate["transaction_identity"], "simulation wrapper identity differs from exact built transaction identity")
    raw = raw_wrapper["responses"]
    observed_container = raw[0] if isinstance(raw, list) and len(raw) == 1 else raw
    require(isinstance(observed_container, dict), "simulation response must contain one object")
    require(observed_container.get("success") is True, "raw simulation did not succeed")
    require(str(observed_container.get("vm_status")) == simulation["vm_status"], "simulation vm_status summary mismatch")
    require(str(observed_container.get("gas_used")) == gas_used, "simulation gas_used summary mismatch")
    validate_simulation_authenticator(observed_container, candidate, tx)
    observed_tx = normalize_rest_transaction(raw, "simulation response")
    require(observed_tx == tx, "simulation transaction fields or full payload differ from the candidate")
    semantics_sha = transaction_semantics_digest(tx)
    require(simulation["transaction_semantics_sha256"] == semantics_sha, "simulation semantic digest mismatch")
    return simulation


def validate_candidate(candidate_path: Path, exact_path: Path, profile_path: Path) -> dict[str, Any]:
    candidate = load_json(candidate_path)
    require_exact_keys(
        candidate,
        [
            "schema_version",
            "evidence_scope",
            "status",
            "network",
            "api_url",
            "chain_id",
            "deployment_id",
            "application_commit",
            "exact_address_artifacts_sha256",
            "public_profile_binding",
            "build_environment",
            "roles",
            "transaction_kind",
            "operation_key",
            "transaction",
            "transaction_identity",
            "transaction_semantics_sha256",
            "gas_budget",
            "simulation",
            "publish_binding",
        ],
        "transaction candidate",
    )
    require(candidate["schema_version"] == 2, "transaction candidate schema_version must be 2")
    require(candidate["evidence_scope"] == "testnet-transaction-candidate", "invalid candidate evidence_scope")
    require(candidate["status"] == "simulated-awaiting-detached-approvals", "candidate status is not approvable")
    require(candidate["network"] == NETWORK and candidate["api_url"] == API_URL and candidate["chain_id"] == CHAIN_ID, "candidate is not pinned to Cedra Testnet chain 2")
    require_string(candidate["deployment_id"], "deployment_id", DEPLOYMENT_RE)
    require_string(candidate["application_commit"], "application_commit", COMMIT_RE)
    require_string(candidate["exact_address_artifacts_sha256"], "exact_address_artifacts_sha256", SHA256_RE)
    roles = role_map(candidate["roles"])
    validate_public_profile_binding(candidate["public_profile_binding"], roles)
    require(candidate["transaction_kind"] in {"package_publish", "core_initialize", "faucet_initialize", "pool_initialize", "faucet_claim", "operational_handoff", "pool_seed"}, "unsupported transaction_kind")
    require_string(candidate["operation_key"], "operation_key", re.compile(r"^[a-z][a-z0-9_]{0,63}$"))
    tx = transaction_semantics(candidate["transaction"])
    identity = validate_transaction_identity(candidate["transaction_identity"], tx)
    semantics_sha = transaction_semantics_digest(tx)
    require(candidate["transaction_semantics_sha256"] == semantics_sha, "transaction_semantics_sha256 does not bind the complete normalized transaction")
    expected_operation(candidate, roles, tx)

    budget = require_exact_keys(candidate["gas_budget"], ["approved_max_gas_amount", "approved_max_gas_unit_price", "approved_max_total_fee_base_units"], "gas_budget")
    approved_gas = int(require_decimal(budget["approved_max_gas_amount"], "gas_budget.approved_max_gas_amount", positive=True))
    approved_price = int(require_decimal(budget["approved_max_gas_unit_price"], "gas_budget.approved_max_gas_unit_price", positive=True))
    approved_fee = int(require_decimal(budget["approved_max_total_fee_base_units"], "gas_budget.approved_max_total_fee_base_units", positive=True))
    require(int(tx["max_gas_amount"]) == approved_gas, "approved maximum gas must exactly equal the transaction maximum")
    require(int(tx["gas_unit_price"]) == approved_price, "approved gas unit price must exactly equal the transaction unit price")
    require(int(tx["max_gas_amount"]) * int(tx["gas_unit_price"]) == approved_fee, "approved total fee must exactly equal the transaction worst-case fee")
    simulation = validate_simulation(candidate_path, candidate, tx)
    require(int(simulation["gas_used"]) <= int(tx["max_gas_amount"]), "simulated gas exceeds transaction max gas")

    exact_path = exact_path.resolve()
    require(exact_path.is_file(), "exact-address artifact manifest does not exist")
    require(sha256_file(exact_path) == candidate["exact_address_artifacts_sha256"], "candidate exact-address artifact digest mismatch")
    exact = load_json(exact_path)
    require(exact.get("schema_version") == 3 and exact.get("evidence_scope") == "local-exact-address-build-only", "candidate does not reference an exact-address v3 bundle")
    exact_roles = role_map(exact.get("roles"), "exact-address roles")
    require(exact_roles == roles, "candidate roles differ from exact-address bundle roles")
    require(exact.get("application_commit") == candidate["application_commit"], "candidate application commit differs from exact-address bundle")
    validate_external_profile_binding(candidate, exact, profile_path.resolve(), roles)
    validate_build_environment(candidate["build_environment"], candidate["application_commit"], exact)

    publish_operations = {
        "core_publish": "reflection_core",
        "assets_publish": "test_assets",
        "amm_publish": "test_amm",
    }
    if candidate["operation_key"] in publish_operations:
        package_key = publish_operations[candidate["operation_key"]]
        binding = require_exact_keys(candidate["publish_binding"], ["package_key", "publish_payload_sha256", "compiled_package_files_manifest_sha256"], "publish_binding")
        require(binding["package_key"] == package_key, "publish_binding package does not match operation_key")
        package = exact.get("packages", {}).get(package_key)
        require(isinstance(package, dict), "exact-address package binding is missing")
        require(binding["publish_payload_sha256"] == package.get("publish_payload_sha256"), "publish payload digest differs from exact-address bundle")
        require(binding["compiled_package_files_manifest_sha256"] == package.get("compiled_package_files_manifest_sha256"), "compiled package-file manifest digest differs from exact-address bundle")
        payload_file = exact_path.parent / package_key / str(package.get("publish_payload_file"))
        require(payload_file.is_file() and not payload_file.is_symlink(), "bound exact publish-payload file is missing")
        require(sha256_file(payload_file) == binding["publish_payload_sha256"], "exact publish-payload file digest mismatch")
        exact_payload = load_json(payload_file)
        require(transaction_semantics({**tx, "payload": exact_payload})["payload"] == tx["payload"], "candidate full publish payload differs from reviewed package bytes")
    else:
        require(candidate["publish_binding"] is None, "non-publish candidate must have null publish_binding")
    return candidate


def approval_statement(candidate_path: Path, exact_path: Path, profile_path: Path) -> dict[str, Any]:
    candidate = validate_candidate(candidate_path, exact_path, profile_path)
    tx = transaction_semantics(candidate["transaction"])
    simulation = candidate["simulation"]
    return {
        "schema_version": 1,
        "signature_namespace": APPROVAL_NAMESPACE,
        "decision": "approve-exact-cedra-testnet-transaction-candidate",
        "deployment_id": candidate["deployment_id"],
        "network": NETWORK,
        "chain_id": CHAIN_ID,
        "application_commit": candidate["application_commit"],
        "exact_address_artifacts_sha256": candidate["exact_address_artifacts_sha256"],
        "public_profile_evidence_sha256": candidate["public_profile_binding"]["evidence_sha256"],
        "public_role_candidate_sha256": candidate["public_profile_binding"]["public_role_candidate_sha256"],
        "profile_bindings_sha256": sha256_bytes(canonical_json_bytes(candidate["public_profile_binding"]["profiles"])),
        "build_environment_sha256": sha256_bytes(canonical_json_bytes(candidate["build_environment"])),
        "candidate_sha256": sha256_file(candidate_path),
        "transaction_kind": candidate["transaction_kind"],
        "operation_key": candidate["operation_key"],
        "transaction_semantics_sha256": candidate["transaction_semantics_sha256"],
        "sender": tx["sender"],
        "ordered_secondary_signers": tx["secondary_signers"],
        "sequence_number": tx["sequence_number"],
        "expiration_timestamp_secs": tx["expiration_timestamp_secs"],
        "max_gas_amount": tx["max_gas_amount"],
        "gas_unit_price": tx["gas_unit_price"],
        "payload_sha256": sha256_bytes(canonical_json_bytes(tx["payload"])),
        "transaction_identity_sha256": sha256_bytes(canonical_json_bytes(candidate["transaction_identity"])),
        "raw_transaction_sha256": candidate["transaction_identity"]["rawTransactionSha256"],
        "multi_agent_or_single_transaction_sha256": candidate["transaction_identity"]["transactionSha256"],
        "signing_message_sha256": candidate["transaction_identity"]["signingMessageSha256"],
        "simulation_response_sha256": simulation["raw_response_sha256"],
        "gas_budget": candidate["gas_budget"],
    }


def validate_envelope(envelope_path: Path, trusted_path: Path, exact_path: Path, profile_path: Path) -> dict[str, Any]:
    envelope = load_json(envelope_path)
    require_exact_keys(
        envelope,
        ["schema_version", "evidence_scope", "status", "signature_namespace", "candidate_file", "candidate_sha256", "statement_file", "statement_sha256", "exact_address_artifacts_sha256", "public_profile_evidence_sha256", "public_role_candidate_sha256", "trusted_allowed_signers_sha256", "approvals"],
        "approval envelope",
    )
    require(envelope["schema_version"] == 1, "approval envelope schema_version must be 1")
    require(envelope["evidence_scope"] == "detached-transaction-approval-envelope" and envelope["status"] == "signed", "approval envelope is not signed")
    require(envelope["signature_namespace"] == APPROVAL_NAMESPACE, "approval signature namespace mismatch")
    require_string(envelope["candidate_sha256"], "candidate_sha256", SHA256_RE)
    require_string(envelope["statement_sha256"], "statement_sha256", SHA256_RE)
    require_string(envelope["exact_address_artifacts_sha256"], "exact_address_artifacts_sha256", SHA256_RE)
    require_string(envelope["public_profile_evidence_sha256"], "public_profile_evidence_sha256", SHA256_RE)
    require_string(envelope["public_role_candidate_sha256"], "public_role_candidate_sha256", SHA256_RE)
    require_string(envelope["trusted_allowed_signers_sha256"], "trusted_allowed_signers_sha256", SHA256_RE)
    require(trusted_path.is_file() and not trusted_path.is_symlink(), "trusted allowed-signers file must be a regular non-symlink file")
    require(sha256_file(trusted_path) == envelope["trusted_allowed_signers_sha256"], "trusted allowed-signers trust-anchor digest mismatch")
    candidate_path = local_file(envelope_path.parent, envelope["candidate_file"], "candidate_file")
    statement_path = local_file(envelope_path.parent, envelope["statement_file"], "statement_file")
    require(envelope["candidate_file"] == "transaction-candidate.json", "approval candidate filename must be transaction-candidate.json")
    require(envelope["statement_file"] == "approval-statement.json", "approval statement filename must be approval-statement.json")
    require(sha256_file(candidate_path) == envelope["candidate_sha256"], "approval candidate digest mismatch")
    require(sha256_file(statement_path) == envelope["statement_sha256"], "approval statement digest mismatch")
    candidate = validate_candidate(candidate_path, exact_path, profile_path)
    require(envelope["exact_address_artifacts_sha256"] == candidate["exact_address_artifacts_sha256"] == sha256_file(exact_path), "approval envelope exact-address digest mismatch")
    require(envelope["public_profile_evidence_sha256"] == candidate["public_profile_binding"]["evidence_sha256"] == sha256_file(profile_path), "approval envelope public-profile digest mismatch")
    require(envelope["public_role_candidate_sha256"] == candidate["public_profile_binding"]["public_role_candidate_sha256"], "approval envelope public-role candidate digest mismatch")
    expected_statement = approval_statement(candidate_path, exact_path, profile_path)
    try:
        observed_statement_bytes = statement_path.read_bytes()
    except OSError as exc:
        fail(f"cannot read approval statement: {exc}")
    require(observed_statement_bytes == canonical_json_bytes(expected_statement), "approval statement is not the canonical derivation of the exact candidate")
    approvals = envelope["approvals"]
    require(isinstance(approvals, list) and len(approvals) == 2, "exactly two detached approvals are required")
    identities: list[str] = []
    key_fingerprints: list[str] = []
    signature_names: list[str] = []
    for index, approval in enumerate(approvals):
        require_exact_keys(approval, ["identity", "key_fingerprint", "signature_file", "signature_sha256"], f"approvals[{index}]")
        identity = require_string(approval["identity"], f"approvals[{index}].identity", re.compile(r"^[A-Za-z0-9][A-Za-z0-9@._+-]{0,127}$"))
        key_fingerprint = require_string(approval["key_fingerprint"], f"approvals[{index}].key_fingerprint", re.compile(r"^SHA256:[A-Za-z0-9+/=]{43,44}$"))
        signature_path = local_file(envelope_path.parent, approval["signature_file"], f"approvals[{index}].signature_file")
        require(sha256_file(signature_path) == require_string(approval["signature_sha256"], f"approvals[{index}].signature_sha256", SHA256_RE), f"approval signature digest mismatch for {identity}")
        identities.append(identity)
        key_fingerprints.append(key_fingerprint)
        signature_names.append(str(approval["signature_file"]))
    require(len(set(identities)) == 2, "approval identities must be distinct")
    require(len(set(key_fingerprints)) == 2, "approval signing-key fingerprints must be distinct")
    require(len(set(signature_names)) == 2, "approval signature filenames must be distinct")
    reserved_names = {
        "transaction-candidate.json",
        "approval-statement.json",
        "approval-envelope.json",
        "simulation-response.json",
        "transaction-response.json",
        "ledger-info-response.json",
        "transaction-evidence.json",
    }
    require(not (reserved_names & set(signature_names)), "approval signature filenames collide with reserved evidence files")
    return envelope


def validate_observed(candidate_path: Path, exact_path: Path, profile_path: Path, transaction_path: Path, ledger_path: Path, expected_hash: str) -> dict[str, Any]:
    candidate = validate_candidate(candidate_path, exact_path, profile_path)
    require(TX_HASH_RE.fullmatch(expected_hash) is not None, "expected transaction hash is invalid")
    raw_transaction = load_json(transaction_path)
    raw_ledger = load_json(ledger_path)
    require(isinstance(raw_transaction, dict) and isinstance(raw_ledger, dict), "finalized transaction and ledger responses must be objects")
    require(str(raw_transaction.get("type")) == "user_transaction", "observed transaction is not a user_transaction")
    require(str(raw_transaction.get("hash", "")).lower() == expected_hash, "observed transaction hash mismatch")
    require(raw_transaction.get("success") is True, "observed transaction did not succeed")
    require(str(raw_ledger.get("chain_id")) == CHAIN_ID, "observed ledger is not Cedra Testnet chain 2")
    expected_tx = transaction_semantics(candidate["transaction"])
    signature_type, _ = normalize_rest_signature(raw_transaction.get("signature"), "finalized transaction")
    observed_tx = normalize_rest_transaction(raw_transaction, "finalized transaction")
    require(observed_tx == expected_tx, "finalized transaction fields, signer order, or full payload differ from approved candidate")
    version = require_decimal(str(raw_transaction.get("version")), "finalized version")
    ledger_head = require_decimal(str(raw_ledger.get("ledger_version")), "ledger head")
    require(int(version) <= int(ledger_head), "finalized version is newer than observed ledger head")
    gas_used = require_decimal(str(raw_transaction.get("gas_used")), "finalized gas_used")
    require(int(gas_used) <= int(expected_tx["max_gas_amount"]), "finalized gas used exceeds approved transaction maximum")
    actual_fee = int(gas_used) * int(expected_tx["gas_unit_price"])
    require(actual_fee <= int(candidate["gas_budget"]["approved_max_total_fee_base_units"]), "finalized actual fee exceeds approval ceiling")
    package_registry: dict[str, Any] | None = None
    publish_packages = {
        "core_publish": "reflection_core",
        "assets_publish": "test_assets",
        "amm_publish": "test_amm",
    }
    if candidate["operation_key"] in publish_packages:
        package_key = publish_packages[candidate["operation_key"]]
        exact = load_json(exact_path)
        embedded = exact.get("packages", {}).get(package_key, {}).get("embedded_package_metadata")
        require_exact_keys(embedded, ["name", "source_digest", "upgrade_number", "upgrade_policy_number"], "embedded PackageMetadata")
        changes = raw_transaction.get("changes")
        require(isinstance(changes, list), "finalized package publish has no write-set changes")
        matching_registries: list[dict[str, Any]] = []
        for change in changes:
            if not isinstance(change, dict) or change.get("type") != "write_resource":
                continue
            try:
                resource_address = canonical_address(change.get("address"), "PackageRegistry resource address")
            except EvidenceError:
                continue
            data = change.get("data")
            if not isinstance(data, dict):
                continue
            try:
                resource_type = canonical_function_like_resource(data.get("type"))
            except EvidenceError:
                continue
            if resource_type != "0x1::code::PackageRegistry":
                continue
            resource_data = data.get("data")
            packages = resource_data.get("packages") if isinstance(resource_data, dict) else None
            if resource_address != expected_tx["sender"] or not isinstance(packages, list):
                continue
            for installed in packages:
                if isinstance(installed, dict) and installed.get("name") == embedded["name"]:
                    matching_registries.append(installed)
        require(len(matching_registries) == 1, "finalized publish must contain exactly one matching sender PackageRegistry package")
        installed = matching_registries[0]
        policy = installed.get("upgrade_policy")
        require(isinstance(policy, dict), "on-chain PackageMetadata upgrade_policy is malformed")
        require(str(installed.get("upgrade_number")) == embedded["upgrade_number"] == "0", "on-chain PackageMetadata upgrade_number is not the reviewed initial value")
        require(str(policy.get("policy")) == str(embedded["upgrade_policy_number"]) == "2", "on-chain PackageMetadata upgrade policy is not immutable")
        require(installed.get("source_digest") == embedded["source_digest"], "on-chain PackageMetadata source_digest differs from reviewed package metadata bytes")
        package_registry = {
            "resource_address": expected_tx["sender"],
            "resource_type": "0x1::code::PackageRegistry",
            "package_name": embedded["name"],
            "source_digest": embedded["source_digest"],
            "upgrade_number": "0",
            "upgrade_policy_number": 2,
        }
    return {
        "transaction_type": "user_transaction",
        "sender": observed_tx["sender"],
        "secondary_signers": observed_tx["secondary_signers"],
        "sequence_number": observed_tx["sequence_number"],
        "expiration_timestamp_secs": observed_tx["expiration_timestamp_secs"],
        "payload": observed_tx["payload"],
        "transaction_semantics_sha256": transaction_semantics_digest(observed_tx),
        "ledger_version": version,
        "ledger_head_at_observation": ledger_head,
        "chain_id": CHAIN_ID,
        "success": True,
        "vm_status": require_string(raw_transaction.get("vm_status"), "finalized vm_status"),
        "gas_used": gas_used,
        "max_gas_amount": observed_tx["max_gas_amount"],
        "gas_unit_price": observed_tx["gas_unit_price"],
        "actual_fee_base_units": str(actual_fee),
        "gas_budget_satisfied": True,
        "package_registry": package_registry,
        "rest_signature_type": signature_type,
        "fee_payer_present": False,
        "rest_observation_boundaries": {
            "fee_payer_absence_observed": True,
            "fungible_asset_gas_type_observed": False,
            "raw_transaction_bcs_observed": False,
            "transaction_wrapper_bcs_observed": False,
            "signing_message_observed": False,
        },
    }


def validate_finalized(evidence_path: Path, exact_path: Path, profile_path: Path, trusted_path: Path) -> dict[str, Any]:
    evidence = load_json(evidence_path)
    require_exact_keys(
        evidence,
        [
            "schema_version",
            "evidence_scope",
            "status",
            "network",
            "api_url",
            "chain_id",
            "deployment_id",
            "application_commit",
            "exact_address_artifacts_sha256",
            "public_profile_evidence_sha256",
            "public_role_candidate_sha256",
            "roles",
            "transaction_kind",
            "operation_key",
            "transaction_hash",
            "candidate",
            "simulation",
            "approval",
            "collection",
            "state_changes_performed_by_collector",
        ],
        "finalized transaction evidence",
    )
    require(evidence["schema_version"] == 2, "finalized transaction schema_version must be 2")
    require(evidence["evidence_scope"] == "finalized-testnet-transaction" and evidence["status"] == "finalized", "transaction evidence is not finalized")
    require(evidence["network"] == NETWORK and evidence["api_url"] == API_URL and evidence["chain_id"] == CHAIN_ID, "finalized evidence is not pinned to Cedra Testnet chain 2")
    require_string(evidence["deployment_id"], "deployment_id", DEPLOYMENT_RE)
    require_string(evidence["application_commit"], "application_commit", COMMIT_RE)
    require_string(evidence["exact_address_artifacts_sha256"], "exact_address_artifacts_sha256", SHA256_RE)
    require_string(evidence["public_profile_evidence_sha256"], "public_profile_evidence_sha256", SHA256_RE)
    require_string(evidence["public_role_candidate_sha256"], "public_role_candidate_sha256", SHA256_RE)
    roles = role_map(evidence["roles"])
    require_string(evidence["transaction_hash"], "transaction_hash", TX_HASH_RE)
    require(evidence["state_changes_performed_by_collector"] is False, "collector state-change boundary must be false")

    candidate_binding = require_exact_keys(
        evidence["candidate"],
        ["file", "sha256", "transaction_semantics_sha256", "transaction_identity_sha256", "raw_transaction_sha256", "transaction_sha256", "signing_message_sha256"],
        "candidate binding",
    )
    candidate_path = local_file(evidence_path.parent, candidate_binding["file"], "candidate.file")
    require(candidate_binding["file"] == "transaction-candidate.json", "finalized candidate filename mismatch")
    require(sha256_file(candidate_path) == require_string(candidate_binding["sha256"], "candidate.sha256", SHA256_RE), "finalized candidate digest mismatch")
    candidate = validate_candidate(candidate_path, exact_path, profile_path)
    require(candidate["deployment_id"] == evidence["deployment_id"], "finalized deployment id differs from candidate")
    require(candidate["application_commit"] == evidence["application_commit"], "finalized application commit differs from candidate")
    require(candidate["exact_address_artifacts_sha256"] == evidence["exact_address_artifacts_sha256"], "finalized exact-address digest differs from candidate")
    require(candidate["public_profile_binding"]["evidence_sha256"] == evidence["public_profile_evidence_sha256"] == sha256_file(profile_path), "finalized public-profile digest differs from candidate or supplied evidence")
    require(candidate["public_profile_binding"]["public_role_candidate_sha256"] == evidence["public_role_candidate_sha256"], "finalized public-role candidate digest differs from candidate")
    require(role_map(candidate["roles"]) == roles, "finalized roles differ from candidate")
    require(candidate["transaction_kind"] == evidence["transaction_kind"] and candidate["operation_key"] == evidence["operation_key"], "finalized operation differs from candidate")
    require(candidate_binding["transaction_semantics_sha256"] == candidate["transaction_semantics_sha256"], "finalized semantic digest mismatch")
    identity = candidate["transaction_identity"]
    require(candidate_binding["transaction_identity_sha256"] == sha256_bytes(canonical_json_bytes(identity)), "finalized transaction identity digest mismatch")
    require(candidate_binding["raw_transaction_sha256"] == identity["rawTransactionSha256"], "finalized raw transaction digest mismatch")
    require(candidate_binding["transaction_sha256"] == identity["transactionSha256"], "finalized transaction wrapper digest mismatch")
    require(candidate_binding["signing_message_sha256"] == identity["signingMessageSha256"], "finalized signing-message digest mismatch")

    simulation_binding = require_exact_keys(evidence["simulation"], ["file", "sha256"], "simulation binding")
    simulation_path = local_file(evidence_path.parent, simulation_binding["file"], "simulation.file")
    require(simulation_binding["file"] == "simulation-response.json", "finalized simulation filename mismatch")
    require(sha256_file(simulation_path) == simulation_binding["sha256"] == candidate["simulation"]["raw_response_sha256"], "finalized simulation digest mismatch")

    approval = require_exact_keys(
        evidence["approval"],
        ["envelope_file", "envelope_sha256", "statement_file", "statement_sha256", "trusted_allowed_signers_sha256", "signatures", "authenticated", "verifier"],
        "approval binding",
    )
    envelope_path = local_file(evidence_path.parent, approval["envelope_file"], "approval.envelope_file")
    statement_path = local_file(evidence_path.parent, approval["statement_file"], "approval.statement_file")
    require(approval["envelope_file"] == "approval-envelope.json" and approval["statement_file"] == "approval-statement.json", "finalized approval filenames mismatch")
    require(sha256_file(envelope_path) == require_string(approval["envelope_sha256"], "approval.envelope_sha256", SHA256_RE), "finalized approval envelope digest mismatch")
    require(sha256_file(statement_path) == require_string(approval["statement_sha256"], "approval.statement_sha256", SHA256_RE), "finalized approval statement digest mismatch")
    envelope = validate_envelope(envelope_path, trusted_path, exact_path, profile_path)
    require(approval["trusted_allowed_signers_sha256"] == envelope["trusted_allowed_signers_sha256"], "finalized approval trust-anchor digest mismatch")
    require(approval["signatures"] == envelope["approvals"], "finalized detached signature bindings differ from envelope")
    require(approval["authenticated"] is True and approval["verifier"] == "OpenSSH ssh-keygen -Y verify", "finalized approval authentication marker mismatch")

    collection = require_exact_keys(
        evidence["collection"],
        [
            "transaction_type",
            "sender",
            "secondary_signers",
            "sequence_number",
            "expiration_timestamp_secs",
            "payload",
            "transaction_semantics_sha256",
            "ledger_version",
            "ledger_head_at_observation",
            "chain_id",
            "success",
            "vm_status",
            "gas_used",
            "max_gas_amount",
            "gas_unit_price",
            "actual_fee_base_units",
            "gas_budget_satisfied",
            "package_registry",
            "rest_signature_type",
            "fee_payer_present",
            "rest_observation_boundaries",
            "collected_at",
            "raw_transaction_response_file",
            "raw_transaction_response_sha256",
            "ledger_info_response_file",
            "ledger_info_response_sha256",
            "read_only_requests",
        ],
        "collection",
    )
    require_string(collection["collected_at"], "collection.collected_at", TIMESTAMP_RE)
    transaction_response_path = local_file(evidence_path.parent, collection["raw_transaction_response_file"], "collection.raw_transaction_response_file")
    ledger_response_path = local_file(evidence_path.parent, collection["ledger_info_response_file"], "collection.ledger_info_response_file")
    require(collection["raw_transaction_response_file"] == "transaction-response.json" and collection["ledger_info_response_file"] == "ledger-info-response.json", "raw response filenames mismatch")
    require(sha256_file(transaction_response_path) == require_string(collection["raw_transaction_response_sha256"], "collection.raw_transaction_response_sha256", SHA256_RE), "raw finalized transaction response digest mismatch")
    require(sha256_file(ledger_response_path) == require_string(collection["ledger_info_response_sha256"], "collection.ledger_info_response_sha256", SHA256_RE), "raw ledger response digest mismatch")
    require(collection["read_only_requests"] == ["GET /transactions/by_hash/{hash}", "GET /"], "collector request boundary mismatch")
    observed = validate_observed(candidate_path, exact_path, profile_path, transaction_response_path, ledger_response_path, evidence["transaction_hash"])
    for key, value in observed.items():
        require(collection.get(key) == value, f"finalized collection summary mismatch for {key}")
    return evidence


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(dest="command", required=True)

    digest_parser = subparsers.add_parser("transaction-digest")
    digest_parser.add_argument("candidate", type=Path)

    candidate_parser = subparsers.add_parser("validate-candidate")
    candidate_parser.add_argument("candidate", type=Path)
    candidate_parser.add_argument("exact_artifacts", type=Path)
    candidate_parser.add_argument("public_profile_evidence", type=Path)

    statement_parser = subparsers.add_parser("render-approval-statement")
    statement_parser.add_argument("candidate", type=Path)
    statement_parser.add_argument("exact_artifacts", type=Path)
    statement_parser.add_argument("public_profile_evidence", type=Path)

    envelope_parser = subparsers.add_parser("validate-envelope")
    envelope_parser.add_argument("envelope", type=Path)
    envelope_parser.add_argument("trusted_allowed_signers", type=Path)
    envelope_parser.add_argument("exact_artifacts", type=Path)
    envelope_parser.add_argument("public_profile_evidence", type=Path)

    observed_parser = subparsers.add_parser("validate-observed")
    observed_parser.add_argument("candidate", type=Path)
    observed_parser.add_argument("exact_artifacts", type=Path)
    observed_parser.add_argument("public_profile_evidence", type=Path)
    observed_parser.add_argument("transaction_response", type=Path)
    observed_parser.add_argument("ledger_response", type=Path)
    observed_parser.add_argument("transaction_hash")

    finalized_parser = subparsers.add_parser("validate-finalized")
    finalized_parser.add_argument("evidence", type=Path)
    finalized_parser.add_argument("exact_artifacts", type=Path)
    finalized_parser.add_argument("public_profile_evidence", type=Path)
    finalized_parser.add_argument("trusted_allowed_signers", type=Path)

    args = parser.parse_args()
    if args.command == "transaction-digest":
        candidate = load_json(args.candidate)
        print(transaction_semantics_digest(candidate.get("transaction")))
    elif args.command == "validate-candidate":
        validate_candidate(args.candidate.resolve(), args.exact_artifacts.resolve(), args.public_profile_evidence.resolve())
        print(f"valid exact transaction candidate: {args.candidate.resolve()}")
    elif args.command == "render-approval-statement":
        statement = approval_statement(args.candidate.resolve(), args.exact_artifacts.resolve(), args.public_profile_evidence.resolve())
        sys.stdout.buffer.write(canonical_json_bytes(statement))
    elif args.command == "validate-envelope":
        validate_envelope(args.envelope.resolve(), args.trusted_allowed_signers.resolve(), args.exact_artifacts.resolve(), args.public_profile_evidence.resolve())
        print(f"valid detached approval envelope structure: {args.envelope.resolve()}")
    elif args.command == "validate-observed":
        summary = validate_observed(
            args.candidate.resolve(),
            args.exact_artifacts.resolve(),
            args.public_profile_evidence.resolve(),
            args.transaction_response.resolve(),
            args.ledger_response.resolve(),
            args.transaction_hash.lower(),
        )
        sys.stdout.buffer.write(canonical_json_bytes(summary))
    elif args.command == "validate-finalized":
        validate_finalized(args.evidence.resolve(), args.exact_artifacts.resolve(), args.public_profile_evidence.resolve(), args.trusted_allowed_signers.resolve())
        print(f"valid cross-bound finalized transaction evidence: {args.evidence.resolve()}")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except EvidenceError as exc:
        print(f"release evidence validation failed: {exc}", file=sys.stderr)
        raise SystemExit(65)
