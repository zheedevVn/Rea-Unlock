# Larger and non-HTTP packet investigation costs

This closes the bounded experiment in [#3130](https://github.com/morluto/rea/issues/3130).
Existing field, filter and input/output-window controls substantially reduce
delivered JSON for the selected questions. Actual Codex total input and elapsed
time are less consistent. Requiring field discovery for a known field adds cost.
These results support documenting caller-selected controls, while retaining the
current API, defaults and uncached provider behavior.

## Runtime and public corpus

Measurements use immutable main
`ec67aebed02dbd20fa5c7703fcd183ad0b1c343c`, Node 24.18.0, the locked MCP client and
server, Linux, TShark/capinfos 4.0.17 and util-linux prlimit. The SDK captures live
advertised contracts and passes selected definitions to actual public MCP calls.
Runtime-file, dispatcher, lockfile, experiment-source and explicit provider
configuration digests remain with the private trial records. Subsequent main
integration checks do not relabel these measurements.

Three additional saved recordings come from the
[official Wireshark catalogue](https://wiki.wireshark.org/SampleCaptures).
`corpus.json` pins their acquisition URLs, exact bytes and SHA-256 values.
The PostgreSQL recording is described upstream as a JDBC test session; it is
not a representative production workload. Capture-specific licenses were not
stated in the inspected catalogue. No captures or raw trial records are
redistributed in Git.

| Recording            |                        Acquired/analyzed size | Recorded frames | Fixed question                                                                                                                                         |
| -------------------- | --------------------------------------------: | --------------: | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `pgsql-jdbc.pcap.gz` | 590,093 compressed / 4,906,316 expanded bytes |          18,472 | Within original frames 1–2,000, report the first twelve TCP packets using port 5432, their source/destination ports and flags, and the matching count. |
| `dns.cap`            |                                   4,338 bytes |              38 | Report nonzero-RCODE DNS responses, transaction IDs and question names/types.                                                                          |
| `dhcp.pcap`          |                                   1,400 bytes |               4 | Report message types, transaction IDs, offered address and present server identifiers in frame order.                                                  |

The larger application recording and two small non-HTTP controls expand the
question/protocol coverage. Large DNS/DHCP, PCAPNG non-HTTP, USB, Bluetooth,
Windows and macOS provider performance remain unverified.

`packet-oracle.py` independently reads classic PCAP, Ethernet/IPv4 and selected
TCP/UDP headers. It does not consume TShark output. Its narrow supported scope
fails on truncation, IP fragmentation, DNS compression cycles, duplicate DHCP
options or DHCP overload. TCP header facts follow
[RFC 9293](https://www.rfc-editor.org/rfc/rfc9293.html), DNS names/header fields
[RFC 1035](https://www.rfc-editor.org/rfc/rfc1035.html), and DHCP options
[RFC 2132](https://www.rfc-editor.org/rfc/rfc2132.html).
SQL interpretation, TCP reassembly and network completeness are outside the
oracle. The question and oracle were fixed before measured cohorts.

The oracle establishes 1,337 selected PostgreSQL TCP packets in the input prefix
and six DNS error responses. DHCP records contain Discover/Offer with transaction
ID 15645 and Request/ACK with ID 15646. An absent server identifier stays omitted;
the recording does not establish a single transaction containing all four steps.

## Equivalent questions and SDK measurements

Each arm uses fresh actual MCP sessions; heavy trials run sequentially.
Two interleaved repetitions cover each arm and each recording. Discovery, catalog,
RPC, schema checking, encoding and cleanup costs are retained. JSON bytes describe
serialized SDK replies, not raw transport bytes or model tokens.

The PostgreSQL baseline selects `tcp.srcport`, `tcp.dstport`, `tcp.flags` and
`tcp.len`, retains the default fifty-row output window and reads to EOF with
`tcp.port == 5432 && frame.number <= 2000`. The focused arm selects the three
required fields, uses `packet_limit: 2000`, filter `tcp.port == 5432` and
`match_limit: 12`. Both establish the same requested prefix facts and count.
Their source read scopes differ explicitly: to EOF versus an input limit.
Neither scope establishes whole-network completeness.

DNS focuses the nine-field baseline on five requested fields and the error-response
filter. DHCP selects four required fields from the nine-field baseline; all four
records are still read. The discovery arm adds one narrow installed-field probe
before the focused request. It tests the cost of validating an already specified
field, rather than proving a benefit for a previously unknown field or guessing
that an installed registration appears in traffic.

| Question          | Baseline reply bytes | Focused reply bytes | Focused change | Discovery + focused bytes | Discovery change |
| ----------------- | -------------------: | ------------------: | -------------: | ------------------------: | ---------------: |
| PostgreSQL prefix |               23,054 |              13,304 |        −42.29% |                    21,096 |           −8.49% |
| DNS errors        |               29,002 |              13,424 |        −53.71% |                    21,226 |          −26.81% |
| DHCP sequence     |               13,770 |              12,020 |        −12.71% |                    19,840 |          +44.08% |

Both repetitions produce the same reply size in each cell and pass the independent
fact comparison. Authentication uses the selected runtime's `parseEvidence` and
named input/output schemas, checking operation, normalized caller choices,
artifact or executable identity, original frame order and omission semantics.

| Question          | Baseline tool-call time, ms | Focused tool-call time, ms | Discovery + focused tool-call time, ms |
| ----------------- | --------------------------- | -------------------------- | -------------------------------------- |
| PostgreSQL prefix | 1,670 / 2,255               | 1,708 / 933                | 3,549 / 2,674                          |
| DNS errors        | 892 / 786                   | 889 / 778                  | 2,506 / 2,608                          |
| DHCP sequence     | 763 / 759                   | 755 / 731                  | 2,502 / 2,502                          |

Whole SDK workflow times, including connection/catalog, vary from 4.23–8.79 seconds
for these arms. The PostgreSQL focused tool time improves in one repetition and
regresses slightly in the other. Discovery consistently adds tool work. Two
repetitions are descriptive observations, not a statistical speed guarantee.

A separate first-page, next-page and repeated-first-page sequence costs
922 / 804 / 1,244 ms and returns 39,918 reply bytes in total. Each call repeats
dissection, reports the same 1,337 matching count and capture digest, and preserves
the original frame order. Identical repeated observations retain the same
content-addressed Evidence ID; distinct pages have distinct IDs. Page delivery
does not establish capture or network completeness. This narrow repeat does not
justify introducing a generic cache or weakening provider identity/cleanup rules.

The two original HTTP controls were also replayed with two SDK pairs each on the
new pinned runtime. Useful summary/prefix facts remain equivalent. For `http.cap`,
complete delivery returns 7,601 bytes and summary plus a two-URI retained page
17,540 bytes (+130.76%); for `http_redirects.pcapng`, 7,535 versus 17,240 bytes
(+128.80%). These remain negative controls. The original model observations in
[the earlier checkpoint](pcap-small-captures.md) keep their original runtime pin.

## Actual Codex CLI observations

Six actual Codex CLI 0.161.0 runs use requested alias `gpt-5.6-terra`, reasoning
`high`, a disposable configuration and the pinned REA MCP runtime. Resolved
server-side model identity is not inferred. Both tool names are enabled in every
arm, exact-name discovery guidance is identical, shell/browser/other-agent tools
are disabled and copied authentication is removed after each run.
The shared question and generated plans contain no oracle answers.

Order is baseline 1, focused 1, discovery 1, focused 2, baseline 2, discovery 2.
The rubric checks authenticated actual tool results, exact header-derived facts,
citations and the planned calls. Answer correctness and adherence to the plan
are reported separately. Limitation wording is reviewed in transcripts; a string
or string array is accepted because the prompt does not require one representation.

| Trial       | Total input tokens | Cached input tokens | Output tokens | Elapsed seconds | Actual MCP calls | Facts / plan                       |
| ----------- | -----------------: | ------------------: | ------------: | --------------: | ---------------: | ---------------------------------- |
| Baseline 1  |             40,649 |              27,904 |         1,574 |          27.989 |                1 | pass / pass                        |
| Focused 1   |             36,642 |              19,968 |           943 |          38.542 |                1 | pass / pass                        |
| Discovery 1 |             52,802 |              33,024 |         1,089 |          44.398 |                2 | pass / pass                        |
| Focused 2   |             40,912 |              22,016 |           726 |          32.520 |                1 | pass / pass                        |
| Baseline 2  |             40,181 |              19,968 |           896 |          40.299 |                1 | pass / pass                        |
| Discovery 2 |             48,754 |              30,976 |         1,780 |          76.081 |                1 | pass / **fail: discovery omitted** |

The two eligible baseline/focused pairs show total-input changes of −9.86% and
+1.82%, and elapsed changes of +37.70% and −19.30%. Thus reduced SDK reply size
does not establish a stable total-token or speed improvement in these runs.
The first complete discovery comparison adds 29.90% input and 58.63% elapsed time.
The second discovery attempt is retained as a workflow failure and cannot serve
as a successful two-call discovery comparison. Its cost is not discarded or
counted as a passing trial. No model-side recovery or retries occurred in these
six attempts.

An earlier configuration preflight rejected the packet tool under Codex's
`approval_policy: never`: 36,651 input tokens, 549 output tokens, 21.603 seconds,
one rejected call and no packet observations. The experiment runner now explicitly
preapproves the two authorized passive packet tools, consistently across all arms.
That failed preflight remains separate from the corrected cohort and its cost is
reported here; CLI exit zero alone is never a factual or workflow pass.

## Resource and compatibility scope

All engine/model workloads use an owned Linux resource scope with one CPU,
3 GiB early-stop threshold, 4 GiB hard memory ceiling, no swap and a 192-task cap.
Node's heap is additionally limited to 512 MiB. The nineteen non-HTTP SDK trials
have a maximum observed payload-exit memory peak of 860,909,568 bytes; the six model
attempts peak at 940,806,144 bytes. Payload-exit counters and cleanup were verified
with the observer still alive and report no memory-limit/OOM events in that phase.
Final whole-scope counters remain unavailable, so no stronger whole-scope claim
is made. CPU usage and observed process ownership remain in each private receipt.

A full PostgreSQL probe with four selected fields and no input prefix exceeds the
existing 4 MiB producer-output ceiling even with the default fifty-row window.
It correctly fails instead of delivering partial success. The SDK error retains
large truncated diagnostics (5,790,979 serialized bytes); this separate product
concern is recorded privately for later repair, outside #3130. Paging alone cannot
prevent producer expansion. The successful prefix experiment does not prove that
the full recording can be inspected with those selections.

Only experiment sources, corpus provenance, a question template and guidance
change. Production schemas, provider limits, CLI/MCP defaults, Evidence identity
and session/resource ownership stay as before. Eight parser regressions retain
malformed/truncated-input and omission checks. Existing clients need no migration.

## Reproduction

Acquire the exact corpus outside the repository and verify the pinned hashes.
Use the pinned Node/npm toolchain, locked dependencies, `npm run build:cached` and
an external resource guard before invoking actual engines/models. Supply explicit
provider settings in a private JSON file. An example SDK arm is:

```sh
node experiments/analysis-efficiency/measure.mjs \
  --runtime-root /absolute/pinned/runtime --revision PINNED_SHA \
  --artifact wireshark-pgsql-jdbc.pcap --path /private/pgsql-jdbc.pcap \
  --providers /private/providers.json --schemas selected \
  --packet-selection focused --output /private/new-trial
```

Use `baseline`, `focused`, `discovery`, or the PostgreSQL-only `pages` diagnostic.
Run `packet-oracle.py postgres PATH` independently and compare `answer.json` facts.
Generate each model prompt with `packet-model-prompt.mjs --selection ARM`, then use
the existing `agent-trial.py` with those two enabled tools and context capture.
Run `review-packet.mjs` against the actual trial, oracle, runtime and selected arm.
Its nonzero exit includes a plan failure even when all requested facts are correct.
Retain failed attempts, actual usage, digests, coverage, cleanup and resource
receipts alongside passing observations. No raw results need to be committed.

## Review verification

The comparator now recognizes the three non-HTTP questions: observations remain
attached to each run, while different plans compare requested facts. Repeated
identical plans still compare stable observation scope. Capture grading authenticates
Evidence against the actual call and assesses plan differences separately; an
actual 24-row SDK window replay retains a factual pass and a plan failure. This
is a grading replay, not an additional model trial. The stricter header oracle
preserves all original sample facts and rejects truncated IPv4/TCP options and
unsupported Ethernet protocols. The page diagnostic now derives matches 13–24
independently before accepting the second page; skipped, reversed and changed-byte
pages are rejected. Original cohort measurements retain their recorded source
digests and runtime pin; review checks do not relabel them.

Capture grading keeps authenticated facts by Evidence ID and evaluates the cited
observations. Four replays using actual first-page and second-page SDK Evidence
verify that later or reordered pages and repeated reads preserve a correct cited
answer, while citing only the wrong page fails factual grading. Extra calls still
fail the fixed workflow plan. Regrading all six original model records preserves
their outcomes and recorded costs; these replays are not new model trials.

Failed or malformed calls remain workflow failures and never become authenticated
Evidence. Nine failure-injection and answer-shape replays using an actual successful
capture verify that later recovery preserves supported facts, while failed-only
attempts and missing or unobserved citations fail factual grading. Missing
limitations and extra answer keys fail the fixed plan without changing correct
recorded facts. Successful original-model outcomes remain unchanged.
