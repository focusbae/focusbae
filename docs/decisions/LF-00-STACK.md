# LF-00: Initial Desktop Stack and Boundaries

Date: 2026-09-10. Status: qualified candidate for review, not a production upgrade.
Evidence: LF-00 report. Contracts: version 2.

## Runtime and Storage (D-01, D-13)

Qualify Electron 43.7.0 with better-sqlite3 13.0.3, SQLite 3.53.4 and sqlite-vec
0.1.9 on macOS arm64. Keep production Electron 30 untouched until LF-03 integrates
and regression-tests the upgrade. Stable 43 is the preceding supported major;
44 changes clipboard APIs used synchronously by clipboard-manager.js. This is a
bounded upgrade target, not permission to stay on 43 after support ends. Recheck
the supported branch and security patch before integration/release.
[Electron 44 migration changes](https://www.electronjs.org/blog/electron-44-0),
[Electron support policy](https://www.electronjs.org/docs/latest/tutorial/electron-timelines)

The installed better-sqlite3 13 package contains Node-API prebuilds and declares
`gypfile: false`; it does not need an Electron-specific SQLite rebuild in this
fixture. Both development and packaged processes loaded the bundled arm64
binding. Its SQL API supports the required transaction, FTS and online backup
operations. A custom node:sqlite adapter is therefore unnecessary here.

Use sqlite-vec only for a derived search cache after model/quality qualification.
Do not make it the authoritative database for any user content. Keep the cache in
a separate per-workspace search.sqlite, so an incompatible extension cannot block
ordinary notebook open/save. Load only a shipped, verified native extension from
the worker, never a renderer-provided path. Use integer/BigInt bindings correctly
for vec0 integer metadata; unsupported filters cannot be silently ignored.
[Search design and alternatives](SEARCH_RESEARCH.md)

Native packaging must unpack `.node` files, the sqlite-vec platform dylib, Whisper
with its neighboring dylibs, AudioTee and nut-js. The existing Whisper loader-path
repair was necessary in the isolated fresh dependency. Keep an explicit helper
signing/entitlement gate in LF-12. Module load is not real capture validation.

## Renderer and Content (D-02)

Use a standalone Vite build with relative asset paths, React and TipTap; no Next
runtime/CDN/server in the desktop renderer. Preserve CommonJS main and use a
sandboxed, context-isolated renderer. Candidate pins: Node LTS 24.21.0, Vite 8.3.0,
React/react-dom 19.2.7, TipTap core/pm/react/starter-kit 3.31.3. Web installed TipTap
was 3.27.4; pin a coherent desktop extension set rather than inheriting unbounded
transitive upgrades. The initial 3.27.4 fixture resolved conflicting newer menu
peers; aligning the fixture to 3.31.3 removed those peer conflicts.

Use versioned TipTap JSON as canonical local content. Tested schema subset:
document, heading, paragraph, bold, bullet/list-item, code-block, plain text and
an inserted paragraph. LF-04 must test the complete chosen extension schema,
links, undo/redo, paste and hostile/unsupported input. Unknown legacy HTML blocks
must be preserved as sanitized import originals with a visible conversion report;
never silently drop them. LF-08 owns cloud snapshot conversion. Markdown is export,
not canonical live-vault storage. The static concept is not a storage implementation.

The 582 kB renderer fixture bundle warning is visible, not suppressed. LF-03/04
should measure startup and split actual app views as needed. electron-builder
24.13.3 packaged the fixture successfully but has older transitive dependencies;
qualify/update production build tooling in the runtime-integration review instead
of treating this isolated probe as a full dependency-security audit.

## Devices and Models (D-04, D-05, D-06)

Available evidence covers M1, 8 GB, macOS 14.3.1 only. This is an initial test
device, not a declared minimum. Qualify 16 GB for standard local generation and
8 GB separately for a lighter profile. Notebook availability does not depend on
a supported text model. Intel, Windows/Linux capture and other OS releases remain
unqualified. AudioTee's helper is universal, but this fixture app is arm64 only.

Existing source checks Darwin major >=23 while advertising macOS 14.2+, so it
does not exclude 14.0/14.1. LF-05/LF-12 must enforce an exact tested source-specific
OS boundary. Apple speech and Whisper need separate availability/performance
checks, including model/assets installed before disconnecting.

Speech, text generation and embeddings have independent readiness and memory
budgets. LF-09 must pin artifact hashes/licenses/quantization, test real local
runtime behavior, evaluate English/Hindi/mixed inputs, record resource use and
failure states, and preserve local work when no model qualifies. No model was
selected solely from published benchmarks. Embedding candidates and retrieval
evaluation are in SEARCH_RESEARCH.md; extraction gates remain in VALIDATION.md.

## Ordinary Local-Storage Threat Model (D-08)

Ordinary SQLite, media, embeddings and backups are not app-encrypted. FileVault
and OS account permissions are separate OS controls, not a product encryption
guarantee. Use private directory/file permissions; place credentials in platform
secure storage in LF-02. An attacker or another process running as the same user
may read ordinary workspace files. Shared-unlocked devices, malware and physical
access to an unencrypted disk are not solved by local-first storage.

No sign-in, network or telemetry is necessary for canonical local operations.
Embeddings are sensitive, not anonymized. Sync/E2EE and managed encrypted-workspace
requirements are separate LF-14/LF-17 decisions. Avoid network/cloud-drive live
workspaces; LF-01 must implement lock/durability rules and test actual supported
local locations. Do not market enterprise compliance from this baseline.

## Reconsideration Triggers

- Supported Electron branch expires or legacy API regressions appear.
- Native/library signing or clean-machine offline launch fails.
- SQLite vector latency/recall/filtering fails the selected realistic workload.
- A selected embedding runtime/model fails language, memory or distribution gates.
- A named enterprise pilot requires protection beyond ordinary local files.

None requires abandoning SQLite-authored records or silently uploading content.
