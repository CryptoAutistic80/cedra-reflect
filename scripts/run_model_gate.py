#!/usr/bin/env python3
"""Run the honest randomized accounting gate and optionally persist evidence."""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
PYTHON_ROOT = ROOT / "python"
if str(PYTHON_ROOT) not in sys.path:
    sys.path.insert(0, str(PYTHON_ROOT))

from reflection_model.workload import (  # noqa: E402
    GitProvenance,
    config_from_environment,
    read_git_provenance,
    run_randomized_workload,
    write_json_report,
)


def main() -> int:
    config = config_from_environment()
    report_text = os.environ.get("REFLECTION_MODEL_REPORT")
    report_path = Path(report_text).expanduser().resolve() if report_text else None

    start_provenance = read_git_provenance(ROOT)
    if report_path is not None and (
        start_provenance.commit is None or start_provenance.clean is not True
    ):
        print(
            "refusing to generate model-gate evidence from an unknown or dirty source tree",
            file=sys.stderr,
        )
        return 64

    result = run_randomized_workload(config)
    if result.model.automatic_materialization:
        print(
            "model gate is not claim-backed; refusing incompatible evidence",
            file=sys.stderr,
        )
        return 66
    provenance = start_provenance
    if report_path is not None:
        end_provenance = read_git_provenance(ROOT)
        if end_provenance != start_provenance or end_provenance.clean is not True:
            print(
                "source commit or worktree changed during model-gate execution; "
                "report not written",
                file=sys.stderr,
            )
            return 65
        report = result.report(end_provenance)
    else:
        # A non-evidence console summary may still disclose safely available
        # provenance, including an explicit dirty state.
        if provenance.commit is None:
            provenance = GitProvenance(commit=None, clean=None)
        report = result.report(provenance)

    if (
        report.get("materialization_mode") != "claim-backed"
        or report.get("automatic_materialization") is not False
    ):
        print("model-gate report is not bound to claim-backed mode", file=sys.stderr)
        return 67

    if report_path is not None:
        write_json_report(report_path, report)

    print(json.dumps(report, indent=2, sort_keys=True))
    if report_path is not None:
        print(f"model-gate report: {report_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
