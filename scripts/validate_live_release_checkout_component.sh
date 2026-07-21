#!/usr/bin/env bash
set -euo pipefail

export LC_ALL=C
export LANG=C
export PATH=/usr/bin:/bin

usage() {
  /usr/bin/printf 'usage: %s REPOSITORY_ROOT CANDIDATE_OR_BUILD_REQUEST_JSON EXACT_ADDRESS_ARTIFACTS_JSON\n' "$0" >&2
  exit 64
}

[[ $# -eq 3 ]] || usage
repository_input="$1"
subject_input="$2"
exact_input="$3"

[[ -d "$repository_input" && ! -L "$repository_input" ]] || {
  /usr/bin/printf 'release repository must be a real directory\n' >&2
  exit 66
}
for input in "$subject_input" "$exact_input"; do
  [[ -f "$input" && ! -L "$input" ]] || {
    /usr/bin/printf 'live-check inputs must be regular non-symlink files: %s\n' "$input" >&2
    exit 66
  }
done

repository="$(/usr/bin/readlink -f "$repository_input")"
subject="$(/usr/bin/readlink -f "$subject_input")"
exact="$(/usr/bin/readlink -f "$exact_input")"
git_clean=(
  /usr/bin/env -i PATH=/usr/bin:/bin LC_ALL=C LANG=C
  /usr/bin/git -c "safe.directory=$repository" -C "$repository"
)

"${git_clean[@]}" rev-parse --is-inside-work-tree >/dev/null 2>&1 || {
  /usr/bin/printf 'release repository is not a Git working tree: %s\n' "$repository" >&2
  exit 65
}
[[ "$("${git_clean[@]}" rev-parse --show-toplevel)" == "$repository" ]] || {
  /usr/bin/printf 'release repository argument is not the exact Git worktree root\n' >&2
  exit 65
}
git_directory="$("${git_clean[@]}" rev-parse --absolute-git-dir)"
git_common_directory="$("${git_clean[@]}" rev-parse --path-format=absolute --git-common-dir)"
[[ "$git_directory" == "$repository/.git" && "$git_common_directory" == "$repository/.git" \
  && -d "$repository/.git" && ! -L "$repository/.git" ]] || {
  /usr/bin/printf 'release checkout must be a standalone clone with its real Git directory inside the isolated root\n' >&2
  exit 65
}
porcelain="$("${git_clean[@]}" status --porcelain=v1 --untracked-files=all)"
[[ -z "$porcelain" ]] || {
  /usr/bin/printf 'release checkout is not completely clean, including untracked files\n%s\n' "$porcelain" >&2
  exit 65
}

while IFS= builtin read -r -d '' tagged; do
  [[ "${tagged:0:2}" == 'H ' ]] || {
    /usr/bin/printf 'tracked path has an index state flag (assume-unchanged, skip-worktree, fsmonitor-valid, or nonstandard state): %s\n' "${tagged:2}" >&2
    exit 65
  }
done < <("${git_clean[@]}" ls-files -v -f -z)

head_commit="$("${git_clean[@]}" rev-parse --verify HEAD)"
head_tree="$("${git_clean[@]}" rev-parse --verify 'HEAD^{tree}')"
[[ "$("${git_clean[@]}" write-tree)" == "$head_tree" ]] || {
  /usr/bin/printf 'release index tree differs from HEAD\n' >&2
  exit 65
}

while IFS= builtin read -r -d '' record; do
  metadata="${record%%$'\t'*}"
  tracked_path="${record#*$'\t'}"
  IFS=' ' builtin read -r tracked_mode tracked_type tracked_oid <<<"$metadata"
  [[ "$tracked_type" == blob && ( "$tracked_mode" == 100644 || "$tracked_mode" == 100755 ) ]] || {
    /usr/bin/printf 'release tree contains an unsupported tracked object: %s\n' "$tracked_path" >&2
    exit 65
  }
  working_path="$repository/$tracked_path"
  [[ -f "$working_path" && ! -L "$working_path" ]] || {
    /usr/bin/printf 'tracked working path is not a regular non-symlink file: %s\n' "$tracked_path" >&2
    exit 65
  }
  actual_mode="$(/usr/bin/stat -c '%a' "$working_path")"
  actual_execute=$((8#$actual_mode & 8#111))
  if [[ "$tracked_mode" == 100755 ]]; then
    [[ "$actual_execute" -eq $((8#111)) ]] || {
      /usr/bin/printf 'tracked executable mode differs from HEAD: %s\n' "$tracked_path" >&2
      exit 65
    }
  else
    [[ "$actual_execute" -eq 0 ]] || {
      /usr/bin/printf 'tracked non-executable mode differs from HEAD: %s\n' "$tracked_path" >&2
      exit 65
    }
  fi
  "${git_clean[@]}" cat-file blob "$tracked_oid" | /usr/bin/cmp -s - "$working_path" || {
    /usr/bin/printf 'tracked working bytes differ from the exact HEAD blob: %s\n' "$tracked_path" >&2
    exit 65
  }
done < <("${git_clean[@]}" ls-tree -r -z --full-tree HEAD)

/usr/bin/jq -e '
  .schema_version == 3
  and .evidence_scope == "local-exact-address-build-only"
  and .working_tree_clean == true
  and (.application_commit | type == "string" and test("^[0-9a-f]{40}$"))
  and (.application_tree | type == "string" and test("^[0-9a-f]{40}$"))
' "$exact" >/dev/null || {
  /usr/bin/printf 'live-check exact-address input is not a clean v3 release bundle\n' >&2
  exit 65
}
subject_commit="$(/usr/bin/jq -er '.application_commit | select(type == "string" and test("^[0-9a-f]{40}$"))' "$subject")"
exact_commit="$(/usr/bin/jq -er '.application_commit' "$exact")"
exact_tree="$(/usr/bin/jq -er '.application_tree' "$exact")"

[[ "$head_commit" == "$subject_commit" && "$head_commit" == "$exact_commit" ]] || {
  /usr/bin/printf 'live HEAD differs from the candidate/request or exact-address commit\n' >&2
  exit 65
}
[[ "$head_tree" == "$exact_tree" ]] || {
  /usr/bin/printf 'live HEAD tree differs from the exact-address application tree\n' >&2
  exit 65
}

if /usr/bin/jq -e 'has("build_environment")' "$subject" >/dev/null; then
  /usr/bin/jq -e --arg head "$head_commit" --arg tree "$head_tree" '
    .build_environment.repository_head_commit == $head
    and .build_environment.repository_head_tree == $tree
  ' "$subject" >/dev/null || {
    /usr/bin/printf 'candidate build environment differs from live HEAD/tree\n' >&2
    exit 65
  }
fi

/usr/bin/printf 'release checkout bytes, modes, index flags, HEAD, and tree are exactly bound to %s %s\n' "$head_commit" "$head_tree"
