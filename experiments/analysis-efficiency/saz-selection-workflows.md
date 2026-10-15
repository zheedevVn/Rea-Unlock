# Fiddler SAZ selection checkpoint

This experiment addresses [#3132](https://github.com/morluto/rea/issues/3132).
Its runtime baseline is `ca1b2f8608c52ed721d3576ba5eeb1d66717b08c`.
Production APIs and defaults are unchanged. The measured cohort establishes no
stable whole-task token/time benefit; no new production preset, cache or API is
justified by this checkpoint.

## Genuine public corpus

Both archives come from Microsoft's
[Xbox Live Trace Analyzer](https://github.com/microsoft/xbox-live-trace-analyzer/tree/ad880ff00b26c4cae5e3c8864d3df438a03890ba/Source/TestData/CertWarnings)
at immutable revision `ad880ff00b26c4cae5e3c8864d3df438a03890ba`.
The repository's [MIT license](https://github.com/microsoft/xbox-live-trace-analyzer/blob/ad880ff00b26c4cae5e3c8864d3df438a03890ba/LICENSE.md)
and original source files remain upstream. No sample binaries, raw HTTP material,
authentication values, configs or detailed results are committed.

| Artifact                 | Archive bytes | Expanded member bytes | Sessions | Members | Producer archive comment |
| ------------------------ | ------------: | --------------------: | -------: | ------: | ------------------------ |
| `xbox-clear_nomp.saz`    |        43,515 |                62,609 |       13 |      42 | Fiddler v4.5.1.2         |
| `xbox-clear_mp_cs10.saz` |     5,223,519 |             9,223,820 |    1,311 |   3,939 | Fiddler v4.6.2.0         |

`corpus.json` pins download URLs, file sizes, SHA-256, Git blob IDs, directory
coverage and question ordinals. Downloaded bytes match their Git blob and
SHA-256. A third public 103-session archive is pinned as an admission-negative
probe, outside completed-question comparisons. Archive comments report their producer
versions; no local Fiddler installation or independent producer-version proof
is claimed.

## Fixed analyst question

Before examining transaction facts, select ordinals `[12, 0, 6]` in the control
and `[1310, 0, 655]` in the larger archive. Return that caller-selected order,
original padded session IDs and archive-member coordinates, request method/URL,
response status/version, all recorded Content-Type pairs in their original
spelling/order, and stored response-body byte length/SHA-256.

Bodies retain their archived encoding. CONNECT trailing bytes are stored data,
not an inferred HTTP application body or certificate interpretation. Empty bodies
have zero bytes and the empty digest; an absent response remains absent. Header
duplication/folding, Latin-1 spelling and binary body bytes are independently
read without REA imports. Synthetic reader tests cover those semantics and
malformed input; they establish no provider coverage.

The oracle admits only immutable corpus size/digest matches before constructing
ZIP objects, preserves central-directory session/member order, reads selected
members with size sentinels and CRC validation, and checks the source digest
again. Necessary facts are independently checked for all six selected records.

```sh
python3 experiments/analysis-efficiency/test_saz_oracle.py
python3 experiments/analysis-efficiency/saz-oracle.py xbox-clear_nomp.saz /absolute/clear_nomp.saz
python3 experiments/analysis-efficiency/saz-oracle.py xbox-clear_mp_cs10.saz /absolute/clear_mp_cs10.saz
```

The baseline build, five oracle regressions and the SDK checker semantics passed
on Linux. Real MCP preflight checks verify control retained pages/repeated reads,
the large ordinal-selected result, and large complete-workflow recovery. The
default large MCP return completes analysis but exceeds the existing 10 MiB stdio
receive-buffer budget; its exact returned retained Evidence reference supports
summary and complete pages. Recovery preserves the failed RPC and every follow-up
call, and matches the independently checked necessary facts from direct selection.
This transport limit is not a decoding timeout. Formal repetitions and actual
model tasks are reported below; preflight observations are not eligible cost pairs.

The 103-session `xbox-x49_mp_cs21.saz` candidate contains an empty stored response
member `raw/099_s.txt`, lacking an HTTP header/body separator. On this baseline,
whole-capture admission fails with `invalid_request` / `invalid_format`. Its
ordinals `[102, 0, 51]` were fixed before inspecting its transaction facts. The
failed attempt/source member is preserved as a negative probe; no parser repair
or successful-task comparison is claimed for that archive.

Other platform behavior remains unverified.
Detailed outputs stay private; missing resource counters remain unknown.

The large selected CLI workflow also matches independent bytes and MCP facts,
parameters and Evidence ID. A separate default complete CLI attempt hit the
provider's 30-second timeout under the one-CPU guard; that failed attempt is
preserved separately from the successful-analysis MCP receive-buffer failure.
It does not prove a general CLI failure or identify an engine-stage cause.

Ten grading preflight cases cover valid actual Evidence, wrong final digests,
unknown citations, missing limitations, answer order, failed calls before/after
valid data, semantic-ID corruption and actual large retained recovery. Their
answers/events are injected checker tests, not actual model trials. An invalid
later duplicate is rejected by the domain's semantic-ID owner and does not erase
earlier authenticated observations.

## SDK and model reproduction

```sh
node experiments/analysis-efficiency/measure.mjs \
  --runtime-root /absolute/frozen-runtime --revision ca1b2f8608c52ed721d3576ba5eeb1d66717b08c \
  --artifact xbox-clear_nomp.saz --path /absolute/clear_nomp.saz \
  --output /absolute/new-result-dir --schemas selected --saz-selection focused
node experiments/analysis-efficiency/saz-model-prompt.mjs \
  --artifact xbox-clear_nomp.saz --selection focused > /absolute/prompt.txt
```

Use the same runtime, inputs, explicit provider settings and resource profile
within a cost cohort; retain runtime/workflow/oracle/settings fingerprints. Repeat
both core archives with baseline/focused/focused/baseline order and retain all
failures/recovery RPCs. The `retained` diagnostic workflow also measures preview,
two complete pages and a repeated first page. Preview omits headers, so preview
alone is not equivalent to the complete header/body question.

Run real Codex tasks through `agent-trial.py` with an isolated temporary profile,
the two exact `inspect_web_network_capture` / `inspect_analysis_view` tools,
the same requested model/reasoning and at least two baseline/focused pairs for
the control. Grade cited observations with `review-saz.mjs`, an independently
produced oracle and the tested runtime. Count whole-task input/output tokens,
cached input, elapsed time and all calls; parsed JSON bytes are not model tokens.
The executed scope and all failed/deviating trials follow below.

## Executed SDK cohort

Runtime is frozen at `ca1b2f8608c52ed721d3576ba5eeb1d66717b08c`; corrected
experiment source is `286c3e48ad50d9e84baa3af00ca522a8cef36e95`. All corrected
SDK runtime/workflow/oracle/provider-setting fingerprints match. Node is 24.18.0
and MCP SDK is 2.3.1. SDK processes have a 1 GiB Node heap ceiling; model MCP
profiles separately record 512 MiB. Compare within each cohort.

The initial batch preserves 12 workflows / 36 RPCs. Two control baseline collectors
incorrectly expected omitted request ordinals to remain omitted in Evidence;
the owning application records the resolved full scope. Original RPC arguments
preserve omission. Both saved replies independently validate correct typed
Evidence/facts after the checker correction. Original failures, hashes and costs
remain unchanged and are not pooled into the corrected batch.

The corrected batch executes 12 workflows / 32 RPCs: **11 workflows pass** all necessary
byte/header/member checks with equal facts across successful arms. One large
default complete query hits `provider_timeout` at the 30-second provider budget.
Failed complete-return RPCs in successful retained recovery also stay in cost.

| Archive / workflow | Repetition outcomes | All parsed reply bytes | RPC ms                | Whole runner ms       |
| ------------------ | ------------------- | ---------------------: | --------------------- | --------------------- |
| control / baseline | passed / passed     |        249272 / 249272 | 817.904 / 817.032     | 5393.982 / 4922.524   |
| control / focused  | passed / passed     |          65390 / 65390 | 805.492 / 835.598     | 4897.670 / 4924.772   |
| control / retained | passed / passed     |        146981 / 146981 | 1846.344 / 8258.135   | 5861.567 / 18108.568  |
| large / baseline   | failed / passed     |           520 / 114294 | 32303.203 / 13623.033 | 52432.342 / 18064.360 |
| large / focused    | passed / passed     |        535767 / 535767 | 32917.417 / 23536.051 | 52933.865 / 37045.394 |
| large / retained   | passed / passed     |        174477 / 174477 | 10970.973 / 11550.158 | 15140.224 / 15669.775 |

Control direct selection reduces parsed replies **73.8%**. Large complete-result
recovery delivers 114,294 bytes, while direct ordinal selection retains the original
container inventory and delivers 535,767 bytes. The five-call retained diagnostic
delivers 174,477 bytes, including preview and repeated-page verification. A smaller
record set alone does not guarantee less delivery; bytes are not wire bytes or
model tokens.

Initial RPCs combine decoding, validation, canonicalization and delivery; no
decode-only/format-only attribution is claimed. First-use and repeated retained
reads remain separate RPC observations. Fresh client/server processes do not
establish cold OS/provider caches. Substantial time variation precludes a stable
general speedup claim.

## Actual Codex outcomes

Four actual Codex CLI 0.161.0 trials request `gpt-5.6-terra`/`high` with the same
two enabled/preapproved passive tools in baseline/focused/focused/baseline order.
The requested alias is pinned; resolved backend identity is unknown. Temporary
profiles preserve original bytes. The requested mode is `direct`, but owned
tool-context logs show actual `exec` discovery/dispatch; neither guaranteed direct
presentation nor exact submitted model requests are established.

| Trial      | Facts / fixed plan | MCP calls | Total input | Cached input | Uncached input, derived | Output | Seconds |
| ---------- | ------------------ | --------: | ----------: | -----------: | ----------------------: | -----: | ------: |
| baseline-1 | passed / failed    |         4 |      97,988 |       53,504 |                  44,484 |  1,556 |  51.266 |
| focused-1  | passed / failed    |         2 |      96,433 |       51,456 |                  44,977 |  1,400 |  52.288 |
| focused-2  | failed / failed    |         0 |      21,379 |        9,984 |                  11,395 |    317 |  16.301 |
| baseline-2 | passed / failed    |         4 |     172,043 |      125,696 |                  46,347 |  1,943 |  62.570 |

**Three of four tasks answer correctly.** All three add compatible retained-view
calls and differ from the initially prescribed single MCP-call plan. These
successful completed-task costs stay visible separately from plan conformance.
Baselines read three exact record views; the successful focus reads one complete
selected-parent page.

The second focus makes zero MCP calls and reports unavailable tools. Its owned
exact-name discovery returns an empty list, while the same names work in other
trials; stderr is empty. The cause is unknown, not proof of a REA outage. Keep
its 21,379 input tokens / 16.301 seconds as a failed task, without a replacement retry
or an apparent speed win.

Only the first pair completes both questions: total input decreases **1.6%**,
time increases **2.0%**, and derived uncached input increases **1.1%**. The second
pair has no completed focused question; no paired speed/token claim is valid.
Limitation prose was inspected: successful answers qualify stored bytes,
ZIP-directory order and absent transfer/content decoding. This small mixed cohort
justifies **no production optimization**.

## Resource and compatibility scope

Heavy work is serial with one CPU, 3 GiB early stop / 4 GiB hard family memory, no swap,
task ceilings and host-availability/ownership checks. Corrected SDK payload-exit
peak is 906,825,728 bytes (**865 MiB**); model peak is 873,148,416 bytes (**833 MiB**).
All 16 corrected SDK/model payload phases verify cleanup, no observed OOM/abort
and captured CPU counters. Terminal whole-scope counters remain unknown. Failed
tool/model tasks do not become correct because their process exits cleanly.

Family CPU seconds at payload exit span 5.898–44.331 for corrected SDK workflows
(median 15.808), including failed/recovered attempts. Model baseline/focus/focus/
baseline observations are 7.573 / 7.303 / 5.810 / 7.618 CPU seconds; the third
model task failed and cannot establish an efficiency gain. These counters include
the owned runner/client/server/observer family, not decoder-only CPU.

Verification covers Linux, two immutable positive archives plus one genuine
partial-message negative source, one installed parser stack and one requested
model alias. Other platforms, Fiddler acquisition/import, live deployment or
certificate semantics, arbitrary layouts, direct presentation guarantees and
unmeasured engine stages remain unknown. Complete defaults, caller choices,
encoded bytes, redactions, semantic Evidence identity and session-owned views
remain the compatibility baseline. Reuse existing selectors/views; expand
SDK/cache/default behavior only after completed tasks show a benefit.
