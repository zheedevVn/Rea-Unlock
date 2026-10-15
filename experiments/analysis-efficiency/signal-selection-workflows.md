# Sigrok selection and repeated-page checkpoint (#3131)

This experiment preserves production APIs, defaults, caller selections and Evidence
semantics. Existing annotation selectors substantially reduce replies, but this
small real-model cohort does **not** establish a consistent reduction in total
input tokens or elapsed task time. No decoder cache or new production preset is
introduced. Complete necessary output stays available through existing explicit
null limits; original defaults remain 50 display lines.

## Immutable corpus and independent questions

The runtime is pinned to `ca7450beffff59325ce3bddc78e181693ce77177`, with Node
24.18.0, SDK 2.3.1 and Linux x86-64. Experiment driver code for model trials is
`23317a58d`; each SDK result separately records workflow/oracle source hashes,
runtime-file and lockfile digests, explicit provider settings and original bytes.
Later integration checks must remain separate from this cohort.

Two official sigrok-dumps recordings are pinned to upstream commit
`0ad13477abc959d37fc9a5acbd23901c371c9c76` in [corpus.json](corpus.json).
Original Git blob IDs, SHA-256, sizes and immutable reference/download URLs are
recorded there. No sample binaries or raw output are committed. The upstream
repository declares dumps public domain unless otherwise noted; the inspected
sample READMEs state no exception. Decoder software licensing is separate.

- MAX3232E UART: 12,742 compressed bytes, 10,000,000 logic bytes, 5,000,000 samples
  at the recorded nominal 100 MHz. Stored DOUT1 is bit 1; DIN1 is bit 2. The exact
  question requests all RX octets in order, including repetitions. Independent
  57,600-baud 8N1 stop-bit sampling with DOUT1 inversion yields 65 bytes: five
  copies of `Hello world\r\n`. The source metadata and physical probe numbers
  remain distinct from stored bit positions.
- Wii Nunchuk I2C: 20,373 compressed bytes, 20,000,000 samples at nominal 1 MHz.
  The source README's physical probes 3/7 are repacked as stored named channels
  SCL/SDA at bits 0/1. The question asks every read payload as consecutive
  six-byte arrays, excluding address/write bytes and hardware/button inference.
  Independent START/STOP, rising-clock, byte and ACK/NACK reading identifies seven
  transactions and three read payloads, matching the upstream reference:
  `75 7F 77 4F 82 3B`, `75 7F 75 44 82 34`, `75 7F 77 43 83 5D`.

The independent reader accepts the scoped single-device classic-ZIP profile,
checks directory representation before object allocation, bounds compressed and
expanded input to 32 MiB, and limits selected transitions to 65,536. It preserves
source metadata/digest, chunk ordering and channel identity; incomplete samples,
ambiguous names, partial bytes and unsupported transactions fail explicitly.
Receiver rearming follows the verified UART stop sample, accommodating the
recording's slightly faster sender. I2C STOP preparation is distinct from data.
These checks do not establish other formats, decoders, OSes or physical acquisition.

An initial DOUT1 decode without inversion exited successfully but produced wrong
bytes. Its cost/output is retained privately as configuration exploration, outside
eligible measurements. An independent sample oracle prevents equal-but-wrong
producer results from passing. Correct inversion was established before the cohort.

## Actual CLI and SDK evidence

sigrok-cli 0.7.2 reports libsigrok 0.5.2 and libsigrokdecode 0.5.3. Its executable
SHA-256 is `e1b1eb2f25edc17d24a78acbab16ff7e1dfdee74bb2cccb7ad00497ccc7a0c44`.
Selected installed UART/I2C decoder module bytes are fingerprinted privately.
The banner and executable digest do not fingerprint the complete installation;
modules and libraries remain trusted. Both actual CLI and MCP results match raw
sample bytes; data intervals correlate with the independently examined samples.

Fourteen actual SDK workflows comprise two interleaved repetitions per recording
and arm (baseline/focused/discovery), plus first/next/repeated pages. All 22 calls
preserve source bytes and necessary decoded facts. Baseline returns all necessary
annotation output. Focused selects `uart=rx-data` or `i2c=data-read`, with explicit
null line limits because the task needs the entire selected payload. Discovery
first queries the installed decoder help for the already specified class; it does
not establish discovery benefits for unknown protocols.

| Recording | Baseline bytes | Focused bytes | Discovery + focused bytes | First + next + repeat bytes |
| --------- | -------------: | ------------: | ------------------------: | --------------------------: |
| UART      |         49,417 |        12,441 |                    18,839 |                      31,779 |
| I2C       |         26,829 |         9,928 |                    16,274 |                      27,623 |

Focused reply reductions are 74.8% and 63.0%. These are parsed SDK JSON bytes,
not wire bytes or model tokens. Baseline/focused RPC times (ms, repetitions 1/2)
are UART 2010/582 versus 1459/911, and I2C 2851/676 versus 2330/685; n=2,
with order/cold/warm variation, does not establish a general speedup. Pages retain
input/class/window coverage separately, rather than equating display exhaustion
with a complete protocol decode. Repeated first pages match their original text
and scope; reused content-based Evidence identities are valid.

## Complete real-model task costs

Eight actual Codex CLI 0.161.0 tasks requested `gpt-5.6-terra` / `high`, in isolated
profiles using this runtime's REA MCP. Both tools were enabled and preapproved
identically in all arms; shell, browser and extra agents were disabled. The model
alias is a requested identifier, not independently resolved backend identity.
Questions contain no expected payloads. Trial order is baseline 1, focused 1,
focused 2, baseline 2, with UART then I2C in each step.

| Trial           | Total input | Cached input | Uncached input (derived) | Output | Seconds | Completed tool calls | Facts / fixed plan |
| --------------- | ----------: | -----------: | -----------------------: | -----: | ------: | -------------------: | ------------------ |
| uart baseline 1 |      92,399 |       49,408 |                   42,991 |  1,295 |  86.411 |                    1 | passed / passed    |
| uart focused 1  |     130,029 |       98,048 |                   31,981 |    780 |  49.623 |                    1 | passed / passed    |
| uart focused 2  |      98,894 |       78,592 |                   20,302 |    878 |  73.861 |                    1 | passed / passed    |
| uart baseline 2 |      90,395 |       48,384 |                   42,011 |    926 |  43.974 |                    1 | passed / passed    |
| i2c baseline 1  |     172,162 |      121,344 |                   50,818 |  1,194 |  36.330 |                    2 | passed / failed    |
| i2c focused 1   |      74,815 |       49,408 |                   25,407 |    937 | 114.515 |                    1 | passed / passed    |
| i2c focused 2   |      74,684 |       48,384 |                   26,300 |    668 |  73.877 |                    1 | passed / passed    |
| i2c baseline 2  |      86,241 |       49,408 |                   36,833 |    778 |  41.084 |                    1 | passed / passed    |

All eight answers match independent raw samples and cite authenticated decoder
observations. I2C baseline 1 also queried generic MCP resources before its single
required decode. The predeclared strict single-call grader marks its plan failed;
its actual 172,162 input tokens and 36.330 seconds remain recorded, separately
from the eligible fixed-plan pairs. It is not retried into a better result.

UART eligible pairs increase total input by 40.7% and 9.4%; elapsed changes are
-42.6% and +68.0%. The one eligible I2C pair reduces total input by 13.4% but
increases elapsed time by 79.8%. Reduced uncached input does not replace total
input as the primary token measure. No reliable whole-task token/time benefit is
established across these two questions; reply projection alone is insufficient.

## Producer, window and resource scope

Eight separately bounded direct producer runs preserve source bytes and render
correct stdout: UART baseline 159/131 ms versus focused 163/130 ms; I2C baseline
355/298 ms versus focused 317/290 ms. This isolates the producer process from REA
RPC, version probing and snapshot work, but startup/decoding/annotation formatting
remain combined. Decoding-only versus formatting-only time is unmeasured.

REA literal-window extraction and JSON encoding were measured separately from
retained producer text (one cold observation and 200 warm iterations per arm).
Warm mean extraction ranges from 0.0040 to 0.1794 ms; JSON encoding from 0.0021 to 0.0121 ms. These exclude file reads, RPC and decoding.

Every page still invokes decoding. Retained output might help repeated inspection,
but this fixed cohort does not demonstrate a completed-task improvement warranting
a new cache. Any future work should own bounded output explicitly by original
Evidence identity and lifetime, with cancellation/cleanup, rather than use a
CLI-digest-only generic cache of an incompletely fingerprinted installation.

Heavy work ran serially under one CPU, 3 GiB early stop / 4 GiB hard memory,
no swap and host-availability checks. Verified payload-exit peak bytes were
SDK 587,513,856; model 889,323,520; direct producer 26,288,128. No OOM/OOM-kill or resource abort occurred in that verified phase; task descendants
were cleaned. Terminal whole-scope counters are unavailable and remain unknown.

## Verification and replay

Eleven independent-oracle regressions and 12 comparator/sample-interval tests pass.
Twenty-four private replays using actual SDK Evidence cover valid answers, failed
calls before/after recovery, wrong bytes, unknown citations and missing limitations.
These are grading checks with injected state, not additional model/provider trials.
The grader retains authenticated observations by identity, rejects conflicts,
combines cited pages in sample order and keeps failed calls/plan deviations separate
from supported facts. Relevant typecheck/lint and pre-push checks pass.

Review hardening ties the oracle to the named corpus digest, bounds each I2C
interval against neighboring byte clocks/transaction STOP, and counts actual
classic-ZIP directory records on the same bounded snapshot before allocating
`ZipFile` objects; ZIP64 is rejected. Forged-count and ZIP64 admission regressions
fail on the original implementation. Replaying all eight original model trials
and 24 injected grading cases with these checks preserves their factual/plan
grades and recorded usage/time; these replays are not new model measurements.

Metadata reads cap inflater output even when ZIP sizes are forged. A streamed
8 MiB malformed metadata member declaring 8 KiB is rejected with traced Python
allocation below 1 MiB; the same regression fails on the preceding implementation.
Compressed snapshots use actual file size plus one growth-detection byte rather
than preallocating the entire admission budget. Both genuine waveform oracles
retain identical bytes, metadata, sample intervals and source digests.

UART interval checks also require coverage of the first and last independently
sampled data-bit centers within the owning frame. Shortened, shifted and
single-sample intervals are rejected even when the decoded byte is correct.
The added oracle coordinates retain the original byte/frame facts; replaying
saved real Evidence and all eight model transcripts preserves the original
grades and costs. This is stronger retrospective verification, not a new cohort.

After rebasing onto main `44d98de2367b99808d78db732ec7d72533266233`,
`npm run build:cached` and the 16 focused comparator/sample-interval/MCP-boundary
tests passed. Two additional real focused MCP workflows independently verified
UART/I2C bytes and intervals on that base. These integration checks are separate
from the original cost cohort and do not replace or extend its measurements.

A subsequent rebase onto main `3b79af28e80785afce9f5998d8f03289402a1847`
passed the 17 focused tests, including the upstream-fixed Hopper doctor case,
and two additional real UART/I2C MCP workflows. Original cohort costs and grades
remain unchanged; these checks verify integration on the updated main only.

Use `measure.mjs --signal-selection baseline|focused|discovery|pages`, preserving
runtime/source fingerprints and explicit provider JSON. Generate the exact task
with `signal-model-prompt.mjs --artifact ID --selection baseline|focused`, run the
isolated `agent-trial.py --mode direct --capture-tool-context`, and grade with
`review-signal.mjs` and the independently produced oracle. Keep original failures,
resources and raw observations private. For migration, existing optional annotation
selection is sufficient for scoped reply reduction; no default/API change follows
from this mixed whole-task result.
