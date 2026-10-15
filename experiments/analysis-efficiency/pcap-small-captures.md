# Small real PCAP recordings: keep complete delivery

Continues [#2016](https://github.com/morluto/rea/issues/2016) after the QGIS
SQLite round. Measured main is pinned to
`3ae826ceba6f25b08bce50bcb51001209bc16b57`, with 23 intervening commits.
These include bounded PCAP summaries/pages, authenticated artifact subjects,
unknown-snapshot reuse and shared transcript grading. This round measures existing
PCAP delivery choices; it adds no production, API, default, cache or skill change.

## Corpus and question

Use two unmodified recordings published on the official
[Wireshark sample-capture page](https://wiki.wireshark.org/SampleCaptures):

| Recording                               |  Bytes | SHA-256                                                            |
| --------------------------------------- | -----: | ------------------------------------------------------------------ |
| HTTP request/response, `http.cap`       | 25,803 | `25a72bdf10339f2c29916920c8b9501d294923108de8f29b19aba7cc001ab60d` |
| HTTP redirects, `http_redirects.pcapng` | 47,804 | `ff432a6b71d06cd20720f7763e584014edd0a43c3b55981c682d1b7640207abc` |

`corpus.json` preserves original/resolved URLs. Local digests pin downloaded
bytes; no independently published upstream digest or immutable source commit is
claimed. These are upstream saved application-protocol recordings, not generated
REA fixtures. Recorded clients and current deployments are unknown. No new
traffic is captured and no recorded target/URL is executed or fetched.

The question asks for complete returned identity/client/scalar metadata, every
observed count and source coverage, six retained inventory counts, explicit nulls,
diagnostic UTF-16 lengths, and the first two retained HTTP URIs in original order.
Preserve each used receipt's limitations and identity. Summary/page scope and
unknowns remain distinct from source coverage; exhaustion does not establish
network completeness. Other inventory lists and diagnostic text are unrequested.

Compare default `{path}` with existing `{path, detail: "summary"}` plus a retained
`http-uris` page, offset 0, limit 2. Ordinary selected-field
`inspect_packet_capture` remains a separate boundary, not a substitute claim
about complete inventories. `questions/pcap-http.txt` contains the fixed question.

## SDK measurements

Frozen dist/bridge file-table SHA-256:
`db050545e94dc305a48042e06df96ac6c64b21ee6c5c4707c787d5e46df79e47`.
Linux x64, Node 24.18.0, SDK client/server 2.3.1, installed Wireshark 4.0.17.
Explicit commands are `/usr/bin/tshark`, `/usr/bin/capinfos`, `/usr/bin/prlimit`;
private receipts retain executable hashes. Each workflow starts a fresh server
and uses actual named advertised definitions/schema validation. Host page caches
are not flushed. Both tools read the owned snapshot.

Eight trials run complete/summary/summary/complete per recording. Both pairs
match selected capture facts, URI prefixes, settings and original source bytes.
Each delivery's exact limitations, identities and coverage remain separately
recorded, rather than equating source coverage with page exhaustion.

| Trial                | Reply bytes | SDK seconds | Payload CPU seconds | Kernel peak bytes |
| -------------------- | ----------: | ----------: | ------------------: | ----------------: |
| HTTP complete-1      |       7,601 |       4.349 |               5.336 |       611,778,560 |
| HTTP summary-1       |      17,540 |       4.972 |               5.973 |       601,661,440 |
| HTTP summary-2       |      17,540 |       5.101 |               6.092 |       611,438,592 |
| HTTP complete-2      |       7,601 |       4.463 |               5.503 |       617,148,416 |
| Redirects complete-1 |       7,535 |       4.670 |               5.641 |       610,627,584 |
| Redirects summary-1  |      17,240 |       5.099 |               6.104 |       615,522,304 |
| Redirects summary-2  |      17,240 |       5.060 |               6.056 |       610,385,920 |
| Redirects complete-2 |       7,535 |       4.466 |               5.458 |       608,141,312 |

Bytes are compact client-result JSON summed over one complete or two summary/page
calls, not model tokens or raw wire bytes. Summary/page expands replies to more
than twice the complete result on both recordings. All four SDK pairs are slower
and use more payload CPU; memory differences are small/inconsistent. CPU includes
driver/catalog work outside the SDK workflow timer.

Reproduce with `measure.mjs --artifact wireshark-http.cap` or
`wireshark-http_redirects.pcapng`, pinned path/runtime/revision, explicit provider
JSON, `--schemas selected`, and `--delivery complete|summary`. Use `compare.mjs`
on completed output directories. Original replies, catalogs, comparison receipts
and exact measured driver source stay private. Repeated deliveries in the same
mode also compare the ordered receipt observations, including limitations, view
parameters, coverage and unknowns; only receipt/parent IDs are invocation-specific.
Comparator regressions run with `npm run test:local -- tests/evaluation/analysisEfficiencyComparison.test.ts`
using synthetic measurement directories; they do not establish provider behavior.

## Actual model tasks

Four actual Codex CLI 0.161.0 tasks use requested `gpt-5.6-terra` high, the same
redirects question/runtime/artifact/provider settings, direct mode, two exact
enabled tools and equal context/discovery capture flags. The requested alias is
not verified server-resolved model identity. Equal cohort instructions select
complete or summary plus one URI page. The experiment driver applies its existing
private per-tool approval policy to `inspect_pcap_capture`; global configuration
and REA authority are unchanged.

| Trial      |  Input | Cached | Uncached | Output | CLI wall seconds | MCP calls | Facts |
| ---------- | -----: | -----: | -------: | -----: | ---------------: | --------: | ----- |
| complete-1 | 38,947 |  9,984 |   28,963 |  2,119 |           69.469 |         1 | pass  |
| summary-1  | 58,779 | 38,144 |   20,635 |  3,241 |          141.304 |         2 | pass  |
| summary-2  | 58,584 | 38,144 |   20,440 |  4,261 |           50.916 |         2 | pass  |
| complete-2 | 38,917 | 23,040 |   15,877 |  2,813 |          106.896 |         1 | pass  |

Summary/page total input **increases 50.92% / 50.54%** and output increases
52.95% / 51.48%. Uncached input is mixed: 28.75% lower / 28.74% higher. Time is
mixed: 103.41% slower / 52.37% faster. No cause is inferred for caching or timing
variation. Cached input is included in total; each CLI reports one final aggregate
usage. Output includes 1,149 / 1,162 / 2,196 / 1,837 reasoning tokens.

All calls succeed without extras/retries. Events contain only the selected MCP
tools and agent messages. All source-digest and private-profile cleanup checks
pass. Model payload CPU seconds/kernel peaks: 7.818/791,060,480;
9.793/752,705,536; 7.685/757,891,072; 7.999/750,993,408. These do not establish
a general CPU/memory gain.

The first summary initially fails the grader because it uses explicit equivalent
labels and a URI object retaining page/source coverage. Its facts are correct.
The grading boundary accepts these known forms while checking exact types,
null presence, original limitations and extra scopes against actual receipts.
Conflicting duplicates and unsupported claims remain failures. Each cited
receipt's own ID must be reported; its parent lookup ID is checked separately.
Original answers/reviews/grader source remain intact. No model is rerun. A grader
review pause separates the pairs; it is not task time or a cold-cache claim.

## Verification and decision

An independent stdlib raw PCAP/PCAPNG/Ethernet/IP/TCP/complete-HTTP-header parser
agrees on 43/271 packets, per-packet endpoint counts, first URI prefixes and 2/23
distinct HTTP URIs. It invokes no Wireshark. DNS associations, protocol-stack
dissection, nullable timestamps and live-network semantics are not independently
validated.

Both real CLI complete results match full MCP normalized results, subjects,
parameters, IDs and limitations. Portable CLI summary/URI views match MCP retained
normalized facts and subjects; source forms/caller parameters remain distinct.
Source bytes stay unchanged. Thirty-four context/grading regressions pass, including
cited complete metadata/counts/UTF-16 diagnostics and exact ordered response ID
lists that reject parent lookups, duplicates and nested representations. URI
prefix coverage must come from its cited page, even if an uncited page has the
same items. The SDK driver also checks the returned view against the exact
requested kind, facet, offset and limit. Five real-answer
mutations—omitted null, false page exhaustion, contradictory source scope,
unsupported absence claim and non-string receipt identity—fail correctly.
Malformed identities produce failed facts rather than crashing the grader.
JS syntax, Python compilation and
relevant standard lint pass.

A fresh real SDK summary/URI smoke matches the original selected facts. Three
private consumer fault injections alter the returned view's offset, limit or
presence after a real SDK reply; the driver rejects each. These establish the
experiment consumer's guard, not provider malformed-reply behavior. The initial
injection setup loaded the separate CommonJS client and did not inject a fault;
that discarded setup attempt remains private alongside the corrected ESM runs.
Original measured driver sources, token totals and timing data remain unchanged.

The driver also requires a distinct Evidence receipt for the retained URI page.
A private SDK consumer injection reuses the summary's response ID after a real
MCP reply: the preceding driver accepts it, the corrected driver rejects it
without writing an answer, and an unmodified real reply still passes. This
checks receipt uniqueness before recording observations; it does not establish
that a provider actually returned duplicate IDs.

The page guard checks the complete expected coverage object, including status,
continuation and exhaustion. Private actual-reply injections demonstrate that
the preceding driver accepts inconsistent coverage, while the corrected driver
rejects wrong status, next offset or exhaustion. Unmodified exhausted and
continuable URI pages still pass. The grader also requires each cited receipt's
subject digest and local path to identify the reference capture, and uses the
reference page's verified coverage. Thirty-four grading/context regressions pass,
including missing or malformed subjects and faithful but inconsistent coverage;
all four original model answers still pass factual regrading. Strict resource
grades remain false where terminal whole-scope counters are unknown.

PCAP observation production now validates both the Evidence subject and
normalized target against the selected path/digest for complete, summary and
page replies. Retained parents must be declared in each view receipt's Evidence
links and differ from that response's own ID. The grader enforces the same link
relationship. Private actual-reply injections and normal complete/summary
controls exercise this boundary; these do not establish a provider defect.

The grader preserves each receipt's producing tool while indexing it; conflicting
tool/envelope ownership for one ID remains ambiguous, while identical repeated
receipts are allowed. Complete delivery requires the capture tool/operation.
Summary delivery uses the capture tool but correctly delegates its Evidence
operation to `inspect_analysis_view`; the URI page uses that view tool/operation.
Both the grader and SDK observation producer validate this actual contract.
Wrong-tool/operation regressions fail before the correction and pass afterward;
private SDK operation faults are rejected while real complete/summary controls
and all four stored model factual grades still pass. No operation is rewritten
to make the tool name and delegated Evidence operation identical.

The receipt index parses the required envelope/nested-view containers before
allowing lookup, so missing or malformed normalized results/limitations become
failed facts with a written report. Empty observation lists also remain failed
facts and never enter citation checks that require a first receipt. Coverage uses type-sensitive JSON comparison
to distinguish booleans, integers and floats. Receipt-identity conflict checks
use the same type-sensitive rule, so a scalar type change cannot hide in a
repeated ID. Existing PCAP scope-alias checks already preserve JSON types.
Requested and cited URI views use the same type-sensitive JSON rule, rejecting
boolean or floating-point offsets/limits even when an answer faithfully copies
them. The observation producer rejects missing, null or malformed response IDs
before recording either capture or page receipts. Private real-reply injections
exercise these ID failures alongside normal complete/summary controls; they do
not establish malformed provider behavior.
Completed-call arguments stay with their producing tool and receipt in the
grader's identity index. Cited envelope parameters and actual call arguments
must match the selected path or retained parent/view, including delegated
summary parameters. The observation producer validates both summary and URI
views and envelope parameters at their common boundary. Private real-reply
faults reproduce missing-parameter/summary-view acceptance before the fix and
are rejected afterward; normal complete/summary controls still pass.
Negative regressions reproduce
prior crashes and false passes; all original real-model factual grades still
pass without model reruns. The SDK workflow is unchanged by these grader fixes.

**Decision: keep existing complete defaults; add no production optimization.**
For these compact recordings and this question, summary/page costs more total
input in both real-model pairs. No stable speed or CPU/memory benefit justifies
another API, automatic delivery switch, cache or plugin layer. Existing pages
remain available; their benefit needs evidence for the actual question/inventory.
Large captures, other protocols, Windows/macOS/Bun Wireshark and other model
workloads remain unverified here.

Heavy work stays serial with one CPU, 3 GiB early stop/4 GiB hard memory and no
swap. Build kernel peak: 2,575,732,736 bytes. Payload cleanup and zero phase limit
events are verified; missing terminal whole-scope counters remain unknown, so
strict whole-resource grades stay false. No raw capture, trace, credential,
runtime or result JSON is committed. No unrelated REA product bug is identified
or fixed, and no release is performed.

Review follow-up binds the cited URI page to its exact requested facet/range,
reported values and the summary retained parent. Small synthetic trial receipts
exercise the entire grading entrypoint, including faithful but wrong-page/range/
parent citations, missing nulls, false scope and malformed identities. These are
grader regressions, not real-provider evidence. All four stored actual model
answers still pass; no model reruns are required. Transcript readers close their
owned file handles after grading.

The SDK driver and factual grader require summary coverage to describe its one
complete view and require each present normalized limitations/unknowns field to
be a string array. Missing fields and valid empty arrays remain distinct.
Controlled consumer mutations over actual SDK replies reproduce the previously
accepted inconsistent summary coverage and verify rejection after the guard;
complete and summary controls still pass. These mutations do not establish a
malformed-response defect in the provider. The four stored model answers still
pass factual regrading without another model run.

Summary views must preserve both the outer artifact path/digest and the nested
summary target, as well as the Evidence subject. The full grader rejects
faithful receipts with missing or incorrect outer artifact identities. Private
mutations over actual SDK replies reproduce the previous false success and
verify rejection after the shared observation guard; normal deliveries and all
four original model answers retain their recorded facts.

Declared retained parent digests must match the digest encoded in the linked
parent Evidence ID for both summary and page views. SDK acceptance and factual
grading reject mismatches and missing digests while preserving complete
deliveries. Before/after private actual-reply mutations verify both view roles;
unmodified deliveries and four stored original-model factual regrades pass.

The SDK observation boundary additionally authenticates each complete, summary
and page envelope with the selected runtime’s existing `parseEvidence` owner.
It preserves the original envelope, without duplicating semantic-ID hashing.
Format-valid swapped-ID mutations over actual SDK replies pass before this
guard and fail afterward; unmodified complete/summary controls pass. The model
grader tests selected facts against cited transcript receipts; its synthetic
fixtures do not establish Evidence authentication. The original real-model
receipts are independently authenticated against the pinned runtime.

The grader separates truthful cited facts from equivalence of the measured
workflow. PCAP workflow checks require the planned ordered capture call (complete)
or summary capture followed by the URI-page call, with exact arguments and
completed status. Extra, reversed, failed or undecodable attempts fail workflow
acceptance even when the final cited facts are correct; their actual cost and
errors remain recorded. All four original model trials pass both factual and
workflow checks without model reruns. Strict resource grades remain unchanged.

Each planned call must also decode as an Evidence object with its own cited
response ID. An unreadable planned reply cannot independently pass workflow
checks merely because tool names, arguments and terminal status match. The
regression reproduces the previous workflow-only false success; original model
factual/workflow grades remain unchanged.

Workflow citation cardinality must equal the planned call count before binding
per-call IDs. A shorter or longer answer list cannot silently shorten Python
zip’s expected plan; missing URI calls and extra citations are rejected.
Original complete/summary model workflows continue to pass unchanged.

The six comparator CLI regressions now live in the normally discovered Vitest
evaluation suite, so routine local/PR/CI gates execute them. The original six
scenarios and CLI assertions are retained; the former manual Node suite is
removed. They remain synthetic consumer checks, not provider evidence.

Failed calls with scalar/list replies or malformed nested resource-error
containers are parsed defensively. The grader writes its report, preserves the
original failure and any supported cited facts, and rejects workflow acceptance
instead of crashing. Genuine structured resource Evidence references remain
observable; no malformed producer behavior is inferred from synthetic cases.
