# Local Semantic and Contextual Search

Researched 2026-09-10. Decision proposal plus a completed LF-00 compatibility spike,
not a claim that production AI search exists.

## Recommendation

Keep SQLite for durable notes, transcripts, recordings and actions. Use FTS5 for
lexical search, a local embedding model plus `sqlite-vec` for semantic candidates,
and deterministic SQL for structured questions. Combine those in a scoped hybrid
retrieval service. A separate vector database server is not necessary for the
initial desktop workload.

The earlier plan under-specified this: embeddings were an optional future
addition. Contract v2 now requires qualified hybrid retrieval for the complete
local AI milestone. Writing, capture and lexical search still work without any
model. A user can search semantically without loading the larger answer-generation
model; generated Ask is a separate capability.

## Three Different Capabilities

| Capability | Example | Required mechanism |
| --- | --- | --- |
| Lexical | Find `ACME-1042` or an exact person's name | FTS5/title matching; preserve exact identifiers |
| Semantic | Find the conversation about reducing costs, even when it says "cut infrastructure spending" | Embed query and source passages with the same local model, then vector similarity |
| Contextual | What did we decide for this client last month, and what remains unfinished? | Explicit client/date scope, hybrid passage retrieval, current structured actions, source citations; optional generated answer |

SQLite does not generate embeddings or reason about documents by itself. FTS5
provides token/phrase/prefix search and BM25 ranking, not a semantic model.
[SQLite FTS5 documentation](https://sqlite.org/fts5.html)

Similarity is not factual truth, identity, chronology or a complete task list.
"All overdue commitments" must query canonical action status/owner/due fields.
Do not ask an LLM to infer completion from an old transcript when the user has
already marked the action done. Do not answer workspace-wide counts from top-k
retrieved passages. Natural-language filter interpretation must validate against
allowed fields and show ambiguity; it cannot emit arbitrary executable SQL.

## Database Options

| Option | Verified facts | Decision for FocusBae |
| --- | --- | --- |
| SQLite FTS5 | Local full-text indexing and BM25 | Required baseline; insufficient alone for paraphrase retrieval |
| SQLite + `sqlite-vec` | C extension, JS binding compatible with better-sqlite3, float/int8/binary vectors, metadata filtering; pre-v1 | First candidate; exact-pin stable release, isolate derived index, test packaging and deletion |
| SQLite project's `vec1` | Portable C, L2/cosine, exhaustive and ANN modes; current docs describe v0.7 and explicitly say testing is insufficient | Watch and benchmark later; not the first shipping dependency |
| SQLite AI's `sqlite-vector` | Ordinary-table vector operations and quantized scans; its published license has commercial-production conditions | Not the default; requires license/procurement review as well as technical tests |
| Embedded LanceDB | Local embedded operation and hybrid FTS/vector search with rank fusion | Plausible fallback if measured SQLite vector scale/latency is inadequate; adds another storage format and backup/recovery lifecycle |
| `sqlite-vss` | Maintainer says it is no longer in active development and points to sqlite-vec | Do not start new work on it |

Primary sources: [sqlite-vec project](https://github.com/asg017/sqlite-vec),
[JavaScript binding](https://alexgarcia.xyz/sqlite-vec/js.html),
[vec1 overview](https://sqlite.org/vec1/doc/trunk/doc/vec1.md),
[vec1 manual](https://sqlite.org/vec1/doc/trunk/doc/vec1intro.md),
[sqlite-vector project](https://github.com/sqliteai/sqlite-vector),
[its license](https://github.com/sqliteai/sqlite-vector/blob/main/LICENSE.md),
[LanceDB local quickstart](https://docs.lancedb.com/quickstart),
[LanceDB hybrid search](https://docs.lancedb.com/search/hybrid-search),
[sqlite-vss maintenance notice](https://github.com/asg017/sqlite-vss).

### Important sqlite-vec Limits

The registry's stable version is 0.1.9; 0.1.10-alpha.4 is an alpha channel on this
research date. Stable 0.1.9 is the qualification target. Do not silently follow
alpha docs/examples into a production lockfile. The 0.1.9 release fixes deletion
with long text metadata; include that regression in our probe. Its successor's
ANN work is pre-release, so start with exact KNN and measure before adopting ANN.
[Maintainer releases](https://github.com/asg017/sqlite-vec/releases)

Metadata filtering must happen before top-k selection. Querying the global nearest
10 and then discarding other projects can miss all relevant in-scope documents.
The extension supports metadata constraints, but does not accept arbitrary SQL
operators in KNN metadata filters. Complex restrictions need a proven filtered
query path, potentially an exact scan over the eligible set; never silently drop
a filter. Avoid partitioning every tiny note into its own index shard.
[Metadata/partition documentation](https://alexgarcia.xyz/sqlite-vec/features/vec0.html),
[KNN/scalar alternatives](https://alexgarcia.xyz/sqlite-vec/features/knn.html)

## Architecture

```text
workspace.sqlite                  Managed source files
  notes / transcripts / actions   retained audio / attachments
  revisions / durable jobs
  transactional lexical FTS
           |
           | revision-specific indexing jobs
           v
  local embedding worker <--- verified local embedding model
           |
           v
  search.sqlite (per workspace, derived and rebuildable)
    chunk map / embedding profile / index generation / vectors

Query + explicit workspace/project/date scope
           |
     +-----+-----------------+
     |                       |
  FTS candidates       Local query embedding -> vector candidates
     +-----------+-----------+
                 |
        rank fusion + structured action queries
                 |
        canonical revision/delete/scope validation
                 |
        results with source excerpts and timestamps
                 |
        optional local generated answer with citations
```

This is an engineering recommendation, not a claim that one database topology is
universally fastest. Separating the derived vector database limits the impact of
a pre-v1 extension or index migration: a missing/corrupt extension cannot block
opening the notebook. Index loss costs reindexing time, not authored content.

### Indexing Rules

1. Commit the original and its indexing job locally before acknowledging save.
   Inference never runs in a save transaction. FTS remains immediately available.
2. Chunk normalized note text along paragraph/heading boundaries and transcripts
   along sentence/turn boundaries. Initial experiment: 250-400 model tokens with
   limited overlap, bounded below each model's input limit including prefixes.
   Preserve source IDs, revisions and timestamp/offset ranges for every chunk.
3. Store the embedding profile: exact model hash, tokenizer, pooling, normalization,
   query/document instructions, vector dimensions/quantization and chunker version.
   A new profile requires new vectors, even if it has the same dimensions.
4. Bound background indexing CPU/memory. Recording and interactive writing outrank
   indexing. Support cancel, resume, disk-full and missing-model states. Show actual
   index coverage rather than claiming partially indexed work is complete.
5. Revalidate results against current canonical content before returning them.
   Editing/deleting a source invalidates old hits immediately. Jobs for older
   revisions cannot overwrite a newer cache entry.
6. Rebuild into a new generation and switch atomically; budget temporary doubled
   index space. Read-only source recovery and lexical search stay available during
   vector failure/rebuild. Only the search worker owns its SQLite connection.
7. Keep embeddings local and out of sync by default. Backups either include a
   versioned compatible cache or explicitly omit it as rebuildable. Source data,
   not a model's summaries, remains authoritative.

### Query Rules

- Use FTS/BM25 and semantic candidates, initially 40 from each within scope. Fuse
  ranks (RRF is a starting candidate), deduplicate overlapping chunks and cap
  contribution per source so one long recording cannot consume the entire answer.
  Do not directly add BM25 and cosine numbers. Tune on a held-out corpus.
- Preserve exact-name/identifier matches. Return dates and source excerpts.
- Fetch neighboring transcript turns after selecting a passage, bounded by the
  generation context budget; one sentence may omit who agreed or negated a claim.
- Use current action records for due/status/owner facts. Resolve project/person
  references only through explicit associations or reviewed links.
- Optional reranking must improve measured relevance within the latency/memory
  budget. It is not a prerequisite for first hybrid search.
- No supported evidence means no generated factual answer. A cosine threshold
  alone does not prove evidence; evaluate relevance and answerability separately.
- A retrieved instruction cannot run a tool or change scope, consent or policy.

## Local Embedding Model Candidates

These are qualification candidates, not selected production artifacts. No model
weights have been downloaded or evaluated by this research. Use model-owner
artifacts/conversions with pinned hashes and inspect redistribution terms.

| Candidate | Published properties | Why evaluate / caveat |
| --- | --- | --- |
| `intfloat/multilingual-e5-small` | 384-dimensional, multilingual including Hindi, 512-token limit, MIT-labeled model card; query/passage prefixes matter | Lightweight reference profile; evaluate an appropriate local runtime and transcript/code-mixed quality |
| `Qwen/Qwen3-Embedding-0.6B` | 0.6B parameters, 100+ languages, up to 1024 dimensions with configurable output, 32K context, Apache-2.0-labeled card | Main comparison for multilingual retrieval/instruction use; model size is not runtime RAM; qualify exact quantization/pooling |
| `google/embeddinggemma-300m` | Google positions this as a small multilingual on-device embedding model | Alternative edge profile; distribution/access terms and runtime integration need review before account-free provisioning |

Primary sources: [E5 model card](https://huggingface.co/intfloat/multilingual-e5-small),
[Qwen model card](https://huggingface.co/Qwen/Qwen3-Embedding-0.6B),
[Google model overview](https://ai.google.dev/gemma/docs/embeddinggemma).

Do not choose an English-only embedding model for a Hindi/mixed-language product
without an explicit restricted-language decision. Published multilingual support
is not evidence of reliable Hindi-English code switching, Romanized Hindi, names,
dates or ASR errors in our material. Test those slices separately.

Speech recognition, embeddings and answer generation are distinct model roles.
Do not assume the Whisper model or the chat model is a suitable embedding encoder.
Prefer the already-qualified runtime where model support matches; compare an ONNX
worker only if the small encoder materially improves quality/latency. All model
files, tokenizers and runtime assets must be available locally; no automatic
remote embedding API or first-query model fetch.

## Capacity and Measurement

### Current Compatibility Evidence

The isolated development and unsigned packaged Electron 43.7.0 probes passed on
the M1/8 GB device with better-sqlite3 13.0.3 and sqlite-vec 0.1.9: vector loading,
cosine KNN, metadata filtering, wrong-dimension rejection, deletion/rollback and
active-WAL backup/reopen. A 10k x 384-dimensional synthetic-vector test measured
warm lookup p95 of 9.86 ms in development and 6.30 ms packaged. This excludes query
embedding, real relevance, cold-cache and concurrency; it does not establish
semantic search quality or end-to-end latency. Full evidence

### Storage Sizing

Raw float32 storage is `chunks * dimensions * 4` bytes. Calculated examples:

| Chunks | 384 dimensions | 1024 dimensions |
| --- | --- | --- |
| 10,000 | 15.36 MB | 40.96 MB |
| 100,000 | 153.6 MB | 409.6 MB |
| 1,000,000 | 1.536 GB | 4.096 GB |

These are decimal raw-vector sizes, not total index size or RAM. Add chunk text,
metadata, index overhead, database pages, WAL and temporary rebuild space. Ten
thousand notes may mean substantially more than ten thousand chunks. Embedding
model memory is separate. Quantization reduces storage but must pass retrieval
quality tests; never assume a smaller vector is free of accuracy loss.

The available machine is an M1/8 GB/macOS 14.3.1. Measure 10k, 100k and eventually
1m chunks with selected model dimensions, selective project/date filters, edits,
deletes, warm/cold runs and concurrent recording. Adopt ANN or LanceDB only when
the target workload fails a measured budget and the alternative meets recall,
filtering, recovery and packaging requirements.

### Proposed Gates, Not Measured Results

- Keep the existing FTS p95 target below 300 ms on the qualified corpus/device.
- Initial warm semantic-search p95 target: <=1 second, including query embedding,
  filtering and fusion, excluding generated prose. Record cold model-load time
  separately; do not hide it in an index-only benchmark.
- Build at least 120 manually labeled retrieval queries across exact entities,
  paraphrases, project/date constraints, action state, contradictions and
  unanswerable questions. Include English, Hindi and mixed/Romanized slices, with
  realistic ASR mistakes and a held-out subset not used for tuning.
- Compare FTS-only, vector-only and hybrid Recall@10/nDCG@10. Initial acceptance
  proposal: hybrid improves paraphrase Recall@10 by >=10 percentage points over
  FTS, with no >2-point regression on the exact-identifier slice. Publish sample
  counts and uncertainty; product owner confirms thresholds before final eval.
- Require zero cross-workspace/deleted-source results in adversarial fixtures;
  current structured action queries must remain correct regardless of embeddings.
- Test profile changes, corrupt/missing models/extensions, restart midway through
  indexing, stale jobs, backup/restore, cancellation, low disk, unsupported filters
  and missing-model lexical fallback. Verify no process sends content outbound.

## Work Package Changes

- LF-00: qualify SQLite + stable sqlite-vec loading, numeric KNN/filter/delete,
  WAL backup and packaged assets. This is compatibility evidence only.
- LF-01: durable canonical records, revisions/hashes and indexing jobs; no vector
  dependency on the critical save/open path.
- LF-04: usable lexical search, exact matches and source navigation.
- LF-09: separate embedding-model/runtime qualification and readiness states.
- LF-11a: local indexing, semantic/hybrid results, filters, index lifecycle and
  held-out retrieval evaluation. Can proceed after LF-09 embedding subgate.
- LF-11b: generated contextual Ask/preparation with current actions and citations.
- LF-12: signed packaged offline/model/network/recovery gates, not merely a fast
  SQL benchmark. Full AI search is not ready until VAL-24 passes.

Budget an additional 1-2 focused engineering weeks for embedding/index lifecycle,
fusion and retrieval evaluation after the durable storage/model infrastructure;
this is a planning estimate, not a delivery commitment. Real model/hardware tests
may change the architecture or estimate. See the LF-00 evidence for commands and
the exact verified/unverified boundary of the current spike.
