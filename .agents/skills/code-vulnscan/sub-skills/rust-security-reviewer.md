# rust-security-reviewer

Read this when a repository contains Rust services, HTTP handlers, RPC endpoints, message consumers, background workers, native extensions, or unsafe/FFI code. Apply the web checks to Actix Web, Axum, Warp, and Rocket, and apply the ownership/unsafe checks to every Rust target.

## Goal

Find reachable Rust application vulnerabilities that API-name matching misses: extractor-to-sink flows, incomplete route authorization, unsafe raw SQL, command argument abuse, SSRF validation gaps, filesystem escape, unescaped HTML or dynamic templates, unbounded deserialization, async denial of service, and violated `unsafe` invariants.

## Framework and attack-surface map

Inventory the effective routes and middleware before tracing findings.

| Stack | Entry points and security signals |
|---|---|
| Actix Web | `App::route`, `web::resource`, `#[get]`/`#[post]`, `web::Query`, `web::Path`, `web::Json`, `web::Form`, `HttpRequest`, `Payload`, `Transform`, `Service`, `wrap`/`wrap_fn` |
| Axum | `Router::route`, `nest`, `merge`, `fallback`, `Query`, `Path`, `Json`, `Form`, `Multipart`, `State`, `Extension`, `FromRequest`, `FromRequestParts`, `route_layer`, `layer`, Tower middleware |
| Warp | `path`, `path!`, `query`, `body`, `header`, `cookie`, `and`, `or`, `map`, `and_then`, `recover`, `with`, rejection handlers |
| Rocket | `#[get]`/`#[post]` and other route attributes, `mount`, rank/format guards, path/query parameters, `Form`, `Json`, `Data`, `TempFile`, request guards, fairings, catchers |
| RPC and messaging | Tonic services/interceptors, GraphQL resolvers, WebSockets, queue consumers, cron jobs, file imports, webhook workers, admin CLIs |

Also inspect `Cargo.toml`, `Cargo.lock`, workspace features, `build.rs`, `.cargo/config*`, framework configuration, template directories, migrations, TLS settings, container/runtime configuration, and feature-gated code. Cargo features and target-specific dependencies change the compiled attack surface.

## Required review sequence

1. Enumerate every HTTP, RPC, WebSocket, message, scheduled, import, and administrative entry point.
2. Map the effective middleware, request guards, authentication, authorization, body limits, and timeouts for every route branch.
3. Treat extractors, headers, cookies, route/query parameters, bodies, uploads, claims, queue payloads, stored integration data, and environment-controlled job inputs as untrusted.
4. Trace values through destructuring, `into_inner`, clones, DTO/domain conversions, async tasks, channels, database calls, templates, HTTP clients, files, decoders, and `unsafe` boundaries.
5. Confirm a concrete source, reachable path, consequence, and missing Rust/framework-specific mitigation. A crate or dangerous API alone is only a candidate.

Run `python3 scripts/taint.py --file <rust-source-file> --lang rust --pretty` for a deterministic per-file first pass. Use `scripts/taint_rust.py` findings as trace leads; manually validate middleware, aliases, macros, trait dispatch, helper functions, and cross-file flows.

## Route authorization and middleware

- Build an endpoint-to-policy matrix including HTTP method, nested prefix, fallback, content type, route rank, and feature flag. Treat fallback handlers, static services, health/debug routes, WebSocket upgrades, and generated RPC methods as endpoints.
- In Actix and Axum, verify whether middleware is applied before or after `route`, `nest`, `merge`, `ServiceConfig`, and `route_layer`. A layer attached to one router branch does not protect a sibling merged later.
- In Warp, follow filter composition. `or` creates distinct branches; an authentication filter on one branch does not flow across another. Verify custom rejection recovery does not turn authorization failure into success.
- In Rocket, account for ranked routes, format guards, forwarding, catchers, and request guards. Confirm a lower-ranked unguarded route cannot handle requests rejected or forwarded by the intended guarded route.
- Verify authorization after authentication: object ownership, tenant scope, organization/project membership, role/scope semantics, administrative impersonation, and server-side state transition rules. A typed ID or UUID is not authorization.
- Check session cookies for `Secure`, `HttpOnly`, `SameSite`, rotation, fixation resistance, expiry, logout invalidation, and key secrecy. Validate JWT signature algorithm, issuer, audience, expiry, key selection, revocation expectations, and tenant binding.
- Require an exact trusted-origin CORS policy when credentials are enabled. Verify CSRF protection for cookie-authenticated state changes; JSON bodies and non-GET methods do not by themselves prevent CSRF.

## Extractors, parsing, and limits

- Trace all Actix `web::*`, Axum `FromRequest*`, Warp filters, and Rocket request guards. Custom extractors and guards are security boundaries; verify every rejection path fails closed and does not accept partially parsed state.
- Apply explicit limits before buffering bodies, multipart fields, uploads, decompression, JSON/YAML/MessagePack/Bincode input, and WebSocket messages. Framework defaults differ and may be overridden by nested routers or route-specific configuration.
- Bound collection length, string length, recursion/depth, decompressed bytes, multipart part count, archive expansion, database result size, pagination, and fan-out. A Rust parser can remain memory-safe while exhausting memory, CPU, disk, or tasks.
- Treat Serde validation as structural parsing, not authorization or business validation. `deny_unknown_fields` can reduce ambiguity but does not prevent mass assignment into privileged fields.
- Use purpose-specific input DTOs and explicit mapping. Check attacker control of `id`, `tenant_id`, `owner_id`, roles, status, price, balance, approval state, feature flags, and audit fields.

## Database and query construction

- Flag untrusted data incorporated into SQL passed to SQLx `query`/`query_as`/`query_scalar`/`raw_sql`, Diesel `sql_query`, `tokio-postgres`, `postgres`, SeaORM raw statements, or driver `execute`/`batch_execute` APIs.
- Treat `format!`, concatenation, captured interpolation, and dynamically selected identifiers, sort expressions, clauses, or operators as query structure. Bind values and map structural choices through exact allowlisted enums.
- Recognize safe SQLx `.bind(...)`, query macros with compile-time SQL, Diesel's typed query builder, `bind`, and driver parameter arrays only when the SQL structure remains fixed. Binding cannot parameterize identifiers or keywords.
- Verify tenant and ownership predicates in raw SQL, bulk update/delete, joins, subqueries, and conflict handlers. Check transaction boundaries and locking around balances, inventory, approvals, quotas, and one-time tokens.

## Commands and process execution

- Trace the executable passed to `std::process::Command::new`, `tokio::process::Command`, `duct`, shell wrappers, and FFI process APIs. Enforce an exact executable allowlist rather than accepting arbitrary paths or names.
- Treat `sh -c`, `bash -c`, `cmd /C`, PowerShell, and equivalent interpreters as command-injection sinks. Never interpolate untrusted strings into a shell program.
- With a fixed executable, assess argument/option injection and program-specific semantics. Use an end-of-options marker where supported, allowlist modes/options, validate paths independently, clear or constrain inherited environment, and avoid attacker-controlled working directories.
- Check resource limits, timeouts, output buffering, child cleanup, privilege, filesystem/network access, and whether error output leaks secrets.

## SSRF and outbound protocols

- Trace request-derived URLs into reqwest, hyper, `http::Request`, webhook clients, image/document fetchers, OAuth discovery, and redirect-following clients.
- Parse once with `url::Url`; allowlist scheme, normalized host, and port. Reject credentials, fragments where inappropriate, opaque or non-hierarchical forms, ambiguous Unicode/IDN names, forbidden IP literals, and non-HTTP schemes.
- Resolve and reject loopback, link-local, private, multicast, unspecified, Unix-socket, and cloud metadata destinations as appropriate. Bind the connection to the validated address to address DNS rebinding or time-of-check/time-of-use changes.
- Disable redirects or revalidate every redirect target. Bound redirects, connect/read timeouts, response bytes, decompression, and streaming duration. A host string allowlist alone does not cover DNS resolution or redirects.

## Files, uploads, and archives

- Resolve an untrusted path against an absolute trusted base, canonicalize existing components, and enforce `candidate.starts_with(base)` as path components. Define behavior for non-existent targets and symlinks; string-prefix checks and lexical `PathBuf::join` are insufficient.
- Prevent symlink and race escapes when attackers can modify the filesystem. Prefer directory-relative or capability-based APIs such as `cap-std` where the threat model requires a strong boundary.
- For uploads, generate storage names, validate size while streaming, restrict content where necessary, store outside executable/static roots, set safe permissions, and authorize download/delete operations.
- For ZIP/TAR and other archives, validate each resolved entry, links, absolute paths, Windows prefixes, duplicate names, nested archives, entry count, expanded size, and compression ratio before extraction.

## Redirects, headers, HTML, and templates

- Allowlist normalized local redirect destinations. Check Actix `Location` headers, Axum/Rocket `Redirect`, framework helpers, OAuth return URLs, and login `next` parameters.
- Use checked `HeaderName`/`HeaderValue` constructors. Flag unchecked constructors or FFI/raw HTTP writers that can admit CR/LF, invalid bytes, or conflicting security headers.
- Treat Axum `Html`, Rocket `RawHtml`, Actix `text/html` bodies, Askama `safe`, Tera `safe`, Handlebars raw expressions, `Markup`/`PreEscaped`, and similar wrappers as explicit escaping boundaries. Encode for the actual HTML attribute, URL, JavaScript, CSS, or text context.
- Keep template source trusted. Flag untrusted strings passed to Tera `one_off`/`add_raw_template`, Handlebars `register_template_string`, MiniJinja `add_template`/`render_str`, or other runtime compilation APIs. Inserting untrusted values into a trusted auto-escaped template is not SSTI.
- Set CSP and other response headers centrally, but verify middleware covers error, redirect, static, streaming, and WebSocket handshake responses.

## Deserialization and parser safety

- Trace untrusted bytes to Bincode, Postcard, MessagePack, YAML, RON, Ciborium, custom Serde visitors, `typetag`, erased/dynamic types, and application-defined binary parsers.
- Unlike Java native serialization, Serde does not imply a gadget chain. Confirm the concrete risk: unbounded allocation/recursion, custom visitor side effects, type confusion in application logic, algorithmic complexity, panic/abort, or downstream unsafe code.
- Set total-byte, depth, collection, string, and object-count limits. For Bincode, apply `with_limit` to the exact options instance used for decoding. Verify transport body limits also cover compressed and streaming input.
- Avoid YAML features or custom tags that select behavior indirectly. Validate enums and discriminators against the caller's authorization and expected protocol state.

## Async, concurrency, and denial of service

- Do not perform blocking filesystem, DNS, database, crypto, compression, process, or CPU-heavy work on Tokio/Actix async workers. Use appropriate async APIs or a bounded blocking pool.
- Bound spawned tasks, channels, semaphores, connection pools, retries, backoff, request concurrency, streams, and fan-out. Detached `tokio::spawn` calls can outlive requests and amplify attacker work.
- Propagate authenticated identity, tenant, trace context, deadlines, and cancellation explicitly into tasks and messages. Verify cleanup on timeout, dropped futures, cancellation, panic, and partial writes.
- Review lock ordering and avoid holding synchronous or async mutex guards across `.await`. Check duplicate requests, races, replay, idempotency, and atomicity of state transitions.
- Treat `panic!`, indexing, `unwrap`, and `expect` as availability candidates only when attacker-reachable and not isolated by a fail-safe process boundary. Their presence alone is not a vulnerability.

## Unsafe Rust, FFI, and supply chain

- Inventory every `unsafe` block/function/trait implementation and `extern` boundary. Write down and verify the safety invariant at each call site: pointer provenance, alignment, validity, initialization, aliasing, lifetime, thread safety, layout, allocator ownership, unwind behavior, and integer bounds.
- Trace untrusted lengths, offsets, counts, tags, pointers, and foreign buffers into `from_raw_parts`, `set_len`, unchecked indexing, pointer arithmetic/copies, transmute, and ownership-reclaiming `from_raw` functions.
- Verify C strings are NUL-terminated, foreign output lengths are bounded, callbacks cannot outlive captured state, panics do not unwind through an incompatible ABI, and foreign threads obey synchronization requirements.
- Audit `build.rs`, proc macros, native/system dependencies, git/path dependencies, Cargo features, yanked/advisory status, lockfile use, source replacement, and release reproducibility. Build scripts and proc macros execute during compilation.
- Do not report an advisory solely from a crate name/version. Confirm the vulnerable feature, target, API, and reachable application path.

## Evidence and false-positive requirements

For each reported finding, provide:

1. The framework entry point and attacker-controlled extractor/value.
2. The complete data path, including destructuring, helpers, async/channel hops, and trait or macro expansion when relevant.
3. The exact sink or security property violated.
4. The missing or bypassed Rust/framework mitigation.
5. The runtime configuration and deployment conditions required for impact.

Reject these common non-findings before reporting:

- Fixed SQL with `.bind`, a driver parameter array, or Diesel typed expressions is not SQL injection.
- A fixed executable with constrained arguments is not shell injection; still assess option and program semantics.
- URL parsing alone does not stop SSRF, but an exact destination policy plus resolution and redirect controls may.
- `PathBuf::join` or `canonicalize` alone is not containment; canonicalization plus an enforced trusted-base boundary may be.
- Checked `HeaderValue::from_str` rejects invalid header bytes; unchecked constructors do not.
- Trusted auto-escaped templates with untrusted context values are not SSTI.
- Serde use alone is not unsafe deserialization, and `unsafe` use alone is not a proven memory-safety defect.
- `unwrap` or `expect` alone is not a security issue without attacker reachability and meaningful availability impact.

Pass all candidates through `false-positive-filter.md` before reporting.
